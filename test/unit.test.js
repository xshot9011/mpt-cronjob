import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildSwitchPathUrl } from "../src/actions.js";
import { setAwsRegion } from "../src/aws.js";
import { browserLaunchOptions } from "../src/browser.js";
import { buildDynamoItems, toDynamoNumber } from "../src/dynamodb.js";
import { apiKeyMatches, isHttpEvent, looksLikeHttpRequest, parseJsonBody } from "../src/http.js";
import { handler } from "../src/lambda.js";
import { OutputError, SENDERS, configuredOutputs, describeRoutes, routeOutputs, sendOutputs } from "../src/outputs.js";
import { parseDuration, resolveValue } from "../src/resolve.js";
import { normalizeUrl } from "../src/scraper.js";
import { getSecret } from "../src/secrets.js";
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
