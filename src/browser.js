import fs from "node:fs";
import { chromium } from "playwright";
import { getLogger } from "./logger.js";
import { resolveValue } from "./resolve.js";
import { isLambda, randomInt, sleep, toBool } from "./util.js";

const logger = getLogger("Scraper");

export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

// No init script patches navigator: hand-rolled fakes (a plugins array of
// numbers, webdriver=undefined where real Chrome says false) are themselves
// bot tells. --disable-blink-features=AutomationControlled already reports
// navigator.webdriver=false the way a normal browser does.

/**
 * A headless browser's User-Agent with the "HeadlessChrome" token swapped for
 * "Chrome"; null when there is nothing to change. Everything else (platform,
 * version) stays the browser's own, so the UA agrees with navigator.platform
 * and the client hints.
 */
export function headfulUserAgent(userAgent) {
    return userAgent.includes("HeadlessChrome") ? userAgent.replaceAll("HeadlessChrome", "Chrome") : null;
}

/** The User-Agent to emulate: config `user_agent`, else the browser's own made headful. */
async function contextUserAgent(browser, config) {
    if (config.user_agent) return config.user_agent;
    const session = await browser.newBrowserCDPSession();
    try {
        const { userAgent } = await session.send("Browser.getVersion");
        return headfulUserAgent(userAgent);
    } finally {
        await session.detach().catch(() => {});
    }
}

/** Chromium launch flags. Lambda needs no-sandbox/single-process/no-zygote to
 * survive its constrained process model; the rest reduce automation fingerprints. */
function buildLaunchArgs() {
    const args = [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1920,1080",
    ];
    if (isLambda()) args.push("--no-sandbox", "--single-process", "--no-zygote", "--disable-dev-tools");
    return args;
}

/**
 * Playwright launch options (without the proxy). Locally the Chromium sandbox
 * stays on, since the scraper visits third-party sites on your own machine;
 * config `chromium_sandbox: false` turns it off where it can't start (some
 * Linux hosts). Lambda can't run the sandbox, so it is always off there.
 *
 * Headless runs use the full Chromium build ("new headless"). Playwright's
 * default for headless is the stripped-down chromium-headless-shell, which is
 * far easier to fingerprint; config `headless_shell: true` goes back to it.
 */
export function browserLaunchOptions(config) {
    const channel = toBool(config.headless_shell) ? {} : { channel: "chromium" };
    if (isLambda()) {
        // No display on Lambda, and its task dir is read-only: Chromium needs a
        // writable HOME for its profile/crashpad scratch space.
        return {
            ...channel, headless: true, chromiumSandbox: false, args: buildLaunchArgs(), env: { ...process.env, HOME: "/tmp" },
        };
    }
    return {
        ...channel,
        headless: toBool(config.headless, true),
        chromiumSandbox: toBool(config.chromium_sandbox, true),
        args: buildLaunchArgs(),
    };
}

/**
 * Optional residential proxy. Shape in config:
 *   "proxy": {
 *     "server": "http://host:port",
 *     "username": "secret_manager['x']['PROXY_USER']",  // resolved
 *     "password": "secret_manager['x']['PROXY_PASS']"
 *   }
 * Routing through a residential IP is the single biggest lever against
 * Cloudflare when running from an AWS/Lambda datacenter range.
 */
async function resolveProxy(config, targetLogger) {
    const proxyConfig = config.proxy;
    if (!proxyConfig?.server) return null;
    const proxy = { server: proxyConfig.server };
    if (proxyConfig.username) proxy.username = await resolveValue(proxyConfig.username, targetLogger);
    if (proxyConfig.password) proxy.password = await resolveValue(proxyConfig.password, targetLogger);
    return proxy;
}

/** Launch Chromium and return { browser, context }. The caller owns teardown. */
export async function launchContext(config, targetLogger = logger) {
    const launchOptions = browserLaunchOptions(config);

    const proxy = await resolveProxy(config, targetLogger);
    if (proxy) {
        launchOptions.proxy = proxy;
        targetLogger.info(`Launching with proxy server ${proxy.server}`);
    }

    const browser = await chromium.launch(launchOptions);
    try {
        const context = await newContext(browser, config, targetLogger);
        return { browser, context };
    } catch (e) {
        await browser.close();
        throw e;
    }
}

/** A new context (fresh cookies, apart from storage_state) on a launched browser. */
export async function newContext(browser, config, targetLogger = logger) {
    const contextOptions = {
        viewport: config.viewport || DEFAULT_VIEWPORT,
        locale: config.locale || "en-US",
        timezoneId: config.timezone_id || "Asia/Bangkok",
    };
    const userAgent = await contextUserAgent(browser, config);
    if (userAgent) contextOptions.userAgent = userAgent;
    // Reuse a saved login/session across runs so we are not doing a fresh
    // (suspicious) cold login every time. Path is also written back on teardown.
    if (config.storage_state && fs.existsSync(config.storage_state)) {
        targetLogger.info(`Restoring browser session from ${config.storage_state}`);
        contextOptions.storageState = config.storage_state;
    }

    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(15_000);
    return context;
}

/** Drift the mouse around to mimic human interaction. Best effort; never throws. */
export async function humanizeMouse(page, duration = 2, interval = 0.2) {
    try {
        const viewport = page.viewportSize() || DEFAULT_VIEWPORT;
        const width = Math.max(viewport.width - 1, 1);
        const height = Math.max(viewport.height - 1, 1);
        const endTime = Date.now() + duration * 1000;
        while (Date.now() < endTime) {
            await page.mouse.move(randomInt(0, width), randomInt(0, height), { steps: randomInt(2, 6) });
            await sleep(interval);
        }
    } catch (e) {
        logger.debug(`humanizeMouse error: ${e.message}`);
    }
}

/**
 * Run a user-supplied JS snippet against a Page or Frame. Snippets use
 * `return ...` to produce a value, and may also use `await`.
 *
 * The snippet is wrapped in an async IIFE and handed to Playwright as an
 * expression string.
 */
export function evalScript(scope, script) {
    return scope.evaluate(`(async () => {\n${script}\n})()`);
}

/**
 * Return the Frame for an <iframe title="..."> so locators/scripts run inside it.
 * Returns the page itself when no iframeTitle is given.
 */
export async function enterFrame(page, iframeTitle, targetLogger, step) {
    if (!iframeTitle) return page;
    const handle = await page.waitForSelector(`iframe[title=${JSON.stringify(iframeTitle)}]`, {
        timeout: 15_000,
        state: "attached",
    });
    const frame = await handle.contentFrame();
    if (!frame) throw new Error(`Could not enter iframe '${iframeTitle}'`);
    targetLogger.info(`Step ${step}: Entered iframe '${iframeTitle}'.`);
    return frame;
}
