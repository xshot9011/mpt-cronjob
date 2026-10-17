import crypto from "node:crypto";

// Minimal AWS Signature Version 4 signer built on node:crypto, so the project
// does not need the AWS SDK (and its ~80 transitive packages) just to read a
// secret. Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256Hex = (data) => crypto.createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

// RFC 3986 encoding (encodeURIComponent leaves !'()* unescaped).
const rfc3986 = (s) => encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(searchParams) {
    return [...searchParams]
        .map(([k, v]) => [rfc3986(k), rfc3986(v)])
        .sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
}

/**
 * Sign an HTTP request. Returns the headers to add to it (x-amz-date,
 * authorization and, for temporary credentials, x-amz-security-token).
 *
 * The Host header is signed from `url.host`; fetch() sends that same value,
 * so it is not returned.
 */
export function signRequest({ method, url, headers = {}, body = "", region, service, credentials, now = new Date() }) {
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20150830T123600Z
    const dateStamp = amzDate.slice(0, 8);

    const added = { "x-amz-date": amzDate };
    if (credentials.sessionToken) added["x-amz-security-token"] = credentials.sessionToken;

    const all = { host: url.host };
    for (const [name, value] of Object.entries({ ...headers, ...added })) {
        all[name.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
    }
    const names = Object.keys(all).sort();
    const signedHeaders = names.join(";");

    const canonicalRequest = [
        method.toUpperCase(),
        url.pathname || "/",
        canonicalQuery(url.searchParams),
        names.map((n) => `${n}:${all[n]}\n`).join(""),
        signedHeaders,
        sha256Hex(body),
    ].join("\n");

    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

    let signingKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
    for (const part of [region, service, "aws4_request"]) signingKey = hmac(signingKey, part);
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    return {
        ...added,
        authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, `
            + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}
