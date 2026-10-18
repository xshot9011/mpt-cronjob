import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildSwitchPathUrl } from "../src/actions.js";
import { setAwsRegion } from "../src/aws.js";
import { browserLaunchOptions } from "../src/browser.js";
import { buildDynamoItems, toDynamoNumber } from "../src/dynamodb.js";
import { a1Range, accessToken, columnLetters, googleErrorMessage, serviceAccountJwt } from "../src/google.js";
import { apiKeyMatches, isHttpEvent, looksLikeHttpRequest, parseJsonBody } from "../src/http.js";
import { handler } from "../src/lambda.js";
import { OutputError, SENDERS, configuredOutputs, describeRoutes, routeOutputs, sendOutputs } from "../src/outputs.js";
import { parseDuration, resolveValue } from "../src/resolve.js";
import { normalizeUrl } from "../src/scraper.js";
import { getSecret } from "../src/secrets.js";
import { buildSheetsRecords, placeRecord, toSheetsCell } from "../src/sheets.js";
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
        AWS_ENDPOINT_URL_DYNAMODB: undefined,
    });
    setAwsRegion("ap-southeast-7");
    t.after(() => setAwsRegion(undefined));
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
    setAwsRegion("ap-southeast-7");
    t.after(() => setAwsRegion(undefined));
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

async function call(t, config, event, logLevel = "ERROR") {
    withEnv(t, { CONFIG_JSON: config, LOG_LEVEL: logLevel });
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

// ---- Outputs ----

const TARGETS = [{ name: "Gold", url: "https://example.com", actions: [{ type: "get", xpath: "//h1" }] }];
const tg = (id) => ({ type: "telegram", bot_token: `string['bot-${id}']`, chat_id: `string['chat-${id}']` });
const TWO_OUTPUTS = { outputs: { telegram: tg("a"), "telegram-alert": tg("b") } };
const target = (name, outputs) => ({ name, url: "https://example.com", actions: [], ...(outputs === undefined ? {} : { outputs }) });
const result = (targetName, field, value = "1") => ({ name: `${targetName} - ${field}`, value, options: [], target: targetName, field });

/** A logger that records every line as "<LEVEL> <message>". */
function recordingLogger() {
    const lines = [];
    const log = (level) => (message) => lines.push(`${level} ${message}`);
    return { lines, debug: log("DEBUG"), info: log("INFO"), warning: log("WARNING"), error: log("ERROR") };
}

/** Capture console output for one test (the logger writes there). */
function captureConsole(t) {
    const lines = [];
    for (const method of ["log", "warn", "error"]) {
        const real = console[method];
        console[method] = (...args) => lines.push(args.join(" "));
        t.after(() => { console[method] = real; });
    }
    return lines;
}

/** Bot tokens of the Telegram messages sent through a stubbed fetch. */
const sentBots = (calls) => calls.map(({ url }) => /\/bot([^/]+)\/sendMessage$/.exec(url)?.[1]);

/** routeOutputs' result as { target: [output names] }. */
const routeNames = (routes) => Object.fromEntries([...routes].map(([name, routed]) => [name, routed.map(([n]) => n)]));

test("legacy telegram_* keys become one 'telegram' output", (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined });
    assert.deepEqual(configuredOutputs({ telegram_bot_token: "tok", telegram_chat_id: "chat" }), {
        telegram: { type: "telegram", bot_token: "tok", chat_id: "chat" },
    });
    assert.deepEqual(configuredOutputs({ telegram_bot_token: "tok" }), {});
    assert.deepEqual(configuredOutputs({}), {});
});

test("the legacy Telegram output falls back to the TELEGRAM_* env vars; config 'outputs' wins", (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: "env-tok", TELEGRAM_CHAT_ID: "env-chat" });
    assert.deepEqual(configuredOutputs({}), { telegram: { type: "telegram", bot_token: "env-tok", chat_id: "env-chat" } });
    assert.equal(configuredOutputs({ telegram_chat_id: "cfg-chat" }).telegram.chat_id, "cfg-chat");
    assert.deepEqual(configuredOutputs({ outputs: {}, telegram_bot_token: "tok", telegram_chat_id: "chat" }), {});
});

test("routeOutputs: a target sends to the outputs it names, and nowhere when it names none", () => {
    const routes = routeOutputs(TWO_OUTPUTS, [
        target("SET TRI", ["telegram", "telegram-alert", "telegram"]),
        target("Gold", ["telegram-alert"]),
        target("Debug"),
        target("Quiet", []),
        target("Unset", null),
    ], undefined);
    assert.deepEqual(routeNames(routes), {
        "SET TRI": ["telegram", "telegram-alert"],
        Gold: ["telegram-alert"],
        Debug: [],
        Quiet: [],
        Unset: [],
    });
    assert.equal(
        describeRoutes(routes),
        "SET TRI -> telegram, telegram-alert; Gold -> telegram-alert; Debug -> none (log only); "
        + "Quiet -> none (log only); Unset -> none (log only)",
    );
});

test("routeOutputs: the event's outputs limit the run; [] sends nothing", () => {
    const targets = [target("SET TRI", ["telegram", "telegram-alert"]), target("Gold", ["telegram"])];
    assert.deepEqual(routeNames(routeOutputs(TWO_OUTPUTS, targets, ["telegram-alert"])), { "SET TRI": ["telegram-alert"], Gold: [] });
    assert.deepEqual(routeNames(routeOutputs(TWO_OUTPUTS, targets, [])), { "SET TRI": [], Gold: [] });
});

test("routeOutputs: targets that share a name share their outputs", () => {
    const targets = [target("Gold", ["telegram"]), target("Gold", ["telegram-alert"])];
    assert.deepEqual(routeNames(routeOutputs(TWO_OUTPUTS, targets, undefined)), { Gold: ["telegram", "telegram-alert"] });
});

test("routeOutputs rejects bad names: 400 when the event sent them, 500 when the config has them", () => {
    const fails = (config, targets, runNames, options, statusCode, message) => assert.throws(
        () => routeOutputs(config, targets, runNames, options),
        (e) => e instanceof OutputError && e.statusCode === statusCode && message.test(e.message),
    );
    const ok = [target("Gold", ["telegram"])];
    fails(TWO_OUTPUTS, ok, ["nope"], {}, 400, /^Unknown output name\(s\): nope$/);
    fails(TWO_OUTPUTS, ok, ["toString"], {}, 400, /^Unknown output name\(s\): toString$/);
    fails(TWO_OUTPUTS, ok, "telegram", {}, 400, /^'outputs' must be a list/);
    fails(TWO_OUTPUTS, ok, [42], {}, 400, /^'outputs' must be a list/);
    fails(TWO_OUTPUTS, [target("Gold", ["nope"])], undefined, { targetsFromEvent: true }, 400, /^Target 'Gold': unknown output name\(s\): nope$/);
    fails(TWO_OUTPUTS, [target("Gold", ["nope"])], undefined, {}, 500, /^Target 'Gold': unknown output name\(s\): nope$/);
    fails(TWO_OUTPUTS, [target("Gold", "telegram")], undefined, { targetsFromEvent: true }, 400, /^Target 'Gold': 'outputs' must be a list/);
    fails(TWO_OUTPUTS, [null], undefined, { targetsFromEvent: true }, 400, /^Target #1 must be an object/);
    fails({ outputs: { x: { type: "pigeon" } } }, ok, undefined, {}, 500, /^Output 'x' has unknown type 'pigeon'/);
    fails({ outputs: { x: "telegram" } }, ok, [], {}, 500, /^Output 'x' has unknown type/);
    fails({ outputs: [tg("a")] }, ok, undefined, {}, 500, /must be an object/);
});

test("sendOutputs sends each output one message with the results routed to it", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const logger = recordingLogger();
    const routes = routeOutputs(TWO_OUTPUTS, [
        target("SET TRI", ["telegram"]),
        target("Gold", ["telegram", "telegram-alert"]),
        target("Debug"),
    ], undefined);
    await sendOutputs(routes, [result("SET TRI", "BANK TRI"), result("Gold", "price"), result("Debug", "probe")], logger);

    assert.deepEqual(sentBots(calls), ["bot-a", "bot-b"]);
    const [main, alert] = calls.map(({ init }) => JSON.parse(init.body));
    assert.equal(main.text, "SET TRI - BANK TRI\n<pre>1</pre>\nGold - price\n<pre>1</pre>");
    assert.equal(alert.text, "Gold - price\n<pre>1</pre>");
    assert.equal(alert.chat_id, "chat-b");
    assert.ok(logger.lines.includes("INFO Sending results to output 'telegram' (telegram)"));
    assert.ok(logger.lines.includes("INFO Sending results to output 'telegram-alert' (telegram)"));
});

test("sendOutputs sends nothing for log-only targets, for [] or for empty results", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const targets = [target("Gold", ["telegram"]), target("Debug")];
    await sendOutputs(routeOutputs(TWO_OUTPUTS, targets, undefined), [result("Debug", "probe")], silent);
    await sendOutputs(routeOutputs(TWO_OUTPUTS, targets, []), [result("Gold", "price")], silent);
    await sendOutputs(routeOutputs(TWO_OUTPUTS, targets, undefined), [], silent);
    assert.equal(calls.length, 0);
});

test("one failing Telegram output doesn't stop the next", async (t) => {
    const calls = stubFetch(t, (url) => (String(url).includes("bot-a")
        ? new Response("Bad Request: chat not found", { status: 400 })
        : new Response("{}")));
    const logger = recordingLogger();
    const routes = routeOutputs(TWO_OUTPUTS, [target("Gold", ["telegram", "telegram-alert"])], undefined);
    await sendOutputs(routes, [result("Gold", "price")], logger);
    assert.deepEqual(sentBots(calls), ["bot-a", "bot-b"]);
    assert.ok(logger.lines.includes("ERROR Failed to send Telegram message: Bad Request: chat not found"));
    assert.ok(logger.lines.includes("INFO Successfully sent Telegram message."));
});

test("a sender that throws is logged and the next output still runs", async (t) => {
    SENDERS.broken = async () => { throw new Error("boom"); };
    t.after(() => { delete SENDERS.broken; });
    const calls = stubFetch(t, () => new Response("{}"));
    const logger = recordingLogger();
    const config = { outputs: { first: { type: "broken" }, second: tg("b") } };
    await sendOutputs(routeOutputs(config, [target("Gold", ["first", "second"])], undefined), [result("Gold", "price")], logger);
    assert.deepEqual(sentBots(calls), ["bot-b"]);
    assert.ok(logger.lines.includes("ERROR Output 'first' failed: boom"));
});

test("a Telegram output whose chat_id resolves empty logs a warning", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const logger = recordingLogger();
    const config = { outputs: { telegram: { type: "telegram", bot_token: "string['tok']", chat_id: "" } } };
    await sendOutputs(routeOutputs(config, [target("Gold", ["telegram"])], undefined), [result("Gold", "price")], logger);
    assert.equal(calls.length, 0);
    assert.ok(logger.lines.includes("WARNING Telegram message not sent: chat_id is empty or could not be resolved."));
});

// ---- DynamoDB ----

const DYNAMO = { type: "dynamodb", table: "set-tri" };
const WITH_DYNAMO = { outputs: { telegram: tg("a"), dynamodb: DYNAMO } };
const NOW = new Date("2026-10-18T02:00:00Z");

test("toDynamoNumber keeps plain numbers and leaves everything else a string", () => {
    assert.equal(toDynamoNumber("1,234.56"), "1234.56");
    assert.equal(toDynamoNumber(" 987.65 "), "987.65");
    assert.equal(toDynamoNumber("+50"), "50");
    assert.equal(toDynamoNumber("-0.25"), "-0.25");
    assert.equal(toDynamoNumber("0"), "0");
    assert.equal(toDynamoNumber(42), "42");
    for (const text of ["17 ต.ค. 2569", "1.2%", "007", "1,23", "12,34.5", ".5", "", "1e5", "9".repeat(39)]) {
        assert.equal(toDynamoNumber(text), null, text);
    }
});

test("routeOutputs: an outputs entry can be { name, ...options }, kept per target", () => {
    const columns = { "BANK TRI": "bank_tri" };
    const targets = [target("SET TRI", ["telegram", { name: "dynamodb", columns }]), target("Gold", ["dynamodb"])];
    const routes = routeOutputs(WITH_DYNAMO, targets, undefined);
    assert.deepEqual([...routes], [
        ["SET TRI", [["telegram", tg("a"), {}], ["dynamodb", DYNAMO, { columns }]]],
        ["Gold", [["dynamodb", DYNAMO, {}]]],
    ]);
    assert.equal(describeRoutes(routes), "SET TRI -> telegram, dynamodb; Gold -> dynamodb");
    // The event's outputs still limit the run; the options come along.
    assert.deepEqual(routeOutputs(WITH_DYNAMO, targets, ["dynamodb"]).get("SET TRI"), [["dynamodb", DYNAMO, { columns }]]);
});

test("routeOutputs: a name and an options entry for one output combine; options given twice are refused", () => {
    const columns = { price: "price" };
    const routes = routeOutputs(WITH_DYNAMO, [target("Gold", ["dynamodb", { name: "dynamodb", columns }, "dynamodb"])], undefined);
    assert.deepEqual(routes.get("Gold"), [["dynamodb", DYNAMO, { columns }]]);
    assert.throws(
        () => routeOutputs(WITH_DYNAMO, [
            target("Gold", [{ name: "dynamodb", columns }]),
            target("Gold", [{ name: "dynamodb", columns }]),
        ], undefined),
        (e) => e instanceof OutputError && e.statusCode === 500
            && e.message === "Target 'Gold': output 'dynamodb' is given options more than once.",
    );
});

test("routeOutputs rejects bad output options (400 from the event, 500 from config) and bad dynamodb definitions (500)", () => {
    const fails = (config, entries, targetsFromEvent, statusCode, message) => assert.throws(
        () => routeOutputs(config, [target("Gold", entries)], undefined, { targetsFromEvent }),
        (e) => e instanceof OutputError && e.statusCode === statusCode && e.message === message,
    );
    const at = "Target 'Gold', output";
    const badColumns = `${at} 'dynamodb': 'columns' must map field names to column names.`;
    fails(WITH_DYNAMO, [{ name: "telegram", columns: {} }], true, 400, `${at} 'telegram': telegram outputs take no options (got columns).`);
    fails(WITH_DYNAMO, [{ name: "dynamodb", columns: { a: "x" }, colums: {} }], false, 500,
        `${at} 'dynamodb': unknown option(s) colums (dynamodb takes 'columns').`);
    fails(WITH_DYNAMO, [{ name: "dynamodb", columns: ["price"] }], true, 400, badColumns);
    fails(WITH_DYNAMO, [{ name: "dynamodb", columns: {} }], true, 400, badColumns);
    fails(WITH_DYNAMO, [{ name: "dynamodb", columns: { price: "" } }], true, 400, badColumns);
    fails(WITH_DYNAMO, [{ name: "dynamodb", columns: { date: "scraped_at" } }], false, 500,
        `${at} 'dynamodb': column 'scraped_at' is one of the table's key attributes.`);
    fails(WITH_DYNAMO, [{ name: "dynamodb", columns: { buy: "price", sell: "price" } }], false, 500,
        `${at} 'dynamodb': more than one field writes column 'price'.`);
    fails(WITH_DYNAMO, [{ columns: {} }], true, 400, "Target 'Gold': 'outputs' must be a list of output names or { \"name\": ... } objects.");
    fails(WITH_DYNAMO, [{ name: "nope" }], true, 400, "Target 'Gold': unknown output name(s): nope");

    const badDefinition = (definition, message) => fails(
        { outputs: { dynamodb: { type: "dynamodb", ...definition } } }, ["dynamodb"], true, 500, `Output 'dynamodb' (dynamodb) ${message}`,
    );
    badDefinition({}, "needs a 'table'.");
    badDefinition({ table: "t", partition_key: "" }, "'partition_key' must be a non-empty string.");
    badDefinition({ table: "t", sort_key: 5 }, "'sort_key' must be a non-empty string, or null for a table without one.");
    badDefinition({ table: "t", sort_key: "target" }, "'partition_key' and 'sort_key' must differ.");
});

test("buildDynamoItems writes one item per target: only the mapped columns with 'columns', every field without", () => {
    const logger = recordingLogger();
    const columns = { date: "as_of", "BANK TRI": "bank_tri", "SET50 TRI": "set50_tri" };
    const items = buildDynamoItems(DYNAMO, [
        result("SET TRI", "date", "17 ต.ค. 2569"),
        result("SET TRI", "BANK TRI", "1,234.56"),
        result("SET TRI", "HELTH TRI", "987.65"),
        result("Gold", "price", "41,250.00"),
        { name: "Gold", value: "up", options: [], target: "Gold" }, // a get without a name
    ], new Map([["SET TRI", { columns }], ["Gold", {}]]), NOW, logger);

    const scrapedAt = { S: "2026-10-18T02:00:00.000Z" };
    assert.deepEqual(items, [
        {
            target: "SET TRI",
            item: { target: { S: "SET TRI" }, scraped_at: scrapedAt, as_of: { S: "17 ต.ค. 2569" }, bank_tri: { N: "1234.56" } },
        },
        { target: "Gold", item: { target: { S: "Gold" }, scraped_at: scrapedAt, price: { N: "41250.00" }, value: { S: "up" } } },
    ]);
    assert.ok(logger.lines.includes("WARNING DynamoDB: no value for 'SET TRI' field(s) SET50 TRI; those columns are left out."));
});

test("buildDynamoItems uses the output's key names; sort_key null leaves the sort key out", () => {
    const output = { type: "dynamodb", table: "latest", partition_key: "id", sort_key: null };
    const logger = recordingLogger();
    const items = buildDynamoItems(output, [result("Gold", "price", "100"), result("Gold", "id", "x")], new Map([["Gold", {}]]), NOW, logger);
    assert.deepEqual(items, [{ target: "Gold", item: { id: { S: "Gold" }, price: { N: "100" } } }]);
    assert.ok(logger.lines.includes("WARNING DynamoDB: 'Gold' field 'id' not written: 'id' is a key attribute."));
});

test("a dynamodb output writes one signed PutItem per target routed to it", async (t) => {
    fakeAws(t);
    const calls = stubFetch(t, () => new Response("{}"));
    const routes = routeOutputs(WITH_DYNAMO, [
        target("SET TRI", ["telegram", { name: "dynamodb", columns: { "BANK TRI": "bank_tri" } }]),
        target("Gold", ["dynamodb"]),
        target("Debug"),
    ], undefined);
    const logger = recordingLogger();
    await sendOutputs(routes, [
        result("SET TRI", "BANK TRI", "1,234.56"),
        result("SET TRI", "HELTH TRI", "987.65"),
        result("Gold", "price", "100"),
        result("Debug", "probe"),
    ], logger);

    const puts = calls.filter(({ url }) => url.startsWith("https://dynamodb."));
    assert.deepEqual(puts.map(({ url }) => url), Array(2).fill("https://dynamodb.ap-southeast-7.amazonaws.com/"));
    const { headers } = puts[0].init;
    assert.equal(headers["x-amz-target"], "DynamoDB_20120810.PutItem");
    assert.equal(headers["content-type"], "application/x-amz-json-1.0");
    assert.match(headers.authorization, /\/ap-southeast-7\/dynamodb\/aws4_request, /);
    const [setTri, gold] = puts.map(({ init }) => JSON.parse(init.body));
    assert.equal(setTri.TableName, "set-tri");
    assert.deepEqual(Object.keys(setTri.Item), ["target", "scraped_at", "bank_tri"]);
    assert.deepEqual(setTri.Item.bank_tri, { N: "1234.56" });
    assert.deepEqual(Object.keys(gold.Item), ["target", "scraped_at", "price"]);

    // Telegram still gets every SET TRI field: columns only shape the DynamoDB item.
    const telegram = calls.find(({ url }) => url.includes("api.telegram.org"));
    assert.equal(JSON.parse(telegram.init.body).text, "SET TRI - BANK TRI\n<pre>1,234.56</pre>\nSET TRI - HELTH TRI\n<pre>987.65</pre>");
    assert.ok(logger.lines.includes("INFO Wrote 2 item(s) to DynamoDB table 'set-tri'."));
});

test("a failing PutItem is logged and the next target is still written; 'region' picks the table's region", async (t) => {
    fakeAws(t);
    const calls = stubFetch(t, (url, init) => (JSON.parse(init.body).Item.target.S === "SET TRI"
        ? new Response(JSON.stringify({
            __type: "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException",
            message: "Requested resource not found",
        }), { status: 400 })
        : new Response("{}")));
    const config = { outputs: { dynamodb: { ...DYNAMO, region: "us-east-1" } } };
    const routes = routeOutputs(config, [target("SET TRI", ["dynamodb"]), target("Gold", ["dynamodb"])], undefined);
    const logger = recordingLogger();
    await sendOutputs(routes, [result("SET TRI", "BANK TRI"), result("Gold", "price")], logger);

    assert.deepEqual(calls.map(({ url }) => url), Array(2).fill("https://dynamodb.us-east-1.amazonaws.com/"));
    assert.ok(logger.lines.includes(
        "ERROR Failed to write 'SET TRI' to DynamoDB table 'set-tri': ResourceNotFoundException: Requested resource not found",
    ));
    assert.ok(logger.lines.includes("INFO Wrote 1 item(s) to DynamoDB table 'set-tri'."));
});

test("lambda handler rejects bad dynamodb columns in event targets with 400 before scraping", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const { status, body } = await call(t, JSON.stringify({ ...WITH_DYNAMO, targets: [] }), {
        targets: [target("Gold", [{ name: "dynamodb", columns: { price: "scraped_at" } }])],
    });
    assert.equal(status, 400);
    assert.equal(body.error, "Target 'Gold', output 'dynamodb': column 'scraped_at' is one of the table's key attributes.");
    assert.equal(calls.length, 0);
});

test("lambda handler rejects bad 'outputs' before scraping", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const config = JSON.stringify({ ...TWO_OUTPUTS, targets: TARGETS });
    for (const [outputs, error] of [
        [["nope"], "Unknown output name(s): nope"],
        ["telegram-alert", "'outputs' must be a list of output names."],
        [[42], "'outputs' must be a list of output names."],
    ]) {
        const { status, body } = await call(t, config, { outputs });
        assert.equal(status, 400);
        assert.equal(body.error, error);
    }
    assert.equal(calls.length, 0);
});

test("lambda handler rejects unknown output names in event targets (400) and config targets (500)", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const fromEvent = await call(t, JSON.stringify({ ...TWO_OUTPUTS, targets: [] }), { targets: [target("Gold", ["nope"])] });
    assert.equal(fromEvent.status, 400);
    assert.equal(fromEvent.body.error, "Target 'Gold': unknown output name(s): nope");

    const fromConfig = await call(t, JSON.stringify({ ...TWO_OUTPUTS, targets: [target("Gold", ["nope"])] }), {});
    assert.equal(fromConfig.status, 500);
    assert.equal(fromConfig.body.error, "Target 'Gold': unknown output name(s): nope");
    assert.equal(calls.length, 0);
});

test("HTTP requests can only name configured outputs", async (t) => {
    const config = JSON.stringify({ ...JSON.parse(API_CONFIG), ...TWO_OUTPUTS });
    const body = JSON.stringify({ only: ["Gold"], outputs: ["https://attacker.test"] });
    const { status, body: res } = await call(t, config, httpEvent({ key: "test-key", body }));
    assert.equal(status, 400);
    assert.equal(res.error, "Unknown output name(s): https://attacker.test");
});

test("an unknown output type in config fails with 500 before scraping", async (t) => {
    const config = JSON.stringify({ http_api_key: "string['test-key']", outputs: { x: { type: "pigeon" } }, targets: TARGETS });
    const scheduled = await call(t, config, {});
    assert.equal(scheduled.status, 500);
    assert.match(scheduled.body.error, /^Output 'x' has unknown type 'pigeon'/);
    // HTTP callers get the generic error; the details stay in the logs.
    const viaHttp = await call(t, config, httpEvent({ key: "test-key" }));
    assert.equal(viaHttp.status, 500);
    assert.deepEqual(viaHttp.body, { error: "Internal error." });
});

test("every refused invocation writes a log line", async (t) => {
    const lines = captureConsole(t);
    const config = JSON.stringify({ ...TWO_OUTPUTS, targets: TARGETS });
    const cases = [
        [config, { only: [] }, 400],
        [config, { only: ["Nope"] }, 400],
        [config, { outputs: ["nope"] }, 400],
        [JSON.stringify({ outputs: { x: { type: "pigeon" } }, targets: TARGETS }), {}, 500],
        [JSON.stringify({ targets: [] }), {}, 400],
        [API_CONFIG, httpEvent({ key: "test-key", body: "{oops" }), 400],
        [API_CONFIG, httpEvent({ key: "test-key", body: JSON.stringify({ targets: TARGETS }) }), 400],
        [API_CONFIG, httpEvent({ key: "wrong" }), 401],
        [config, { body: JSON.stringify({ targets: TARGETS }) }, 400],
        [API_CONFIG, { targets: TARGETS }, 400],
        [JSON.stringify({ ...TWO_OUTPUTS, targets: [] }), { targets: [target("Gold", ["nope"])] }, 400],
    ];
    for (const [cfg, event, expected] of cases) {
        lines.length = 0;
        // WARNING, not ERROR: a wrong x-api-key is logged as a warning.
        const { status } = await call(t, cfg, event, "WARNING");
        assert.equal(status, expected);
        assert.ok(lines.some((l) => /\[(ERROR|WARNING)\]/.test(l)), `no log line for ${JSON.stringify(event)}`);
    }

    lines.length = 0;
    withEnv(t, { CONFIG_JSON: undefined, CONFIG_FILE: "does-not-exist.json" });
    assert.equal((await handler({})).statusCode, 500);
    assert.ok(lines.some((l) => l.includes("[ERROR]") && l.includes("Configuration not found")));
});

// ---- Google Sheets ----

const { privateKey: RSA_KEY, publicKey: RSA_PUBLIC_KEY } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = RSA_KEY.export({ type: "pkcs8", format: "pem" });
const ESCAPED_PEM = PRIVATE_PEM.replace(/\n/g, "\\n"); // as the Secrets Manager console often stores it
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEET_URL = "https://sheets.googleapis.com/v4/spreadsheets/sheet-123";
const APPEND = "valueInputOption=RAW&insertDataOption=INSERT_ROWS";
const THAI_TAB = "ราคา ทอง (บาท)";
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A google_sheets output. Tokens are cached per client_email, so each test passes its own account. */
const sheetsOutput = (account, extra = {}) => ({
    type: "google_sheets",
    spreadsheet_id: "sheet-123",
    client_email: `${account}@mpt-test.iam.gserviceaccount.com`,
    private_key: PRIVATE_PEM,
    tab: "prices",
    ...extra,
});
const SHEETS = sheetsOutput("validation", { private_key: "secret_manager['google-sheets']['GOOGLE_PRIVATE_KEY']" });
const WITH_SHEETS = { outputs: { telegram: tg("a"), sheets: SHEETS } };
const { tab: _, ...SHEETS_NO_TAB } = SHEETS;

/**
 * Stub Google: the token endpoint issues ya29.test-token-1, -2, ...; the
 * Sheets API lists the tabs in `headers` (tab -> row 1, [] when empty) and
 * answers row-1 reads from it; writes succeed. `respond(url, init)` answers
 * first when it returns a Response. Returns the recorded calls.
 */
function stubGoogle(t, headers, respond = () => null) {
    let issued = 0;
    return stubFetch(t, (url, init) => {
        const href = String(url);
        const answer = respond(href, init);
        if (answer) return answer;
        if (href === TOKEN_URL) return json({ access_token: `ya29.test-token-${++issued}`, expires_in: 3599, token_type: "Bearer" });
        const rest = href.slice(SHEET_URL.length);
        if (rest === "?fields=sheets.properties.title") {
            return json({ sheets: Object.keys(headers).map((title) => ({ properties: { title } })) });
        }
        if (init.method !== "GET") return json({});
        const range = decodeURIComponent(rest.slice("/values/".length));
        const header = headers[/^'(.*)'!1:1$/.exec(range)[1].replace(/''/g, "'")];
        return json(header.length > 0 ? { range, majorDimension: "ROWS", values: [header] } : { range, majorDimension: "ROWS" });
    });
}

/** The recorded Sheets calls as [method, decoded path and query, body?], with ISO timestamps shown as "<now>". */
const sheetsRequests = (calls) => calls.filter(({ url }) => url.startsWith(SHEET_URL)).map(({ url, init }) => {
    const call = [init.method, decodeURIComponent(url.slice(SHEET_URL.length))];
    if (init.body === undefined) return call;
    return [...call, JSON.parse(init.body, (k, v) => (typeof v === "string" && ISO_TIME.test(v) ? "<now>" : v))];
});

test("serviceAccountJwt signs an RS256 JWT for the Sheets scope; a key with escaped \\n works", () => {
    const now = Date.parse("2026-10-18T02:00:00Z");
    const email = "jwt@mpt-test.iam.gserviceaccount.com";
    for (const key of [PRIVATE_PEM, ESCAPED_PEM]) {
        const [header, claims, signature] = serviceAccountJwt(email, key, now).split(".");
        assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
        assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
            iss: email,
            scope: "https://www.googleapis.com/auth/spreadsheets",
            aud: "https://oauth2.googleapis.com/token",
            iat: now / 1000,
            exp: now / 1000 + 3600,
        });
        assert.ok(crypto.verify("sha256", Buffer.from(`${header}.${claims}`), RSA_PUBLIC_KEY, Buffer.from(signature, "base64url")));
    }
    assert.throws(() => serviceAccountJwt(email, "not a key", now), /^Error: private_key is not a valid PEM private key\.$/);
});

test("accessToken is cached per client_email and refreshed 5 minutes before it expires", async (t) => {
    let issued = 0;
    const calls = stubFetch(t, () => json({ access_token: `tok-${++issued}`, expires_in: 3600, token_type: "Bearer" }));
    const email = "cache@mpt-test.iam.gserviceaccount.com";
    const t0 = Date.parse("2026-10-18T02:00:00Z");
    assert.equal(await accessToken(email, PRIVATE_PEM, t0), "tok-1");
    assert.equal(await accessToken(email, PRIVATE_PEM, t0 + 54 * 60_000), "tok-1");
    assert.equal(await accessToken(email, PRIVATE_PEM, t0 + 55 * 60_000), "tok-2");
    assert.equal(await accessToken("other@mpt-test.iam.gserviceaccount.com", PRIVATE_PEM, t0 + 55 * 60_000), "tok-3");

    assert.equal(calls.length, 3);
    const [{ url, init }] = calls;
    assert.equal(url, TOKEN_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(form.get("assertion"), serviceAccountJwt(email, PRIVATE_PEM, t0));
});

test("googleErrorMessage reads both Google error shapes", () => {
    assert.equal(
        googleErrorMessage(400, JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." })),
        "invalid_grant: Invalid JWT Signature.",
    );
    assert.equal(
        googleErrorMessage(404, JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } })),
        "NOT_FOUND: Requested entity was not found.",
    );
    assert.equal(googleErrorMessage(502, "<html>Bad Gateway</html>"), "HTTP 502: <html>Bad Gateway</html>");
});

test("A1 helpers: column letters, and tab names quoted with ' doubled", () => {
    assert.deepEqual([0, 25, 26, 51, 701, 702].map((i) => columnLetters(i)), ["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
    assert.equal(a1Range("prices", "A1"), "'prices'!A1");
    assert.equal(a1Range("Bob's (gold)", "1:1"), "'Bob''s (gold)'!1:1");
    assert.equal(a1Range(THAI_TAB, "A1:E1"), "'ราคา ทอง (บาท)'!A1:E1");
});

test("toSheetsCell writes plain numbers as numbers, up to the 15 digits Sheets keeps", () => {
    assert.equal(toSheetsCell("66,100.00"), 66100);
    assert.equal(toSheetsCell("+50"), 50);
    assert.equal(toSheetsCell("-0.25"), -0.25);
    assert.equal(toSheetsCell("123456789012345"), 123456789012345);
    for (const text of ["1234567890123456", "17 ต.ค. 2569", "1.2%", "007", "=1+1", ""]) {
        assert.equal(toSheetsCell(text), text, text);
    }
});

test("buildSheetsRecords: only the mapped fields with 'columns', every field without; missing values are warned", () => {
    const logger = recordingLogger();
    const records = buildSheetsRecords([
        result("Gold", "ทองคำแท่ง ขายออก", "66,100.00"),
        result("Gold", "วันที่", "18 ต.ค. 2569"),
        result("Gold", "Gold spot", "2,401.5"), // not mapped
        result("SET TRI", "BANK TRI", "1,234.56"),
        result("SET TRI", "pct", "1.2%"),
        result("SET TRI", "code", "007"),
        result("SET TRI", "target", "x"), // reserved
        { name: "SET TRI", value: "up", options: [], target: "SET TRI" }, // a get without a name
        result("Empty", "price", "1"),
    ], new Map([
        ["Gold", { columns: { "ทองคำแท่ง รับซื้อ": "bar_buy", "ทองคำแท่ง ขายออก": "bar_sell", "วันที่": "date" } }],
        ["SET TRI", {}],
        ["Empty", { columns: { volume: "volume" } }],
    ]), NOW, logger);

    const scrapedAt = "2026-10-18T02:00:00.000Z";
    assert.deepEqual(records.map(({ target, record }) => [target, [...record]]), [
        ["Gold", [["scraped_at", scrapedAt], ["target", "Gold"], ["bar_sell", 66100], ["date", "18 ต.ค. 2569"]]],
        ["SET TRI", [
            ["scraped_at", scrapedAt], ["target", "SET TRI"], ["BANK TRI", 1234.56], ["pct", "1.2%"], ["code", "007"], ["value", "up"],
        ]],
    ]);
    assert.ok(logger.lines.includes("WARNING Google Sheets: no value for 'Gold' field(s) ทองคำแท่ง รับซื้อ; those cells are left empty."));
    assert.ok(logger.lines.includes("WARNING Google Sheets: 'SET TRI' field 'target' not written: 'target' is a reserved column."));
    assert.ok(logger.lines.includes("WARNING Google Sheets: no value for 'Empty' field(s) volume; those cells are left empty."));
});

test("placeRecord puts cells under their header names and adds missing names to the end", () => {
    const record = new Map([["scraped_at", "now"], ["target", "Gold"], ["price", 1], ["new", "x"]]);
    // Existing headers keep their places; a repeated name uses its first column.
    assert.deepEqual(placeRecord(["target", "note", "price", "scraped_at", "price"], record), {
        added: ["new"],
        row: ["Gold", "", 1, "now", "", "x"],
    });
    assert.deepEqual(placeRecord([], record), { added: ["scraped_at", "target", "price", "new"], row: ["now", "Gold", 1, "x"] });
});

test("google_sheets checks: tab and columns per target (400 from the event, 500 from config), required fields (500)", () => {
    const fails = (config, entries, targetsFromEvent, statusCode, message) => assert.throws(
        () => routeOutputs(config, [target("Gold", entries)], undefined, { targetsFromEvent }),
        (e) => e instanceof OutputError && e.statusCode === statusCode && e.message === message,
    );
    const at = "Target 'Gold', output 'sheets':";
    const noTab = `${at} needs a 'tab', on the target's entry or on the output.`;
    fails(WITH_SHEETS, [{ name: "sheets", colums: {} }], true, 400, `${at} unknown option(s) colums (google_sheets takes 'tab' and 'columns').`);
    fails(WITH_SHEETS, [{ name: "sheets", tab: "" }], false, 500, `${at} 'tab' must be a non-empty string.`);
    fails(WITH_SHEETS, [{ name: "sheets", columns: {} }], true, 400, `${at} 'columns' must map field names to column names.`);
    fails(WITH_SHEETS, [{ name: "sheets", columns: { price: "target" } }], true, 400,
        `${at} column 'target' is reserved (every row starts with scraped_at and target).`);
    fails(WITH_SHEETS, [{ name: "sheets", columns: { buy: "price", sell: "price" } }], false, 500,
        `${at} more than one field writes column 'price'.`);

    const withoutTab = { outputs: { sheets: SHEETS_NO_TAB } };
    fails(withoutTab, ["sheets"], false, 500, noTab);
    fails(withoutTab, [{ name: "sheets", columns: { price: "price" } }], true, 400, noTab);
    assert.deepEqual(
        routeOutputs(withoutTab, [target("Gold", [{ name: "sheets", tab: "gold" }])], undefined).get("Gold"),
        [["sheets", SHEETS_NO_TAB, { tab: "gold" }]],
    );

    const badDefinition = (definition, message) => fails(
        { outputs: { sheets: { ...SHEETS, ...definition } } }, ["sheets"], true, 500, `Output 'sheets' (google_sheets) ${message}`,
    );
    badDefinition({ spreadsheet_id: undefined }, "needs a 'spreadsheet_id'.");
    badDefinition({ client_email: "" }, "needs a 'client_email'.");
    badDefinition({ private_key: 42 }, "needs a 'private_key'.");
    badDefinition({ tab: "" }, "'tab' must be a non-empty string.");
});

test("lambda handler rejects a google_sheets route without a tab: 400 from the event, 500 from config", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const outputs = { sheets: SHEETS_NO_TAB };
    const error = "Target 'Gold', output 'sheets': needs a 'tab', on the target's entry or on the output.";
    const fromEvent = await call(t, JSON.stringify({ outputs, targets: [] }), { targets: [target("Gold", ["sheets"])] });
    assert.equal(fromEvent.status, 400);
    assert.equal(fromEvent.body.error, error);
    const fromConfig = await call(t, JSON.stringify({ outputs, targets: [target("Gold", ["sheets"])] }), {});
    assert.equal(fromConfig.status, 500);
    assert.equal(fromConfig.body.error, error);
    assert.equal(calls.length, 0);
});

test("a google_sheets output appends one row per target, placed under row 1's names", async (t) => {
    const calls = stubGoogle(t, { prices: ["target", "scraped_at", "", "BANK TRI"], [THAI_TAB]: [], other: ["x"] });
    const columns = { "วันที่": "date", "ทองคำแท่ง รับซื้อ": "bar_buy", "ทองคำแท่ง ขายออก": "bar_sell" };
    const config = { outputs: { sheets: sheetsOutput("append", { private_key: ESCAPED_PEM }) } };
    const routes = routeOutputs(config, [
        target("Gold", [{ name: "sheets", tab: THAI_TAB, columns }]),
        target("SET TRI", ["sheets"]),
        target("Debug"),
    ], undefined);
    const logger = recordingLogger();
    await sendOutputs(routes, [
        result("Gold", "วันที่", "18 ต.ค. 2569"),
        result("Gold", "ทองคำแท่ง รับซื้อ", "65,900.00"),
        result("Gold", "ทองคำแท่ง ขายออก", "66,100.00"),
        result("Gold", "เปลี่ยนแปลงวันนี้", "+50"),
        result("SET TRI", "BANK TRI", "1,234.56"),
        result("SET TRI", "HELTH TRI", "987.65"),
        result("SET TRI", "code", "007"),
        result("Debug", "probe"),
    ], logger);

    const thai = `'${THAI_TAB}'`;
    assert.deepEqual(sheetsRequests(calls), [
        ["GET", "?fields=sheets.properties.title"],
        // Row 1 of the Thai tab is empty, so the header is written first.
        ["GET", `/values/${thai}!1:1`],
        ["PUT", `/values/${thai}!A1:E1?valueInputOption=RAW`, { values: [["scraped_at", "target", "date", "bar_buy", "bar_sell"]] }],
        ["POST", `/values/${thai}!A1:append?${APPEND}`, { values: [["<now>", "Gold", "18 ต.ค. 2569", 65900, 66100]] }],
        // 'prices' has a header: values go under their names, and new names are added to its end.
        ["GET", "/values/'prices'!1:1"],
        ["PUT", "/values/'prices'!E1:F1?valueInputOption=RAW", { values: [["HELTH TRI", "code"]] }],
        ["POST", `/values/'prices'!A1:append?${APPEND}`, { values: [["SET TRI", "<now>", "", 1234.56, 987.65, "007"]] }],
    ]);

    // The range is quoted, then URL-encoded: no raw spaces or Thai in the URL.
    const append = calls.find(({ url }) => url.includes(":append") && !url.includes("prices"));
    assert.match(append.url, /^[\x21-\x7e]+$/);
    assert.ok(append.url.endsWith(`%20(%E0%B8%9A%E0%B8%B2%E0%B8%97)'!A1:append?${APPEND}`), append.url);
    for (const { url, init } of calls.filter((c) => c.url.startsWith(SHEET_URL))) {
        assert.equal(init.headers.authorization, "Bearer ya29.test-token-1", url);
        if (init.body !== undefined) assert.equal(init.headers["content-type"], "application/json", url);
    }
    assert.equal(calls.filter(({ url }) => url === TOKEN_URL).length, 1);
    assert.ok(logger.lines.includes("INFO Appended 2 row(s) to Google Sheet sheet-123."));
});

test("the access token is reused across sends, and dropped after a 401", async (t) => {
    let unauthorized = false;
    const calls = stubGoogle(t, { prices: ["scraped_at", "target", "price"] }, (url) => (
        unauthorized && url.endsWith("?fields=sheets.properties.title")
            ? json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401)
            : null));
    const routes = routeOutputs({ outputs: { sheets: sheetsOutput("reuse") } }, [target("Gold", ["sheets"])], undefined);
    const logger = recordingLogger();
    const send = () => sendOutputs(routes, [result("Gold", "price", "100")], logger);

    await send();
    await send();
    unauthorized = true;
    await send();
    unauthorized = false;
    await send();

    assert.equal(calls.filter(({ url }) => url === TOKEN_URL).length, 2);
    const bearers = calls.filter(({ url }) => url.startsWith(SHEET_URL)).map(({ init }) => init.headers.authorization);
    assert.deepEqual([...new Set(bearers)], ["Bearer ya29.test-token-1", "Bearer ya29.test-token-2"]);
    assert.ok(logger.lines.includes(
        "ERROR Failed to read Google Sheet sheet-123: UNAUTHENTICATED: Request had invalid authentication credentials.",
    ));
    assert.equal(logger.lines.filter((l) => l === "INFO Appended 1 row(s) to Google Sheet sheet-123.").length, 3);
});

test("one failing target is logged and the next is still appended; a missing tab is reported, not created", async (t) => {
    const calls = stubGoogle(t, { prices: ["scraped_at", "target", "price"], locked: [] }, (url, init) => (
        init.method === "PUT" && url.includes("locked")
            ? json({ error: { code: 403, message: "You are trying to edit a protected cell or object.", status: "PERMISSION_DENIED" } }, 403)
            : null));
    const routes = routeOutputs({ outputs: { sheets: sheetsOutput("failures") } }, [
        target("Locked", [{ name: "sheets", tab: "locked" }]),
        target("Gone", [{ name: "sheets", tab: "gold" }]),
        target("Gold", ["sheets"]),
    ], undefined);
    const logger = recordingLogger();
    await sendOutputs(routes, [result("Locked", "price"), result("Gone", "price"), result("Gold", "price")], logger);

    assert.ok(logger.lines.includes(
        "ERROR Failed to append 'Locked' to Google Sheet sheet-123: PERMISSION_DENIED: You are trying to edit a protected cell or object.",
    ));
    assert.ok(logger.lines.includes(
        "ERROR Failed to append 'Gone' to Google Sheet sheet-123: tab 'gold' doesn't exist (tabs: prices, locked). Create it first.",
    ));
    assert.ok(logger.lines.includes("INFO Appended 1 row(s) to Google Sheet sheet-123."));
    // Only the 'prices' row is appended, and nothing else is posted (no tab is created).
    const posts = sheetsRequests(calls).filter(([method]) => method === "POST");
    assert.deepEqual(posts.map(([, rest]) => rest), [`/values/'prices'!A1:append?${APPEND}`]);
});

test("Google errors are readable, with a sharing hint, and no log line carries a secret", async (t) => {
    let tokenRefused = true;
    let shared = false;
    const calls = stubGoogle(t, { prices: [] }, (url) => {
        if (url === TOKEN_URL && tokenRefused) return json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400);
        if (url.endsWith("?fields=sheets.properties.title") && !shared) {
            return json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403);
        }
        return null;
    });
    const output = sheetsOutput("secrets", { private_key: ESCAPED_PEM });
    const routes = routeOutputs({ outputs: { sheets: output } }, [target("Gold", ["sheets"])], undefined);
    const logger = recordingLogger();
    const send = () => sendOutputs(routes, [result("Gold", "price", "100")], logger);

    await send();
    tokenRefused = false;
    await send();
    shared = true;
    await send();

    assert.ok(logger.lines.includes(
        "ERROR Failed to read Google Sheet sheet-123: Google token request failed: invalid_grant: Invalid JWT Signature.",
    ));
    assert.ok(logger.lines.includes(
        "ERROR Failed to read Google Sheet sheet-123: PERMISSION_DENIED: The caller does not have permission "
        + `(is the sheet shared with ${output.client_email}?)`,
    ));
    assert.ok(logger.lines.includes("INFO Appended 1 row(s) to Google Sheet sheet-123."));

    const jwts = calls.filter(({ url }) => url === TOKEN_URL).map(({ init }) => new URLSearchParams(init.body).get("assertion"));
    assert.equal(jwts.length, 2);
    const secrets = ["PRIVATE KEY", PRIVATE_PEM.split("\n")[1], ...jwts, "ya29."];
    for (const line of logger.lines) {
        for (const secret of secrets) assert.ok(!line.includes(secret), `secret in log line: ${line}`);
    }
});

// ---- Hardening ----

test("looksLikeHttpRequest flags request-style events only", () => {
    assert.equal(looksLikeHttpRequest(httpEvent()), true);
    assert.equal(looksLikeHttpRequest({ body: "{}" }), true);
    assert.equal(looksLikeHttpRequest({ targets: [], only: ["Gold"], outputs: [] }), false);
    assert.equal(looksLikeHttpRequest({ source: "aws.events", "detail-type": "Scheduled Event", detail: {} }), false);
    assert.equal(looksLikeHttpRequest(undefined), false);
    assert.equal(looksLikeHttpRequest(null), false);
});

test("request-style events that aren't a supported HTTP shape are refused", async (t) => {
    const calls = stubFetch(t, () => new Response("{}"));
    const config = JSON.stringify({ targets: TARGETS });
    for (const event of [
        // API Gateway WebSocket: requestContext without http/httpMethod, so no x-api-key check would run.
        { requestContext: { routeKey: "$default", connectionId: "abc", eventType: "MESSAGE" }, body: "{}" },
        // VPC Lattice
        { method: "POST", raw_path: "/", headers: { "x-api-key": "k" }, body: "{}" },
        { headers: {}, body: JSON.stringify({ targets: TARGETS }) },
    ]) {
        const { status, body } = await call(t, config, event);
        assert.equal(status, 400);
        assert.match(body.error, /^Unsupported HTTP event/);
    }
    assert.equal(calls.length, 0);
});

test("event 'targets' are refused on HTTP-facing functions unless allow_event_targets is set", async (t) => {
    // What an API Gateway non-proxy mapping would hand over from a request body.
    const event = { targets: [{ name: "evil", url: "https://attacker.test", actions: [{ type: "get", script: "return 1" }] }] };
    const refused = await call(t, API_CONFIG, event);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /^'targets' in the event is disabled for this function/);

    const optedOut = JSON.stringify({ allow_event_targets: "false", targets: TARGETS });
    assert.equal((await call(t, optedOut, event)).status, 400);

    // Opting in lets the event through to the usual checks.
    const optedIn = JSON.stringify({ http_api_key: "string['test-key']", allow_event_targets: true, targets: [] });
    assert.deepEqual((await call(t, optedIn, { targets: [] })).body, { error: "No targets configured." });
});

test("browserLaunchOptions keeps the Chromium sandbox on locally and off on Lambda", (t) => {
    withEnv(t, { AWS_LAMBDA_FUNCTION_NAME: undefined });
    const local = browserLaunchOptions({ headless: "false" });
    assert.equal(local.chromiumSandbox, true);
    assert.equal(local.headless, false);
    assert.ok(!local.args.includes("--no-sandbox"));
    assert.equal(browserLaunchOptions({ chromium_sandbox: "false" }).chromiumSandbox, false);

    withEnv(t, { AWS_LAMBDA_FUNCTION_NAME: "mpt-staging-scraper-cronjob" });
    const lambda = browserLaunchOptions({ headless: false, chromium_sandbox: true });
    assert.equal(lambda.chromiumSandbox, false);
    assert.equal(lambda.headless, true);
    assert.ok(lambda.args.includes("--no-sandbox"));
    assert.equal(lambda.env.HOME, "/tmp");
});
