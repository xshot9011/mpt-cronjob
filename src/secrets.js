import { awsJsonCall } from "./aws.js";

/**
 * Read one key of a JSON secret via Secrets Manager's GetSecretValue API.
 * Returns null when the secret is not a JSON string or the key is missing;
 * throws on missing credentials/region or an AWS error response.
 */
export async function getSecret(secretId, key) {
    const { SecretString } = await awsJsonCall({
        service: "secretsmanager",
        endpointId: "SECRETS_MANAGER",
        contentType: "application/x-amz-json-1.1",
        amzTarget: "secretsmanager.GetSecretValue",
        payload: { SecretId: secretId },
    });
    if (typeof SecretString !== "string") return null; // binary secrets are not supported
    try {
        return JSON.parse(SecretString)?.[key] ?? null;
    } catch {
        return null;
    }
}
