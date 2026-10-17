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
 * Sender for `type: "telegram"` outputs. bot_token and chat_id accept
 * secret_manager[...], string[...] or plain values.
 */
export async function sendTelegram(output, results, logger) {
    if (results.length === 0) {
        logger.info("No results to send to Telegram.");
        return;
    }
    const botToken = await resolveValue(output.bot_token, logger);
    const chatId = await resolveValue(output.chat_id, logger);
    const missing = Object.entries({ bot_token: botToken, chat_id: chatId }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        logger.warning(`Telegram message not sent: ${missing.join(" and ")} is empty or could not be resolved.`);
        return;
    }
    await sendTelegramMessage(botToken, chatId, results, logger);
}
