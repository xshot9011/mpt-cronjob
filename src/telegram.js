import { resolveValue } from "./resolve.js";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * One block per result: the name, then the value in a <pre> code block unless
 * the `get` action set telegram_message_options: ["--no-codeblock"].
 */
export function buildTelegramMessage(results) {
    return results.map(({ name, value, options }) => {
        const safeName = escapeHtml(name);
        const safeValue = escapeHtml(value);
        const noCodeblock = Array.isArray(options) && options.includes("--no-codeblock");
        return noCodeblock ? `${safeName}\n${safeValue}` : `${safeName}\n<pre>${safeValue}</pre>`;
    }).join("\n");
}

export async function sendTelegramMessage(botToken, chatId, results, logger) {
    if (!botToken || !chatId || !results?.length) return;

    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: buildTelegramMessage(results), parse_mode: "HTML" }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(await response.text());
        logger.info("Successfully sent Telegram message.");
    } catch (e) {
        logger.error(`Failed to send Telegram message: ${e.message}`);
    }
}

/**
 * Send the results to Telegram when a bot token and chat id are configured
 * (config telegram_bot_token / telegram_chat_id, else the TELEGRAM_* env vars).
 */
export async function notifyTelegram(config, results, logger) {
    const botToken = await resolveValue(config.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN, logger);
    const chatId = await resolveValue(config.telegram_chat_id || process.env.TELEGRAM_CHAT_ID, logger);
    if (botToken && chatId && results.length > 0) {
        await sendTelegramMessage(botToken, chatId, results, logger);
    }
}
