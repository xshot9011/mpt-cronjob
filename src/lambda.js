import { loadConfig } from "./config.js";
import { apiKeyMatches, getHeader, isHttpEvent, parseJsonBody } from "./http.js";
import { getLogger } from "./logger.js";
import { resolveValue } from "./resolve.js";
import { runAll } from "./scraper.js";
import { setSecretsRegion } from "./secrets.js";
import { notifyTelegram } from "./telegram.js";

const logger = getLogger("Scraper");

const reply = (statusCode, body) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
});

/**
 * AWS Lambda entry point (handler: src/lambda.handler).
 *
 * Config comes from the CONFIG_JSON env var (priority) or CONFIG_FILE. The
 * handler serves two kinds of caller:
 *
 *  - Trusted invocations (EventBridge schedule, console, CLI): the event may
 *    carry `targets` (replaces the configured ones) and/or `only`.
 *  - HTTP requests (API Gateway, Function URL): must send the `x-api-key`
 *    header matching config `http_api_key`; the JSON body may only carry
 *    `only`, so callers can pick configured targets but never supply their
 *    own URLs, scripts or secret lookups. The scraped values are returned.
 *
 * `only` is a list of configured target names to run instead of all of them.
 */
export async function handler(event) {
    const http = isHttpEvent(event);
    try {
        const config = loadConfig(logger);
        if (!config) {
            return reply(500, {
                error: "Configuration not found. Please set CONFIG_JSON env var or provide a config file.",
            });
        }

        setSecretsRegion(config.region);

        let request = event ?? {};
        if (http) {
            // Fail closed: without a configured key, nothing is reachable over HTTP.
            const expectedKey = await resolveValue(config.http_api_key, logger);
            if (!expectedKey) {
                logger.error("HTTP request rejected: 'http_api_key' is not configured or could not be resolved.");
                return reply(503, { error: "HTTP access is not configured." });
            }
            if (!apiKeyMatches(getHeader(event, "x-api-key"), expectedKey)) {
                logger.warning("HTTP request rejected: missing or wrong x-api-key.");
                return reply(401, { error: "Unauthorized" });
            }
            try {
                request = parseJsonBody(event);
            } catch {
                return reply(400, { error: "Body must be a JSON object." });
            }
            if (request.targets !== undefined) {
                return reply(400, { error: "'targets' is not accepted over HTTP; send 'only' with configured target names." });
            }
        } else if (Array.isArray(request.targets) && request.targets.length > 0) {
            config.targets = request.targets;
        }

        if (request.only !== undefined) {
            const names = request.only;
            if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string")) {
                return reply(400, { error: "'only' must be a non-empty list of target names." });
            }
            const configured = Array.isArray(config.targets) ? config.targets : [];
            const unknown = names.filter((n) => !configured.some((t) => t.name === n));
            if (unknown.length > 0) return reply(400, { error: `Unknown target name(s): ${unknown.join(", ")}` });
            config.targets = configured.filter((t) => names.includes(t.name));
        }

        const targets = config.targets;
        if (!Array.isArray(targets) || targets.length === 0) {
            return reply(400, { error: "No targets configured." });
        }

        logger.info(`Starting Lambda scraping for ${targets.length} targets${http ? " (HTTP request)" : ""}.`);
        const results = await runAll(config);

        await notifyTelegram(config, results, logger);

        if (http) {
            return reply(200, { results: results.map(({ name, value }) => ({ name, value })) });
        }
        return reply(200, { message: "Scraping completed successfully.", results: results.length });
    } catch (e) {
        logger.error(`Lambda execution failed: ${e.message}`);
        // Internal details stay in the logs; HTTP callers only get a generic error.
        return reply(500, { error: http ? "Internal error." : e.message });
    }
}
