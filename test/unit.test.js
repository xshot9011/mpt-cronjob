import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildSwitchPathUrl } from "../src/actions.js";
import { apiKeyMatches, isHttpEvent, parseJsonBody } from "../src/http.js";
import { handler } from "../src/lambda.js";
import { parseDuration, resolveValue } from "../src/resolve.js";
import { normalizeUrl } from "../src/scraper.js";
import { getSecret, setSecretsRegion } from "../src/secrets.js";
import { signRequest } from "../src/sigv4.js";
import { buildTelegramMessage } from "../src/telegram.js";
import { toBool } from "../src/util.js";

const silent = { debug() {}, info() {}, warning() {}, error() {} };

const setEnv = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};
const originalEnv = new WeakMap(); // test context -> values before the test touched them

/**
 * Set env vars for one test and restore them when it ends. Safe to call
 * several times per test: each variable's original value is captured once.
 */
function withEnv(t, vars) {
    let saved = originalEnv.get(t);
    if (!saved) {
        saved = {};
        originalEnv.set(t, saved);
        t.after(() => setEnv(saved));
    }
    for (const k of Object.keys(vars)) {
        if (!(k in saved)) saved[k] = process.env[k];
    }
    setEnv(vars);
}

/** Replace fetch with a stub for one test; returns the recorded calls. */
function stubFetch(t, respond) {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return respond(url, init);
    };
    t.after(() => { globalThis.fetch = realFetch; });
    return calls;
}

function fakeAws(t) {
    withEnv(t, {
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        AWS_SESSION_TOKEN: undefined,
        AWS_ENDPOINT_URL: undefined,
        AWS_ENDPOINT_URL_SECRETS_MANAGER: undefined,
    });
    setSecretsRegion("ap-southeast-7");
    t.after(() => setSecretsRegion(undefined));
}

test("parseDuration accepts seconds and h/m/s suffixes", () => {
    assert.equal(parseDuration(5), 5);
    assert.equal(parseDuration("30"), 30);
    assert.equal(parseDuration("30s"), 30);
    assert.equal(parseDuration("0.5s"), 0.5);
    assert.equal(parseDuration("2m"), 120);
    assert.equal(parseDuration(" 1H "), 3600);
    assert.throws(() => parseDuration("abc"));
    assert.throws(() => parseDuration("s"));
    assert.throws(() => parseDuration(null));
});

test("toBool parses string flags", () => {
    assert.equal(toBool("true"), true);
    assert.equal(toBool("false"), false);
    assert.equal(toBool(true), true);
    assert.equal(toBool(0), false);
    assert.equal(toBool(undefined, true), true);
});

test("resolveValue handles string[...] literals, plain values and non-strings", async () => {
    assert.equal(await resolveValue("string['my_hardcoded_value']", silent), "my_hardcoded_value");
    assert.equal(await resolveValue("plain value", silent), "plain value");
    assert.equal(await resolveValue(42, silent), 42);
    assert.equal(await resolveValue(undefined, silent), undefined);
});

// "get-vanilla" from the AWS Signature Version 4 test suite.
test("signRequest matches the AWS SigV4 get-vanilla test vector", () => {
    const headers = signRequest({
        method: "GET",
        url: new URL("https://example.amazonaws.com/"),
        region: "us-east-1",
        service: "service",
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
        now: new Date("2015-08-30T12:36:00Z"),
    });
    assert.equal(headers["x-amz-date"], "20150830T123600Z");
    assert.equal(
        headers.authorization,
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
        + "SignedHeaders=host;x-amz-date, "
        + "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
});

test("signRequest adds the session token for temporary credentials", () => {
    const headers = signRequest({
        method: "POST",
        url: new URL("https://secretsmanager.ap-southeast-7.amazonaws.com/"),
        body: "{}",
        region: "ap-southeast-7",
        service: "secretsmanager",
        credentials: { accessKeyId: "AKID", secretAccessKey: "secret", sessionToken: "token" },
    });
    assert.equal(headers["x-amz-security-token"], "token");
    assert.match(headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
});

test("secret_manager[...] values are read with a signed GetSecretValue call", async (t) => {
    fakeAws(t);
    const calls = stubFetch(t, () => new Response(JSON.stringify({
        SecretString: JSON.stringify({ USERNAME: "alice" }),
    })));

    assert.equal(await resolveValue("secret_manager['my-app-secrets']['USERNAME']", silent), "alice");
    assert.equal(await resolveValue("secret_manager['my-app-secrets']['MISSING']", silent), null);

    const [{ url, init }] = calls;
    assert.equal(url, "https://secretsmanager.ap-southeast-7.amazonaws.com/");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { SecretId: "my-app-secrets" });
    assert.equal(init.headers["x-amz-target"], "secretsmanager.GetSecretValue");
    assert.match(
        init.headers.authorization,
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-7\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
});

test("getSecret surfaces AWS error responses; resolveValue turns them into null", async (t) => {
    fakeAws(t);
    stubFetch(t, () => new Response(JSON.stringify({
        __type: "ResourceNotFoundException",
        message: "Secrets Manager can't find the specified secret.",
    }), { status: 400 }));

    await assert.rejects(getSecret("nope", "KEY"), /^Error: ResourceNotFoundException: Secrets Manager can't find/);
    assert.equal(await resolveValue("secret_manager['nope']['KEY']", silent), null);
});

test("getSecret fails clearly without credentials", async (t) => {
    withEnv(t, { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined });
    setSecretsRegion("ap-southeast-7");
    t.after(() => setSecretsRegion(undefined));
    await assert.rejects(getSecret("x", "y"), /No AWS credentials/);
});

test("buildTelegramMessage escapes HTML and honours --no-codeblock", () => {
    assert.equal(
        buildTelegramMessage([
            { name: "Site - price", value: "<1 & 2>", options: [] },
            { name: "Site - headline", value: "Hello", options: ["--no-codeblock"] },
        ]),
        "Site - price\n<pre>&lt;1 &amp; 2&gt;</pre>\nSite - headline\nHello",
    );
});

test("buildSwitchPathUrl keeps scheme, host and port", () => {
    assert.equal(buildSwitchPathUrl("https://example.com:8443/login?next=1", "dashboard"), "https://example.com:8443/dashboard");
    assert.equal(buildSwitchPathUrl("https://example.com/a", "/b?x=1"), "https://example.com/b?x=1");
    // A protocol-relative path must not leave the current host.
    assert.equal(buildSwitchPathUrl("https://example.com/a", "//evil.test"), "https://example.com//evil.test");
});

test("normalizeUrl resolves relative file:// URLs against the working directory", () => {
    assert.equal(normalizeUrl("file://./login.html"), pathToFileURL(path.resolve("login.html")).href);
    assert.equal(normalizeUrl("file:///tmp/a.html"), "file:///tmp/a.html");
    assert.equal(normalizeUrl("https://example.com"), "https://example.com");
});

test("lambda handler rejects a config without targets", async (t) => {
    withEnv(t, { CONFIG_JSON: JSON.stringify({ targets: [] }), LOG_LEVEL: "ERROR" });
    const result = await handler({});
    assert.equal(result.statusCode, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "No targets configured." });
});

test("lambda handler reports a missing config", async (t) => {
    withEnv(t, { CONFIG_JSON: undefined, CONFIG_FILE: "does-not-exist.json", LOG_LEVEL: "ERROR" });
    const result = await handler({});
    assert.equal(result.statusCode, 500);
});

// ---- HTTP (API Gateway / Function URL) requests ----

const API_CONFIG = JSON.stringify({
    http_api_key: "string['test-key']",
    targets: [{ name: "Gold", url: "https://example.com", actions: [{ type: "get", xpath: "//h1" }] }],
});

/** An HTTP API v2 / Function URL event, or an API Gateway REST (v1) event. */
function httpEvent({ key, body, v1 = false } = {}) {
    if (v1) {
        return { httpMethod: "POST", requestContext: { stage: "prod" }, headers: key === undefined ? {} : { "X-Api-Key": key }, body };
    }
    return { version: "2.0", requestContext: { http: { method: "POST" } }, headers: key === undefined ? {} : { "x-api-key": key }, body };
}

async function call(t, config, event) {
    withEnv(t, { CONFIG_JSON: config, LOG_LEVEL: "ERROR" });
    const result = await handler(event);
    return { status: result.statusCode, body: JSON.parse(result.body) };
}

test("isHttpEvent tells HTTP requests from scheduled/console invocations", () => {
    assert.equal(isHttpEvent(httpEvent()), true);
    assert.equal(isHttpEvent(httpEvent({ v1: true })), true);
    assert.equal(isHttpEvent({}), false);
    assert.equal(isHttpEvent({ source: "aws.events", "detail-type": "Scheduled Event", detail: {} }), false);
    assert.equal(isHttpEvent(undefined), false);
});

test("apiKeyMatches only accepts the exact key", () => {
    assert.equal(apiKeyMatches("test-key", "test-key"), true);
    assert.equal(apiKeyMatches("test-key ", "test-key"), false);
    assert.equal(apiKeyMatches(undefined, "test-key"), false);
    assert.equal(apiKeyMatches("", ""), false);
});

test("parseJsonBody handles base64 bodies and rejects non-objects", () => {
    const body = Buffer.from(JSON.stringify({ only: ["Gold"] })).toString("base64");
    assert.deepEqual(parseJsonBody({ body, isBase64Encoded: true }), { only: ["Gold"] });
    assert.deepEqual(parseJsonBody({}), {});
    assert.throws(() => parseJsonBody({ body: "[1,2]" }));
    assert.throws(() => parseJsonBody({ body: "not json" }));
});

test("HTTP requests are refused when no http_api_key is configured", async (t) => {
    const config = JSON.stringify({ targets: [{ name: "Gold", url: "https://example.com", actions: [] }] });
    const { status } = await call(t, config, httpEvent({ key: "anything" }));
    assert.equal(status, 503);
});

test("HTTP requests need the right x-api-key", async (t) => {
    assert.equal((await call(t, API_CONFIG, httpEvent())).status, 401);
    assert.equal((await call(t, API_CONFIG, httpEvent({ key: "wrong" }))).status, 401);
});

test("HTTP requests cannot supply their own targets", async (t) => {
    // v1 event with the client's header casing also proves the key check passed.
    const body = JSON.stringify({ targets: [{ name: "evil", url: "https://attacker.test", actions: [] }] });
    const { status, body: res } = await call(t, API_CONFIG, httpEvent({ key: "test-key", body, v1: true }));
    assert.equal(status, 400);
    assert.match(res.error, /'targets' is not accepted over HTTP/);
});

test("HTTP requests reject bad JSON and unknown target names", async (t) => {
    assert.equal((await call(t, API_CONFIG, httpEvent({ key: "test-key", body: "{oops" }))).status, 400);
    const { status, body } = await call(t, API_CONFIG, httpEvent({ key: "test-key", body: JSON.stringify({ only: ["Nope"] }) }));
    assert.equal(status, 400);
    assert.equal(body.error, "Unknown target name(s): Nope");
});

test("scheduled events can use 'only' too", async (t) => {
    const { status, body } = await call(t, API_CONFIG, { only: ["Nope"] });
    assert.equal(status, 400);
    assert.equal(body.error, "Unknown target name(s): Nope");
});
