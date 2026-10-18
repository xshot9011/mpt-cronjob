import { sendTelegram } from "./telegram.js";
import { targetName } from "./util.js";

/**
 * Output type -> sender(output, results, logger). A new destination type is
 * one more entry here; routing and validation don't change.
 */
export const SENDERS = { telegram: sendTelegram };

/** A bad output selection: statusCode is 400 for a bad request, 500 for a bad config. */
export class OutputError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNameList = (v) => Array.isArray(v) && v.every((n) => typeof n === "string");

/**
 * The configured outputs as name -> definition. Config `outputs` wins when
 * present; otherwise the legacy telegram_bot_token / telegram_chat_id keys
 * (falling back to the TELEGRAM_* env vars) become one "telegram" output.
 */
export function configuredOutputs(config) {
    if (config.outputs != null) return config.outputs;

    const botToken = config.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = config.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    return botToken && chatId ? { telegram: { type: "telegram", bot_token: botToken, chat_id: chatId } } : {};
}

/**
 * Decide, before scraping, where each target's results go. A target sends to
 * the configured outputs named in its `outputs`, and nowhere when it names
 * none (its values are still logged). `runNames` (the event's `outputs`), when
 * given, limits the whole run to those names; [] sends nothing. Targets that
 * share a name share their outputs, as they do for `only`.
 *
 * Returns Map<target name, [output name, definition][]>. Throws OutputError:
 * 400 for bad names in the event, 500 for a bad config. Names inside targets
 * count as the event's when `targetsFromEvent` is true.
 */
export function routeOutputs(config, targets, runNames, { targetsFromEvent = false } = {}) {
    const outputs = configuredOutputs(config);
    if (!isPlainObject(outputs)) {
        throw new OutputError("Config 'outputs' must be an object of name -> output definition.", 500);
    }
    for (const [name, output] of Object.entries(outputs)) {
        if (!isPlainObject(output) || !Object.hasOwn(SENDERS, output.type)) {
            const known = Object.keys(SENDERS).join(", ");
            throw new OutputError(`Output '${name}' has unknown type '${output?.type}' (known types: ${known}).`, 500);
        }
    }
    const unknownNames = (names) => names.filter((n) => !Object.hasOwn(outputs, n));

    if (runNames !== undefined) {
        if (!isNameList(runNames)) throw new OutputError("'outputs' must be a list of output names.", 400);
        const unknown = unknownNames(runNames);
        if (unknown.length > 0) throw new OutputError(`Unknown output name(s): ${unknown.join(", ")}`, 400);
    }

    const status = targetsFromEvent ? 400 : 500;
    const routes = new Map();
    targets.forEach((target, i) => {
        if (!isPlainObject(target)) throw new OutputError(`Target #${i + 1} must be an object.`, status);
        const name = targetName(target);
        const listed = target.outputs ?? [];
        if (!isNameList(listed)) {
            throw new OutputError(`Target '${name}': 'outputs' must be a list of output names.`, status);
        }
        const unknown = unknownNames(listed);
        if (unknown.length > 0) {
            throw new OutputError(`Target '${name}': unknown output name(s): ${unknown.join(", ")}`, status);
        }
        const allowed = runNames === undefined ? listed : listed.filter((n) => runNames.includes(n));
        const names = new Set([...(routes.get(name) ?? []).map(([n]) => n), ...allowed]);
        routes.set(name, [...names].map((n) => [n, outputs[n]]));
    });
    return routes;
}

/** "SET TRI -> telegram, dynamodb; Debug -> none (log only)", for the run log. */
export function describeRoutes(routes) {
    return [...routes]
        .map(([target, routed]) => `${target} -> ${routed.map(([n]) => n).join(", ") || "none (log only)"}`)
        .join("; ");
}

/**
 * Send each routed output one batch: the results of every target routed to
 * it (results carry their `target` name). One output failing doesn't stop
 * the rest.
 */
export async function sendOutputs(routes, results, logger) {
    const batches = new Map(); // output name -> { output, results }
    for (const routed of routes.values()) {
        for (const [name, output] of routed) {
            if (!batches.has(name)) batches.set(name, { output, results: [] });
        }
    }
    for (const result of results) {
        for (const [name] of routes.get(result.target) ?? []) batches.get(name).results.push(result);
    }

    for (const [name, { output, results: batch }] of batches) {
        logger.info(`Sending results to output '${name}' (${output.type})`);
        try {
            await SENDERS[output.type](output, batch, logger);
        } catch (e) {
            logger.error(`Output '${name}' failed: ${e.message}`);
        }
    }
}
