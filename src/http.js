import crypto from "node:crypto";

// Helpers for events that arrive over HTTP: API Gateway REST APIs (payload v1),
// HTTP APIs (payload v2) and Lambda Function URLs (same shape as v2).

/** True for API Gateway and Function URL events; false for EventBridge, console or CLI invocations. */
export function isHttpEvent(event) {
    return Boolean(event?.requestContext && (event.requestContext.http || event.httpMethod));
}

/** Case-insensitive header lookup (v1 keeps the client's casing, v2 lower-cases). */
export function getHeader(event, name) {
    const headers = event.headers || {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
}

/** Parse the JSON request body; an empty body is {}. Throws on invalid JSON. */
export function parseJsonBody(event) {
    if (!event.body) return {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const body = JSON.parse(raw);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("body must be a JSON object");
    }
    return body;
}

/**
 * Constant-time API key check. Both sides are hashed first so the comparison
 * does not leak the expected key's length either.
 */
export function apiKeyMatches(presented, expected) {
    if (typeof presented !== "string" || typeof expected !== "string" || expected === "") return false;
    const a = crypto.createHash("sha256").update(presented, "utf8").digest();
    const b = crypto.createHash("sha256").update(expected, "utf8").digest();
    return crypto.timingSafeEqual(a, b);
}
