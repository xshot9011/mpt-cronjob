import fs from "node:fs";
import { chromium } from "playwright";
import { getLogger } from "./logger.js";
import { resolveValue } from "./resolve.js";
import { isLambda, randomInt, sleep, toBool } from "./util.js";

const logger = getLogger("Scraper");

// A realistic, recent desktop Chrome UA. Override via config "user_agent".
export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

// Init script injected into every page/frame before any site code runs.
// Stock Playwright leaks navigator.webdriver=true and an empty window.chrome;
// these patches smooth over the most obvious automation tells. (This is best
// effort only -- a datacenter/Lambda IP remains the dominant Cloudflare signal.)
const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;

/** Chromium launch flags. Lambda needs single-process/no-zygote to survive its
 * constrained process model; the rest reduce automation fingerprints. */
function buildLaunchArgs() {
    const args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1920,1080",
    ];
    if (isLambda()) args.push("--single-process", "--no-zygote", "--disable-dev-tools");
    return args;
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
    // Lambda has no display, so a visible browser is never possible there.
    const headless = isLambda() ? true : toBool(config.headless, true);
    const launchOptions = { headless, args: buildLaunchArgs() };
    if (isLambda()) {
        // Lambda's task dir is read-only; Chromium needs a writable HOME for its
        // profile/crashpad scratch space.
        launchOptions.env = { ...process.env, HOME: "/tmp" };
    }

    const proxy = await resolveProxy(config, targetLogger);
    if (proxy) {
        launchOptions.proxy = proxy;
        targetLogger.info(`Launching with proxy server ${proxy.server}`);
    }

    const browser = await chromium.launch(launchOptions);
    try {
        const contextOptions = {
            userAgent: config.user_agent || DEFAULT_USER_AGENT,
            viewport: config.viewport || DEFAULT_VIEWPORT,
            locale: config.locale || "en-US",
            timezoneId: config.timezone_id || "Asia/Bangkok",
        };
        // Reuse a saved login/session across runs so we are not doing a fresh
        // (suspicious) cold login every time. Path is also written back on teardown.
        if (config.storage_state && fs.existsSync(config.storage_state)) {
            targetLogger.info(`Restoring browser session from ${config.storage_state}`);
            contextOptions.storageState = config.storage_state;
        }

        const context = await browser.newContext(contextOptions);
        await context.addInitScript(STEALTH_INIT_SCRIPT);
        context.setDefaultTimeout(15_000);
        return { browser, context };
    } catch (e) {
        await browser.close();
        throw e;
    }
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
