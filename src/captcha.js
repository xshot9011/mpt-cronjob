import { parseDuration, resolveValue } from "./resolve.js";
import { sleep, toBool } from "./util.js";

// ---------------------------------------------------------------------------- //
//                      CapSolver CAPTCHA solving integration                   //
// ---------------------------------------------------------------------------- //

const POLL_INTERVAL_SECONDS = 3;

// Maps the friendly `captcha_type` from config to the CapSolver proxy-less task
// type and the field in `solution` that holds the token.
export const CAPSOLVER_TASKS = {
    recaptcha_v2: { taskType: "ReCaptchaV2TaskProxyLess", solutionField: "gRecaptchaResponse" },
    recaptcha_v3: { taskType: "ReCaptchaV3TaskProxyLess", solutionField: "gRecaptchaResponse" },
    turnstile: { taskType: "AntiTurnstileTaskProxyLess", solutionField: "token" },
    hcaptcha: { taskType: "HCaptchaTaskProxyLess", solutionField: "gRecaptchaResponse" },
};

// Which response field(s) each CAPTCHA writes its token into.
const TOKEN_FIELDS = {
    recaptcha_v2: { fieldNames: ["g-recaptcha-response"], tag: "textarea" },
    recaptcha_v3: { fieldNames: ["g-recaptcha-response"], tag: "textarea" },
    hcaptcha: { fieldNames: ["h-captcha-response", "g-recaptcha-response"], tag: "textarea" },
    turnstile: { fieldNames: ["cf-turnstile-response"], tag: "input" },
};

// In-page functions that read the site key from the DOM when it is not in config.
// They are serialized into the page, so they must not reference outer variables.
const recaptchaSiteKey = () => {
    const el = document.querySelector(".g-recaptcha[data-sitekey], [data-sitekey]");
    if (el) return el.getAttribute("data-sitekey");
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    const match = iframe && iframe.src.match(/[?&]k=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
};

const SITEKEY_DETECTORS = {
    recaptcha_v2: recaptchaSiteKey,
    recaptcha_v3: recaptchaSiteKey,
    hcaptcha: () => {
        const el = document.querySelector(".h-captcha[data-sitekey], [data-sitekey]");
        if (el) return el.getAttribute("data-sitekey");
        const iframe = document.querySelector('iframe[src*="hcaptcha"]');
        const match = iframe && iframe.src.match(/[?&]sitekey=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    },
    turnstile: () => {
        const el = document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey]");
        return el ? el.getAttribute("data-sitekey") : null;
    },
};

// Writes the solved token into the response field(s) the page expects,
// creating the field if the widget never rendered it (common in headless).
function writeTokenIntoPage({ token, fieldNames, tag }) {
    for (const name of fieldNames) {
        let elements = [...document.querySelectorAll(`${tag}[name="${name}"], #${name}`)];
        if (elements.length === 0) {
            const el = document.createElement(tag);
            el.name = name;
            el.id = name;
            el.style.display = "block";
            document.body.appendChild(el);
            elements = [el];
        }
        for (const el of elements) {
            el.value = token;
            if (tag === "textarea") el.textContent = token;
        }
    }
    return true;
}

// Best-effort firing of a reCAPTCHA callback so pages relying on it proceed.
function fireRecaptchaCallback(token) {
    try {
        const cfg = window.___grecaptcha_cfg;
        if (!cfg || !cfg.clients) return false;
        let fired = false;
        for (const client of Object.values(cfg.clients)) {
            for (const level1 of Object.values(client)) {
                if (!level1 || typeof level1 !== "object") continue;
                for (const level2 of Object.values(level1)) {
                    if (level2 && typeof level2 === "object" && typeof level2.callback === "function") {
                        try {
                            level2.callback(token);
                            fired = true;
                        } catch {
                            // ignore a broken callback and keep looking
                        }
                    }
                }
            }
        }
        return fired;
    } catch {
        return false;
    }
}

async function capsolverPost(endpoint, payload) {
    const base = process.env.CAPSOLVER_API_BASE || "https://api.capsolver.com";
    const response = await fetch(`${base}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`CapSolver ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    if (data.errorId) {
        throw new Error(`CapSolver ${endpoint} failed: ${data.errorCode} - ${data.errorDescription}`);
    }
    if (!response.ok) throw new Error(`CapSolver ${endpoint} HTTP ${response.status}`);
    return data;
}

/** Submit a CAPTCHA to CapSolver and poll until the token is ready. */
async function requestToken({ apiKey, captchaType, websiteUrl, websiteKey, pageAction, timeout, logger }) {
    const { taskType, solutionField } = CAPSOLVER_TASKS[captchaType];

    const task = { type: taskType, websiteURL: websiteUrl, websiteKey };
    if (captchaType === "recaptcha_v3") {
        // pageAction must match the value the site uses; default to a common one.
        task.pageAction = pageAction || "verify";
    } else if (captchaType === "turnstile" && pageAction) {
        // Turnstile carries the action (and optional cdata) under metadata.
        task.metadata = { action: pageAction };
    }

    const created = await capsolverPost("createTask", { clientKey: apiKey, task });
    const taskId = created.taskId;
    if (!taskId) throw new Error("CapSolver createTask returned no taskId.");

    logger.info(`CapSolver task created (${taskId}); polling for result...`);
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_SECONDS);
        const result = await capsolverPost("getTaskResult", { clientKey: apiKey, taskId });
        if (result.status === "ready") {
            const token = result.solution?.[solutionField];
            if (!token) throw new Error(`CapSolver returned ready but no '${solutionField}' in solution.`);
            return token;
        }
        // status "processing" (or "idle") -> keep polling
        logger.debug(`CapSolver task ${taskId} status: ${result.status}`);
    }
    throw new Error(`CapSolver did not solve the CAPTCHA within ${timeout}s.`);
}

/**
 * The `solve_captcha` action: solve via CapSolver, then inject the token into
 * the page so a following submit `click` goes through. Throws on any failure.
 */
export async function solveCaptchaOnPage(page, action, logger, step) {
    const captchaType = String(action.captcha_type || "recaptcha_v2").toLowerCase();
    if (!CAPSOLVER_TASKS[captchaType]) {
        throw new Error(
            `Unsupported captcha_type '${captchaType}'. Expected one of ${Object.keys(CAPSOLVER_TASKS).join(", ")}.`,
        );
    }

    // API key: resolve via secret_manager[...]/string[...]/plain, else env var.
    const apiKey = action.api_key_from
        ? await resolveValue(action.api_key_from, logger)
        : process.env.CAPSOLVER_API_KEY;
    if (!apiKey) throw new Error("No CapSolver API key. Set 'api_key_from' or the CAPSOLVER_API_KEY env var.");

    const websiteUrl = action.website_url || page.url();
    let websiteKey = action.website_key;
    if (!websiteKey) {
        try {
            websiteKey = await page.evaluate(SITEKEY_DETECTORS[captchaType]);
        } catch (e) {
            logger.warning(`Step ${step}: Site key auto-detection failed: ${e.message}`);
        }
        if (!websiteKey) throw new Error("Could not determine site key. Provide 'website_key'.");
        logger.info(`Step ${step}: Auto-detected site key: ${websiteKey}`);
    }

    let timeout = 120;
    try {
        timeout = parseDuration(action.timeout ?? 120);
    } catch {
        timeout = 120;
    }

    logger.info(`Step ${step}: Solving ${captchaType} via CapSolver for ${websiteUrl}...`);
    const token = await requestToken({
        apiKey, captchaType, websiteUrl, websiteKey, pageAction: action.page_action, timeout, logger,
    });

    const { fieldNames, tag } = TOKEN_FIELDS[captchaType];
    await page.evaluate(writeTokenIntoPage, { token, fieldNames, tag });
    logger.info(`Injected CAPTCHA token into: ${fieldNames.join(", ")}`);

    if (toBool(action.invoke_callback) && captchaType.startsWith("recaptcha")) {
        try {
            const fired = await page.evaluate(fireRecaptchaCallback, token);
            logger.info(fired ? "reCAPTCHA callback fired." : "No reCAPTCHA callback found to fire.");
        } catch (e) {
            logger.warning(`reCAPTCHA callback invocation failed: ${e.message}`);
        }
    }
}
