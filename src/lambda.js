import { loadConfig } from "./config.js";
import { apiKeyMatches, getHeader, isHttpEvent, looksLikeHttpRequest, parseJsonBody } from "./http.js";
import { getLogger } from "./logger.js";
import { OutputError, selectOutputs, sendOutputs } from "./outputs.js";
import { resolveValue } from "./resolve.js";
import { runAll } from "./scraper.js";
import { setSecretsRegion } from "./secrets.js";
import { toBool } from "./util.js";

const logger = getLogger("Scraper");

const reply = (statusCode, body) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
});

/** Log why the invocation is refused, then reply with that error. */
function reject(statusCode, error) {
    logger.error(`Request rejected (${statusCode}): ${error}`);
    return reply(statusCode, { error });
}

/**
 * AWS Lambda entry point (handler: src/lambda.handler).
 *
 * Config comes from the CONFIG_JSON env var (priority) or CONFIG_FILE. The
 * handler serves two kinds of caller:
 *
 *  - Trusted invocations (EventBridge schedule, console, CLI): the event may
 *    carry `targets` (replaces the configured ones), `only` and `outputs`.
 *    `targets` is refused when config `http_api_key` is set, unless config
 *    `allow_event_targets` is true: an HTTP-facing function shouldn't run
 *    caller-supplied scripts if an integration ever delivers a request body
 *    as a plain event (API Gateway non-proxy mappings do).
 *  - HTTP requests (API Gateway, Function URL): must send the `x-api-key`
 *    header matching config `http_api_key`; the JSON body may only carry
 *    `only` and `outputs`, so callers can pick configured targets and outputs
 *    but never supply their own URLs, scripts, secret lookups or destinations.
 *    The scraped values are returned.
 *
 * `only` is a list of configured target names to run instead of all of them.
 * `outputs` is a list of configured output names to send the results to;
 * without it every configured output gets them, and [] sends nowhere.
 * Request-style events that are neither shape above are refused.
 * Every refused invocation is logged before it returns.
 */
export async function handler(event) {
    const http = isHttpEvent(event);
    try {
        if (!http && looksLikeHttpRequest(event)) {
            return reject(400, "Unsupported HTTP event: use an API Gateway proxy integration or a Lambda Function URL.");
        }

        const config = loadConfig(logger);
        if (!config) {
            return reject(500, "Configuration not found. Please set CONFIG_JSON env var or provide a config file.");
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
                return reject(400, "Body must be a JSON object.");
            }
            if (request.targets !== undefined) {
                return reject(400, "'targets' is not accepted over HTTP; send 'only' with configured target names.");
            }
        } else if (request.targets !== undefined && !toBool(config.allow_event_targets, !config.http_api_key)) {
            return reject(400, "'targets' in the event is disabled for this function (http_api_key is set or "
                + "allow_event_targets is false); send 'only' with configured target names.");
        } else if (Array.isArray(request.targets) && request.targets.length > 0) {
            config.targets = request.targets;
        }

        if (request.only !== undefined) {
            const names = request.only;
            if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string")) {
                return reject(400, "'only' must be a non-empty list of target names.");
            }
            const configured = Array.isArray(config.targets) ? config.targets : [];
            const unknown = names.filter((n) => !configured.some((t) => t.name === n));
            if (unknown.length > 0) return reject(400, `Unknown target name(s): ${unknown.join(", ")}`);
            config.targets = configured.filter((t) => names.includes(t.name));
        }

        let outputs;
        try {
            outputs = selectOutputs(config, request.outputs);
        } catch (e) {
            if (!(e instanceof OutputError)) throw e;
            if (e.statusCode === 400) return reject(400, e.message);
            logger.error(`Invalid output config: ${e.message}`);
            return reply(500, { error: http ? "Internal error." : e.message });
        }

        const targets = config.targets;
        if (!Array.isArray(targets) || targets.length === 0) {
            return reject(400, "No targets configured.");
        }

        const outputNames = outputs.map(([name]) => name).join(", ") || "none";
        logger.info(`Starting Lambda scraping for ${targets.length} targets${http ? " (HTTP request)" : ""}; outputs: ${outputNames}.`);
        const results = await runAll(config);

        await sendOutputs(outputs, results, logger);

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
