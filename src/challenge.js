import { humanizeMouse } from "./browser.js";
import { randomInt, sleep } from "./util.js";

// ---------------------------------------------------------------------------- //
//                  Cloudflare "Just a moment..." interstitial                  //
// ---------------------------------------------------------------------------- //

// In-page check for Cloudflare's challenge interstitial. Serialized into the
// page, so it must not reference outer variables. Only signals that are unique
// to the interstitial: normal Cloudflare pages also load /cdn-cgi/ scripts,
// and a site may embed a Turnstile widget in its own forms.
const onChallengePage = () => Boolean(
    window._cf_chl_opt
    || document.querySelector("#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running")
    || /^(just a moment|checking your browser)/i.test(document.title.trim()),
);

async function challengeShowing(page) {
    try {
        return await page.evaluate(onChallengePage);
    } catch {
        // The challenge navigates when it passes; the old page's context is gone.
        return true;
    }
}

/**
 * Wait for a Cloudflare challenge on `page` to clear by itself (the
 * non-interactive check usually passes within seconds when the browser looks
 * normal), moving the mouse meanwhile. `response` is the navigation's response,
 * whose `cf-mitigated: challenge` header flags the challenge. Returns true when
 * there was no challenge or it cleared, false when it is still up after
 * `timeout` seconds.
 */
export async function passChallenge(page, response, timeout, logger) {
    const flagged = response?.headers()["cf-mitigated"] === "challenge";
    if (!flagged && !(await challengeShowing(page))) return true;

    logger.warning(`Cloudflare challenge detected; waiting up to ${timeout}s for it to clear...`);
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
        await humanizeMouse(page, 1);
        if (!(await challengeShowing(page))) {
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            logger.info("Cloudflare challenge cleared.");
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------- //
//                    Turnstile widget in a site's own form                     //
// ---------------------------------------------------------------------------- //

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com/";
// Seconds the widget gets to pass by itself before the first click, and to
// react to a click before the next one.
const TURNSTILE_SETTLE_SECONDS = 2;
const TURNSTILE_RECLICK_SECONDS = 8;

// In-page check: a passed widget writes its token into this hidden input.
const turnstileToken = () => [...document.querySelectorAll('input[name="cf-turnstile-response"]')]
    .some((el) => el.value);

async function turnstilePassed(page) {
    try {
        return await page.evaluate(turnstileToken);
    } catch {
        return false; // mid-navigation
    }
}

/**
 * Where the widget's checkbox is: near its left edge, vertically centered.
 * The widget's iframe sits in a closed shadow root that selectors can't reach,
 * so it is found through Playwright's frame list. Null while it isn't shown.
 */
async function turnstileCheckbox(page) {
    const frame = page.frames().find((f) => f.url().startsWith(TURNSTILE_ORIGIN));
    if (!frame) return null;
    try {
        const element = await frame.frameElement();
        await element.scrollIntoViewIfNeeded();
        const box = await element.boundingBox();
        if (!box?.width || !box?.height) return null;
        return { x: box.x + 30 + randomInt(-3, 3), y: box.y + box.height / 2 + randomInt(-3, 3) };
    } catch {
        return null; // detached while re-rendering
    }
}

/**
 * The `click_turnstile` action: wait for the page's Cloudflare Turnstile widget
 * to pass, clicking its checkbox when it doesn't pass by itself. A click that
 * doesn't take is repeated. Throws when there is still no token after
 * `timeout` seconds.
 */
export async function passTurnstile(page, timeout, logger, step) {
    const deadline = Date.now() + timeout * 1000;
    let nextClick = Date.now() + TURNSTILE_SETTLE_SECONDS * 1000;
    while (Date.now() < deadline) {
        if (await turnstilePassed(page)) return;
        if (Date.now() >= nextClick) {
            const point = await turnstileCheckbox(page);
            if (point) {
                logger.info(`Step ${step}: Clicking the Turnstile checkbox...`);
                await page.mouse.move(point.x, point.y, { steps: randomInt(8, 15) });
                await page.mouse.click(point.x, point.y);
                nextClick = Date.now() + TURNSTILE_RECLICK_SECONDS * 1000;
            }
        }
        await sleep(0.5);
    }
    throw new Error(`Turnstile did not pass within ${timeout}s`);
}
