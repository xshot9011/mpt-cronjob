import { enterFrame, evalScript, humanizeMouse } from "./browser.js";
import { solveCaptchaOnPage } from "./captcha.js";
import { parseDuration, resolveValue } from "./resolve.js";
import { sleep, toBool } from "./util.js";

/** switch_path destination: the current page's scheme://host[:port] plus a new path. */
export function buildSwitchPathUrl(currentUrl, path = "") {
    const { protocol, host } = new URL(currentUrl);
    const normalized = path && !path.startsWith("/") ? `/${path}` : path;
    return `${protocol}//${host}${normalized}`;
}

// A script `get` may return any JSON-able value; the result is always a trimmed string.
function stringifyResult(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value).trim();
}

/**
 * Execute a list of actions sequentially. Returns one entry per `get` action:
 * { value, options, name? }, or null when that extraction failed.
 *
 * A failing click/fill/switch_path/solve_captcha stops the remaining actions
 * unless the action sets continue_on_failure.
 */
export async function executeActions(page, logger, actions, actionWait) {
    const extracted = [];

    for (const [i, action] of actions.entries()) {
        const step = i + 1;
        const type = action.type;
        const continueOnFailure = toBool(action.continue_on_failure);

        // Logs the failure; returns true when the run should carry on with the next action.
        const carryOn = (what, err) => {
            logger.error(`Step ${step}: ${what} failed: ${err?.message ?? err}`);
            if (!continueOnFailure) return false;
            logger.warning(`Step ${step}: Continuing despite ${what} failure (continue_on_failure=true).`);
            return true;
        };

        if (!type) {
            logger.error(`Action ${step}: Missing 'type'. Skipping.`);
            continue;
        }

        // ---- Actions that do not target an element ----
        if (type === "switch_path") {
            try {
                const destination = buildSwitchPathUrl(page.url(), action.path ?? "");
                logger.info(`Step ${step}: Switching path to '${destination}'...`);
                await page.goto(destination, { waitUntil: "domcontentloaded" });
                logger.info(`Step ${step}: Navigated to '${destination}'. Waiting ${actionWait}s...`);
                await sleep(actionWait);
                await humanizeMouse(page, 2);
            } catch (e) {
                if (carryOn("switch_path", e)) continue;
                return extracted;
            }
            continue;
        }

        if (type === "sleep") {
            let seconds;
            try {
                seconds = parseDuration(action.duration ?? 0);
            } catch (e) {
                logger.error(`Step ${step}: Invalid sleep duration '${action.duration}': ${e.message}. Skipping.`);
                continue;
            }
            logger.info(`Step ${step}: Sleeping for ${seconds}s...`);
            await sleep(seconds);
            logger.info(`Step ${step}: Sleep complete.`);
            continue;
        }

        if (type === "solve_captcha") {
            try {
                await solveCaptchaOnPage(page, action, logger, step);
                logger.info(`Step ${step}: CAPTCHA solved. Waiting ${actionWait}s...`);
                await sleep(actionWait);
            } catch (e) {
                if (carryOn("CAPTCHA solving", e)) continue;
                return extracted;
            }
            continue;
        }

        // ---- Actions that target an element ----
        const hasScript = action.script !== undefined && action.script !== null;
        const hasXpath = action.xpath !== undefined && action.xpath !== null;
        if ((type === "click" || type === "get") && !hasScript && !hasXpath) {
            logger.error(`Action ${step}: Missing 'xpath' or 'script' for action type '${type}'. Skipping.`);
            continue;
        }
        if (type === "fill" && !hasXpath) {
            logger.error(`Action ${step}: Missing 'xpath' for action type 'fill'. Skipping.`);
            continue;
        }

        if (type === "click") {
            const iframeTitle = action.iframe_title;
            logger.info(`Step ${step}: Clicking element${iframeTitle ? ` (inside iframe: ${iframeTitle})` : ""}...`);
            try {
                const scope = await enterFrame(page, iframeTitle, logger, step);

                if (action.script) {
                    logger.info(`Step ${step}: Executing click script: \`${action.script}\``);
                    await evalScript(scope, action.script);
                    await humanizeMouse(page, 3);
                } else {
                    const locator = scope.locator(`xpath=${action.xpath}`).first();
                    // Playwright auto-waits for the element to be actionable.
                    await locator.scrollIntoViewIfNeeded({ timeout: 15_000 });
                    await sleep(1); // let any scroll-triggered content settle
                    try {
                        await locator.click({ timeout: 15_000 });
                        await humanizeMouse(page, 2);
                    } catch {
                        logger.warning(`Step ${step}: Standard click failed, using Javascript fallback.`);
                        await locator.evaluate((el) => el.click());
                    }
                    logger.info(`Step ${step}: Click successful. Waiting ${actionWait}s...`);
                    await sleep(actionWait);
                }
            } catch (e) {
                if (carryOn("Click", e)) continue;
                return extracted;
            }
            continue;
        }

        if (type === "fill") {
            logger.info(`Step ${step}: Filling element...`);
            if (!action.value_from) {
                logger.error(`Step ${step}: Missing 'value_from' for fill action.`);
                continue;
            }

            const value = await resolveValue(action.value_from, logger);
            if (value === null || value === undefined) {
                logger.error(`Step ${step}: Failed to resolve 'value_from': ${action.value_from}`);
                continue;
            }

            try {
                const scope = await enterFrame(page, action.iframe_title, logger, step);
                const locator = scope.locator(`xpath=${action.xpath}`).first();
                await locator.scrollIntoViewIfNeeded({ timeout: 15_000 });
                await sleep(1);

                // fill() clears the field then types the value.
                await locator.fill(String(value));
                logger.info(`Step ${step}: Fill successful. Waiting ${actionWait}s...`);
                await humanizeMouse(page, 2);
                await sleep(actionWait);
            } catch (e) {
                if (carryOn("Fill", e)) continue;
                return extracted;
            }
            continue;
        }

        if (type === "get") {
            logger.info(`Step ${step}: Extracting value...`);

            let scope;
            try {
                scope = await enterFrame(page, action.iframe_title, logger, step);
            } catch (e) {
                logger.error(`Step ${step}: Could not enter iframe for get: ${e.message}`);
                extracted.push(null);
                continue;
            }

            try {
                let value;
                if (action.script) {
                    value = stringifyResult(await evalScript(scope, action.script));
                    logger.debug(`Step ${step}: Script extracted '${value}'`);
                } else {
                    // For attribute/text-node extraction use a `script` get instead;
                    // locators resolve to elements.
                    const locator = scope.locator(`xpath=${action.xpath}`).first();
                    value = ((await locator.textContent({ timeout: 15_000 })) ?? "").trim();
                    logger.debug(`Step ${step}: Extracted '${value}'`);
                }

                const item = { value, options: action.telegram_message_options ?? [] };
                if (action.name) item.name = action.name;
                extracted.push(item);
            } catch (e) {
                logger.error(action.script
                    ? `Step ${step}: Script execution failed: ${e.message}`
                    : `Step ${step}: No data found at XPath.`);
                extracted.push(null);
            }
            continue;
        }

        logger.warning(`Action ${step}: Unknown action type '${type}'. Skipping.`);
    }

    return extracted;
}
