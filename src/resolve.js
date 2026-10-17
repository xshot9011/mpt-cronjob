import { getSecret } from "./secrets.js";

const SECRET_RE = /^secret_manager\['([^']+)'\]\['([^']+)'\]/;
const STRING_RE = /^string\['([^']+)'\]/;

/**
 * Parse a duration value into seconds.
 * Accepts a number (seconds) or a string with an optional unit suffix:
 *   '30' -> 30, '30s' -> 30, '2m' -> 120, '1h' -> 3600
 * Throws on anything else.
 */
export function parseDuration(duration) {
    if (typeof duration === "number") return duration;

    const s = String(duration).trim().toLowerCase();
    const multiplier = { h: 3600, m: 60, s: 1 }[s.slice(-1)];
    const amount = multiplier ? s.slice(0, -1).trim() : s;
    const n = amount === "" ? NaN : Number(amount);
    if (!Number.isFinite(n)) throw new Error(`could not convert '${duration}' to a duration`);
    return n * (multiplier ?? 1);
}

/**
 * Resolve a config value:
 *   secret_manager['<secret_name_or_arn>']['<json_key>']  -> AWS Secrets Manager lookup
 *   string['<value>']                                     -> the literal value
 *   anything else                                         -> returned unchanged
 * Returns null (and logs) when a secret cannot be read.
 */
export async function resolveValue(value, logger) {
    if (typeof value !== "string") return value;

    const secret = SECRET_RE.exec(value);
    if (secret) {
        const [, secretName, secretKey] = secret;
        try {
            const secretValue = await getSecret(secretName, secretKey);
            if (secretValue == null) logger.error(`Secret key '${secretKey}' not found in '${secretName}'`);
            return secretValue ?? null;
        } catch (e) {
            logger.error(`Failed to get secret '${secretName}': ${e.message}`);
            return null;
        }
    }

    const literal = STRING_RE.exec(value);
    if (literal) return literal[1];

    return value;
}
