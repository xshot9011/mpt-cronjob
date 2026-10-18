import { signRequest } from "./sigv4.js";

let configuredRegion;

/** Region from the config's top-level "region" key. Wins over the AWS_* env vars. */
export function setAwsRegion(region) {
    configuredRegion = region || undefined;
}

function resolveRegion() {
    return configuredRegion
        || process.env.region // legacy lower-case variable, kept for existing deployments
        || process.env.AWS_REGION
        || process.env.AWS_DEFAULT_REGION;
}

/**
 * Credentials come from the standard env vars only. Lambda always sets them for
 * the function's execution role. Locally, export them from your AWS CLI login:
 *   eval "$(aws configure export-credentials --format env)"
 */
function credentialsFromEnv() {
    const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
        throw new Error(
            "No AWS credentials in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). "
            + "Lambda sets these automatically; locally run: "
            + "eval \"$(aws configure export-credentials --format env)\"",
        );
    }
    return {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
        sessionToken: AWS_SESSION_TOKEN,
    };
}

function endpointFor(service, endpointId, region) {
    // Same override variables the AWS SDKs honour (handy for LocalStack),
    // e.g. AWS_ENDPOINT_URL_SECRETS_MANAGER or AWS_ENDPOINT_URL_DYNAMODB.
    const override = process.env[`AWS_ENDPOINT_URL_${endpointId}`] || process.env.AWS_ENDPOINT_URL;
    if (override) return new URL(override);
    const domain = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
    return new URL(`https://${service}.${region}.${domain}/`);
}

/**
 * Make one call to an AWS JSON-protocol API (Secrets Manager, DynamoDB),
 * signed with SigV4. `region` defaults to the configured one. Returns the
 * parsed response; throws on missing credentials/region or an AWS error
 * response ("<ErrorType>: <message>").
 */
export async function awsJsonCall({ service, endpointId, contentType, amzTarget, payload, region = resolveRegion() }) {
    if (!region) throw new Error("No AWS region. Set 'region' in the config or the AWS_REGION env var.");

    const url = endpointFor(service, endpointId, region);
    const body = JSON.stringify(payload);
    const headers = { "content-type": contentType, "x-amz-target": amzTarget };
    const signed = signRequest({ method: "POST", url, headers, body, region, service, credentials: credentialsFromEnv() });

    const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, ...signed },
        body,
        signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();

    if (!response.ok) {
        let type = `HTTP ${response.status}`;
        let message = text;
        try {
            const err = JSON.parse(text);
            type = String(err.__type || type).split("#").pop();
            message = err.message || err.Message || text;
        } catch {
            // Non-JSON error body: report it as-is.
        }
        throw new Error(`${type}: ${message}`);
    }
    return text ? JSON.parse(text) : {};
}
