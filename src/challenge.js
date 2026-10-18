import { humanizeMouse } from "./browser.js";

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
