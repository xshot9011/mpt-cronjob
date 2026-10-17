import { sendTelegram } from "./telegram.js";

/**
 * Output type -> sender(output, results, logger). A new destination type is
 * one more entry here; selection and validation don't change.
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
 * Pick the outputs a run sends its results to, as [name, definition] pairs.
 * `names` undefined means every configured output, [] means none. Every
 * configured output must have a known type, and every name must be configured;
 * otherwise this throws an OutputError.
 */
export function selectOutputs(config, names) {
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

    if (names === undefined) return Object.entries(outputs);

    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
        throw new OutputError("'outputs' must be a list of output names.", 400);
    }
    const unknown = names.filter((n) => !Object.hasOwn(outputs, n));
    if (unknown.length > 0) throw new OutputError(`Unknown output name(s): ${unknown.join(", ")}`, 400);
    return [...new Set(names)].map((n) => [n, outputs[n]]);
}

/** Send the results to each selected output; one failing doesn't stop the rest. */
export async function sendOutputs(selected, results, logger) {
    for (const [name, output] of selected) {
        logger.info(`Sending results to output '${name}' (${output.type})`);
        try {
            await SENDERS[output.type](output, results, logger);
        } catch (e) {
            logger.error(`Output '${name}' failed: ${e.message}`);
        }
    }
}
