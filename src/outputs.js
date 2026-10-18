import { checkDynamoOutput, checkDynamoRoute, sendDynamoDB } from "./dynamodb.js";
import { checkSheetsOutput, checkSheetsRoute, sendGoogleSheets } from "./sheets.js";
import { sendTelegram } from "./telegram.js";
import { isPlainObject, targetName } from "./util.js";

/**
 * Output type -> sender(output, results, logger, optionsByTarget). A new
 * destination type is one more entry here; routing and validation don't
 * change. optionsByTarget maps each target name to the options that target
 * gave the output in its `outputs` ({} when it just named it).
 */
export const SENDERS = { telegram: sendTelegram, dynamodb: sendDynamoDB, google_sheets: sendGoogleSheets };

/**
 * Output type -> checks returning an error message or null: `output` checks a
 * configured definition, `route` the options a target gives it with
 * { "name": ..., ...options }. A type missing here takes no options.
 */
export const CHECKS = {
    dynamodb: { output: checkDynamoOutput, route: checkDynamoRoute },
    google_sheets: { output: checkSheetsOutput, route: checkSheetsRoute },
};

/** A bad output selection: statusCode is 400 for a bad request, 500 for a bad config. */
export class OutputError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}

const isNameList = (v) => Array.isArray(v) && v.every((n) => typeof n === "string");

/** A target's `outputs` entry, "name" or { "name": ..., ...options }, as { name, options }; null if malformed. */
function parseEntry(entry) {
    if (typeof entry === "string") return { name: entry, options: {} };
    if (!isPlainObject(entry) || typeof entry.name !== "string") return null;
    const { name, ...options } = entry;
    return { name, options };
}

/** What's wrong with the options a target gives `output`, or null. */
function routeProblem(output, options) {
    const check = Object.hasOwn(CHECKS, output.type) ? CHECKS[output.type].route : undefined;
    if (check) return check(options, output);
    const given = Object.keys(options);
    return given.length > 0 ? `${output.type} outputs take no options (got ${given.join(", ")}).` : null;
}

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
 * none (its values are still logged). An entry can be a name or
 * { "name": ..., ...options } with options for that output type (a dynamodb
 * output's `columns`, a google_sheets output's `tab` and `columns`). `runNames` (the event's `outputs`), when given,
 * limits the whole run to those names; [] sends nothing. Targets that share a
 * name share their outputs, as they do for `only`.
 *
 * Returns Map<target name, [output name, definition, options][]>. Throws
 * OutputError: 400 for bad names or options in the event, 500 for a bad
 * config. Entries inside targets count as the event's when
 * `targetsFromEvent` is true.
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
        const problem = Object.hasOwn(CHECKS, output.type) ? CHECKS[output.type].output(output) : null;
        if (problem) throw new OutputError(`Output '${name}' (${output.type}) ${problem}`, 500);
    }
    const unknownNames = (names) => names.filter((n) => !Object.hasOwn(outputs, n));

    if (runNames !== undefined) {
        if (!isNameList(runNames)) throw new OutputError("'outputs' must be a list of output names.", 400);
        const unknown = unknownNames(runNames);
        if (unknown.length > 0) throw new OutputError(`Unknown output name(s): ${unknown.join(", ")}`, 400);
    }

    const status = targetsFromEvent ? 400 : 500;
    const routed = new Map(); // target name -> Map<output name, options>
    targets.forEach((target, i) => {
        if (!isPlainObject(target)) throw new OutputError(`Target #${i + 1} must be an object.`, status);
        const name = targetName(target);
        const listed = target.outputs ?? [];
        const entries = Array.isArray(listed) ? listed.map(parseEntry) : [null];
        if (entries.includes(null)) {
            throw new OutputError(`Target '${name}': 'outputs' must be a list of output names or { "name": ... } objects.`, status);
        }
        const unknown = unknownNames(entries.map((e) => e.name));
        if (unknown.length > 0) {
            throw new OutputError(`Target '${name}': unknown output name(s): ${unknown.join(", ")}`, status);
        }
        const forTarget = routed.get(name) ?? new Map();
        for (const { name: output, options } of entries) {
            const problem = routeProblem(outputs[output], options);
            if (problem) throw new OutputError(`Target '${name}', output '${output}': ${problem}`, status);
            const hasOptions = Object.keys(options).length > 0;
            if (hasOptions && Object.keys(forTarget.get(output) ?? {}).length > 0) {
                throw new OutputError(`Target '${name}': output '${output}' is given options more than once.`, status);
            }
            if (hasOptions || !forTarget.has(output)) forTarget.set(output, options);
        }
        routed.set(name, forTarget);
    });

    const inRun = ([output]) => runNames === undefined || runNames.includes(output);
    return new Map([...routed].map(([name, forTarget]) => [
        name,
        [...forTarget].filter(inRun).map(([output, options]) => [output, outputs[output], options]),
    ]));
}

/** "SET TRI -> telegram, dynamodb; Debug -> none (log only)", for the run log. */
export function describeRoutes(routes) {
    return [...routes]
        .map(([target, routed]) => `${target} -> ${routed.map(([n]) => n).join(", ") || "none (log only)"}`)
        .join("; ");
}

/**
 * Send each routed output one batch: the results of every target routed to
 * it (results carry their `target` name), with each target's options for
 * it. One output failing doesn't stop the rest.
 */
export async function sendOutputs(routes, results, logger) {
    const batches = new Map(); // output name -> { output, results, optionsByTarget }
    for (const [target, routed] of routes) {
        for (const [name, output, options] of routed) {
            if (!batches.has(name)) batches.set(name, { output, results: [], optionsByTarget: new Map() });
            batches.get(name).optionsByTarget.set(target, options);
        }
    }
    for (const result of results) {
        for (const [name] of routes.get(result.target) ?? []) batches.get(name).results.push(result);
    }

    for (const [name, { output, results: batch, optionsByTarget }] of batches) {
        logger.info(`Sending results to output '${name}' (${output.type})`);
        try {
            await SENDERS[output.type](output, batch, logger, optionsByTarget);
        } catch (e) {
            logger.error(`Output '${name}' failed: ${e.message}`);
        }
    }
}
