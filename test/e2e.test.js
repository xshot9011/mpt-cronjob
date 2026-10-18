// Drives a real headless Chromium against a local fixture page (no network).
// Needs the browser: npm run browser:install
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { handler } from "../src/lambda.js";
import { runAll } from "../src/scraper.js";

const FIXTURE_URL = new URL("./fixtures/page.html", import.meta.url).href;
const browserMissing = !fs.existsSync(chromium.executablePath())
    && "Chromium is not installed: run `npm run browser:install`";

process.env.LOG_FILE = path.join(os.tmpdir(), "mpt-cronjob-test.log");
process.env.LOG_LEVEL = "ERROR";

test("runAll runs every action type against a real page", { skip: browserMissing, timeout: 120_000 }, async () => {
    const results = await runAll({
        headless: true,
        wait_timeout: 0,
        action_wait: 0,
        targets: [{
            name: "Fixture",
            url: FIXTURE_URL,
            actions: [
                { type: "get", name: "title", script: "return document.title" },
                { type: "fill", xpath: "//input[@id='username']", value_from: "string['my_test_user']" },
                { type: "get", name: "username", script: "return document.getElementById('username').value" },
                { type: "click", xpath: "//button[@id='btn']" },
                { type: "click", script: "document.getElementById('btn').click();" },
                { type: "get", name: "clicks", xpath: "//p[@id='count']" },
                { type: "get", name: "inside_iframe", xpath: "//p[@id='inner']", iframe_title: "Inner frame" },
                { type: "get", name: "awaited", script: "await new Promise((r) => setTimeout(r, 10)); return 42" },
                { type: "get", name: "no_codeblock", xpath: "//h1", telegram_message_options: ["--no-codeblock"] },
                { type: "sleep", duration: "0.2s" },
                { type: "click", script: "throw new Error('soft failure')", continue_on_failure: "true" },
                { type: "get", name: "after_soft_failure", xpath: "//h1" },
                { type: "click", script: "throw new Error('hard failure')", continue_on_failure: "false" },
                { type: "get", name: "never_reached", script: "return 'nope'" },
            ],
        }],
    });

    assert.deepEqual(results, [
        { name: "Fixture - title", value: "Fixture Page", options: [], target: "Fixture", field: "title" },
        { name: "Fixture - username", value: "my_test_user", options: [], target: "Fixture", field: "username" },
        { name: "Fixture - clicks", value: "Clicks: 2", options: [], target: "Fixture", field: "clicks" },
        { name: "Fixture - inside_iframe", value: "Inside the frame", options: [], target: "Fixture", field: "inside_iframe" },
        { name: "Fixture - awaited", value: "42", options: [], target: "Fixture", field: "awaited" },
        { name: "Fixture - no_codeblock", value: "Fixture", options: ["--no-codeblock"], target: "Fixture", field: "no_codeblock" },
        { name: "Fixture - after_soft_failure", value: "Fixture", options: [], target: "Fixture", field: "after_soft_failure" },
    ]);
});

test("lambda handler uses event.targets over the configured ones", { skip: browserMissing, timeout: 60_000 }, async (t) => {
    withLambdaConfig(t, { headless: true, wait_timeout: 0, action_wait: 0, targets: [] });

    const result = await handler({
        targets: [{ name: "Fixture", url: FIXTURE_URL, actions: [{ type: "get", name: "h1", xpath: "//h1" }] }],
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { message: "Scraping completed successfully.", results: 1 });
});

test("an authorized HTTP request runs only the named target and returns its values", { skip: browserMissing, timeout: 60_000 }, async (t) => {
    withLambdaConfig(t, {
        headless: true,
        wait_timeout: 0,
        action_wait: 0,
        http_api_key: "string['test-key']",
        targets: [
            { name: "Fixture", url: FIXTURE_URL, actions: [{ type: "get", name: "h1", xpath: "//h1" }] },
            { name: "Not requested", url: FIXTURE_URL, actions: [{ type: "get", name: "title", script: "return document.title" }] },
        ],
    });

    const result = await handler({
        version: "2.0",
        requestContext: { http: { method: "POST" } },
        headers: { "x-api-key": "test-key", "content-type": "application/json" },
        body: JSON.stringify({ only: ["Fixture"] }),
        isBase64Encoded: false,
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { results: [{ name: "Fixture - h1", value: "Fixture" }] });
});

test("lambda handler sends each target's results to the outputs that target names", { skip: browserMissing, timeout: 60_000 }, async (t) => {
    withLambdaConfig(t, {
        headless: true,
        wait_timeout: 0,
        action_wait: 0,
        outputs: {
            telegram: { type: "telegram", bot_token: "string['bot-main']", chat_id: "string['chat-main']" },
            "telegram-alert": { type: "telegram", bot_token: "string['bot-alert']", chat_id: "string['chat-alert']" },
        },
        targets: [],
    });
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, init) => {
        sent.push({ url: String(url), text: JSON.parse(init.body).text });
        return new Response("{}");
    };
    t.after(() => { globalThis.fetch = realFetch; });

    // The shape a terragrunt cronjob sends: targets in the event, each naming its outputs.
    const result = await handler({
        targets: [
            { name: "Alerted", url: FIXTURE_URL, actions: [{ type: "get", name: "h1", xpath: "//h1" }], outputs: ["telegram-alert"] },
            { name: "Logged only", url: FIXTURE_URL, actions: [{ type: "get", name: "title", script: "return document.title" }] },
        ],
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(sent, [{ url: "https://api.telegram.org/botbot-alert/sendMessage", text: "Alerted - h1\n<pre>Fixture</pre>" }]);
});

/**
 * Point the handler at `config` for one test. Also clears the TELEGRAM_*
 * fallbacks so a test never messages a real chat.
 */
function withLambdaConfig(t, config) {
    const vars = { CONFIG_JSON: JSON.stringify(config), TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined };
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const apply = (values) => {
        for (const [k, v] of Object.entries(values)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    apply(vars);
    t.after(() => apply(saved));
}
