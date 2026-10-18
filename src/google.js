import crypto from "node:crypto";
import { isPlainObject } from "./util.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const REFRESH_MARGIN_MS = 5 * 60_000;

const tokens = new Map(); // client_email -> { token, expiresAt (ms) }

const base64url = (data) => Buffer.from(data).toString("base64url");

/**
 * A service-account private key as a KeyObject. Accepts the PEM with real
 * newlines or with literal "\n" sequences, as the Secrets Manager console
 * often stores it. The error never includes the key.
 */
function privateKeyObject(privateKey) {
    try {
        return crypto.createPrivateKey(String(privateKey).replace(/\\n/g, "\n"));
    } catch {
        throw new Error("private_key is not a valid PEM private key.");
    }
}

/**
 * A service-account JWT (RS256) asking for the Sheets scope, issued at `now`
 * (ms) and valid for an hour.
 */
export function serviceAccountJwt(clientEmail, privateKey, now = Date.now()) {
    const iat = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
    const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), privateKeyObject(privateKey));
    return `${header}.${claims}.${signature.toString("base64url")}`;
}

/**
 * A failed Google API response as "<error>: <message>". The two endpoints
 * use different shapes:
 *   token endpoint: { "error": "invalid_grant", "error_description": "..." }
 *   Sheets API:     { "error": { "code": 403, "status": "PERMISSION_DENIED", "message": "..." } }
 * Non-JSON bodies are reported as-is.
 */
export function googleErrorMessage(status, text) {
    let type = `HTTP ${status}`;
    let message = text;
    try {
        const { error, error_description: description } = JSON.parse(text);
        if (typeof error === "string") {
            type = error;
            message = description || text;
        } else if (isPlainObject(error)) {
            type = error.status || type;
            message = error.message || text;
        }
    } catch {
        // Non-JSON error body: report it as-is.
    }
    return `${type}: ${message}`;
}

/**
 * An OAuth access token for the service account. Cached in module scope per
 * client_email until 5 minutes before it expires, so warm Lambda invocations
 * reuse it. `now` is in ms. Errors never include the key, the JWT or the token.
 */
export async function accessToken(clientEmail, privateKey, now = Date.now()) {
    const cached = tokens.get(clientEmail);
    if (cached && now < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;

    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: serviceAccountJwt(clientEmail, privateKey, now),
    });
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google token request failed: ${googleErrorMessage(response.status, text)}`);

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Not echoed: the body would carry the token.
        throw new Error("Google token response is not JSON.");
    }
    const { access_token: token, expires_in: expiresIn } = parsed ?? {};
    if (typeof token !== "string" || token === "") throw new Error("Google token response has no access_token.");
    tokens.set(clientEmail, { token, expiresAt: now + (Number(expiresIn) || 3600) * 1000 });
    return token;
}

/** A 0-based column index in A1 letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetters(index) {
    let letters = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    }
    return letters;
}

/** A range in A1 notation on a tab, quoted with any ' doubled: a1Range("Bob's", "A1") -> 'Bob''s'!A1. */
export function a1Range(tab, cells) {
    return `'${String(tab).replace(/'/g, "''")}'!${cells}`;
}

/**
 * One Sheets v4 call as the service account in `auth` ({ clientEmail,
 * privateKey }). `path` follows the spreadsheet ID; `payload`, when given,
 * is sent as JSON. Returns the parsed response; throws a readable error.
 */
async function sheetsRequest(auth, spreadsheetId, method, path, payload) {
    const token = await accessToken(auth.clientEmail, auth.privateKey);
    const headers = { authorization: `Bearer ${token}` };
    if (payload !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${SHEETS_URL}/${encodeURIComponent(spreadsheetId)}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : {};

    if (response.status === 401) tokens.delete(auth.clientEmail); // revoked early: the next call gets a new token
    let message = googleErrorMessage(response.status, text);
    if (/caller does not have permission/i.test(message)) message += ` (is the sheet shared with ${auth.clientEmail}?)`;
    throw new Error(message);
}

const valuesPath = (range) => `/values/${encodeURIComponent(range)}`;

/** The names of a spreadsheet's tabs. */
export async function sheetTitles(auth, spreadsheetId) {
    const { sheets = [] } = await sheetsRequest(auth, spreadsheetId, "GET", "?fields=sheets.properties.title");
    return sheets.map((sheet) => sheet.properties?.title);
}

/** The rows in `range` as formatted strings; [] when it's empty (Sheets then sends no `values`). */
export async function getValues(auth, spreadsheetId, range) {
    const { values = [] } = await sheetsRequest(auth, spreadsheetId, "GET", valuesPath(range));
    return values;
}

/** Write `rows` over `range`, stored as given (RAW: never parsed, so text can't become a formula). */
export function updateValues(auth, spreadsheetId, range, rows) {
    return sheetsRequest(auth, spreadsheetId, "PUT", `${valuesPath(range)}?valueInputOption=RAW`, { values: rows });
}

/** Append `rows` after the table at `range` in newly inserted rows, stored as given (RAW). */
export function appendValues(auth, spreadsheetId, range, rows) {
    const query = "valueInputOption=RAW&insertDataOption=INSERT_ROWS";
    return sheetsRequest(auth, spreadsheetId, "POST", `${valuesPath(range)}:append?${query}`, { values: rows });
}
