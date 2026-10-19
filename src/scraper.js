import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeActions } from "./actions.js";
import { humanizeMouse, launchContext, newContext } from "./browser.js";
import { recordTurnstileCallbacks, wantsTurnstileCallback } from "./captcha.js";
import { passChallenge } from "./challenge.js";
import { getLogger } from "./logger.js";
import { isLambda, randomInt, sleep, targetName, toBool } from "./util.js";

const logger = getLogger("Scraper");

/** Allow `file://./login.html`-style URLs, resolved against the working directory. */
export function normalizeUrl(url) {
    const match = /^file:\/\/(\.{1,2}\/.*)$/.exec(url);
    return match ? pathToFileURL(path.resolve(match[1])).href : url;
}

/**
 * Open one target and run its actions. Returns { results, blocked }: results
 * are the extracted items as { name, value, options, target, field? } (target =
 * the target's name, field = the `get` action's name when it has one), and
 * blocked is true when a Cloudflare challenge never cleared, in which case no
 * action ran. Never throws.
 */
export async function scrapeTarget(page, name, url, actions, { waitTimeout, actionWait, challengeTimeout }) {
    const targetLogger = getLogger(name);
    let turnstileHook = null;
    try {
        // Only for this target, removed after it, so other targets' pages stay unpatched.
        if (wantsTurnstileCallback(actions)) turnstileHook = await page.addInitScript(recordTurnstileCallbacks);
        targetLogger.info(`Initiating extraction from ${url}`);
        const response = await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!(await passChallenge(page, response, challengeTimeout, targetLogger))) {
            targetLogger.error(`Blocked by a Cloudflare challenge that did not clear within ${challengeTimeout}s.`);
            return { results: [], blocked: true };
        }
        targetLogger.info("Page opened, performing initial random mouse movement...");
        await humanizeMouse(page, 2);

        // Scroll the page progressively to trigger lazy loading
        try {
            const totalHeight = Number(await page.evaluate(() => document.body.scrollHeight));
            for (let y = 1; y < totalHeight; y += 400) {
                await page.evaluate((top) => window.scrollTo(0, top), y);
                await sleep(0.1);
            }
            await page.evaluate(() => window.scrollTo(0, 0)); // Scroll back to top
        } catch (e) {
            targetLogger.warning(`Scrolling to trigger lazy loads failed: ${e.message}`);
        }

        // Wait for JS content to load
        await sleep(waitTimeout);

        if (!actions.some((a) => a.type === "get")) {
            targetLogger.warning("Invalid actions: Must contain at least one action of type 'get'.");
        }

        const results = (await executeActions(page, targetLogger, actions, actionWait, challengeTimeout))
            .filter((r) => r !== null);
        if (results.length === 0) {
            targetLogger.error(`Extraction failed: ${name}.`);
            return { results: [], blocked: false };
        }

        return {
            blocked: false,
            results: results.map(({ name: field, value, options }) => {
                if (field) {
                    targetLogger.info(`Extraction successful: ${name}. ${field}: ${value}`);
                    return { name: `${name} - ${field}`, value, options, target: name, field };
                }
                targetLogger.info(`Extraction successful: ${name}. Value: ${value}`);
                return { name, value, options, target: name };
            }),
        };
    } catch (e) {
        targetLogger.error(`An unexpected error occurred: ${e.message}`);
        return { results: [], blocked: false };
    } finally {
        await turnstileHook?.dispose().catch(() => {});
    }
}

/**
 * Open one browser session, run every target, and return the aggregated results.
 * Shared by both the local entrypoint (cli.js) and the Lambda handler.
 */
export async function runAll(config) {
    const targets = config.targets ?? [];
    const timing = {
        waitTimeout: Number(config.wait_timeout ?? 15),
        actionWait: Number(config.action_wait ?? 2),
        challengeTimeout: Number(config.challenge_timeout ?? 15),
    };
    const challengeRetries = Math.max(0, Math.floor(Number(config.challenge_retries ?? 1)) || 0);
    // Keeping the browser open is only useful for a visible browser on your own
    // machine; the process then stays alive until you press Ctrl+C.
    const keepOpen = toBool(config.keep_browser_open) && !toBool(config.headless, true) && !isLambda();
    const storageState = config.storage_state;

    const allResults = [];
    const launched = await launchContext(config, logger);
    const { browser } = launched;
    let { context } = launched;
    try {
        let page = await context.newPage();
        for (const target of targets) {
            const name = targetName(target);
            const actions = Array.isArray(target.actions) ? target.actions : [];
            if (!target.url || actions.length === 0) {
                logger.warning(`Skipping target '${name}': Missing URL or actions.`);
                continue;
            }
            for (let attempt = 1; ; attempt++) {
                const { results, blocked } = await scrapeTarget(page, name, target.url, actions, timing);
                allResults.push(...results);
                if (!blocked) break;
                if (attempt > challengeRetries) {
                    logger.error(`Giving up on '${name}': still blocked by Cloudflare after ${attempt} attempt(s).`);
                    break;
                }
                // Challenges are partly random: retry with fresh cookies after a pause.
                const pause = randomInt(2, 5);
                logger.info(`Retrying '${name}' in a fresh browser context in ${pause}s...`);
                await sleep(pause);
                await context.close().catch(() => {});
                context = await newContext(browser, config, logger);
                page = await context.newPage();
            }
        }
    } finally {
        // Persist cookies/session so the next run can reuse the login.
        if (storageState) {
            try {
                await context.storageState({ path: storageState });
                logger.info(`Saved browser session to ${storageState}`);
            } catch (e) {
                logger.warning(`Failed to save storage_state: ${e.message}`);
            }
        }
        if (keepOpen) {
            logger.info("Browser kept open as per configuration. Press Ctrl+C to exit.");
        } else {
            try {
                await browser.close();
                logger.info("Browser closed.");
            } catch (e) {
                logger.warning(`Failed to close browser: ${e.message}`);
            }
        }
    }

    return allResults;
}
