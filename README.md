# mpt-cronjob

A Playwright-based web scraper written in Node.js. It runs locally (macOS/Linux) and on AWS Lambda as a container image.

## 🚀 Overview

- **Engine**: Official [Playwright](https://playwright.dev/) (Microsoft) driving Chromium.
- **Runs on**:
  - **Local**: run manually, or schedule it with macOS `launchd`.
  - **Cloud**: AWS Lambda container image (`public.ecr.aws/lambda/nodejs`), scheduled by EventBridge.
- **Dynamic config**: targets and actions come from a JSON file or an environment variable.
- **Integrations**: AWS Secrets Manager, Telegram, DynamoDB, Google Sheets, CapSolver.

> **Note on Cloudflare:** running headless from an AWS/Lambda datacenter IP is the
> weakest position against Cloudflare's managed challenges. The scraper tries to
> look like a normal browser rather than patch over tells: it runs the full
> Chromium build in headless mode, keeps the browser's own User-Agent (with
> `HeadlessChrome` changed to `Chrome`), sets
> `--disable-blink-features=AutomationControlled`, and moves the mouse. When a
> page opens on Cloudflare's "Just a moment..." challenge, it waits for the
> challenge to clear (`challenge_timeout`), then retries in a fresh browser
> context (`challenge_retries`). A target that stays blocked logs
> `Blocked by a Cloudflare challenge` and skips its actions. It also supports an
> optional residential `proxy` and a persisted `storage_state` session (see
> Configuration). If challenges still block you, a residential proxy or moving
> off Lambda are the next levers.

---

## 🔒 Supply chain

The project keeps its dependency surface as small as possible.

- **One runtime dependency**: `playwright`, pinned to an exact version. Its only dependencies are `playwright-core` from the same Microsoft release, plus the optional, macOS-only `fsevents`.
- **No AWS SDK**: Secrets Manager is called directly with a small SigV4 signer ([src/sigv4.js](src/sigv4.js)) built on `node:crypto`. This avoids the roughly 80 transitive packages the SDK would pull in.
- **No Google SDK**: Google Sheets is called with the built-in `fetch`, and the service-account JWT is signed with `node:crypto` ([src/google.js](src/google.js)).
- **No HTTP / test libraries**: Telegram and CapSolver use Node's built-in `fetch`. Tests use the built-in `node:test`.
- **[.npmrc](.npmrc)**: `ignore-scripts=true` stops dependency install scripts from running. `save-exact=true` keeps exact pins, and `engine-strict=true` enforces the Node version.
- **Lockfile**: `package-lock.json` records an integrity hash for every package. CI and the Docker build use `npm ci`, which installs exactly what the lockfile pins.

To upgrade Playwright:

1. Check that the new version has been public for at least a few days:
   ```bash
   npm view playwright time --json
   ```
2. Install it with an exact pin:
   ```bash
   npm install playwright@<version>
   ```
3. Check for known vulnerabilities:
   ```bash
   npm audit
   ```
4. Check registry signatures and provenance:
   ```bash
   npm audit signatures
   ```
5. Commit the updated lockfile.

---

## 🛠 Prerequisites

- **Node.js 22+** (Lambda runs Node 24).
- **Docker**, to build the Lambda image.
- **AWS CLI**, to push to ECR and to export local credentials for `secret_manager[...]` values.

---

## 💻 Local Setup

1. **Install dependencies.** The first time, run `npm install`. It creates `package-lock.json`, which you should commit. After that, use `npm ci`:
   ```bash
   npm ci
   ```

2. **Install the Chromium build that matches the pinned Playwright version:**
   ```bash
   npm run browser:install
   ```

3. **Configure targets.** Define `targets` with a sequence of `actions` in a JSON file (see [Actions](#-actions)). The `examples/` directory has sample configs, including:
   - `examples/get-xpath.json` and `examples/get-script.json`: extract text with XPath or JavaScript.
   - `examples/fill-local.json`: the `fill` action with raw strings, against the bundled `login.html`.
   - `examples/fill-local-secret-manager.json`: `fill` with values from AWS Secrets Manager.
   - `examples/login-and-scrape.json`: log in, `sleep`, `switch_path`, then extract.
   - `examples/solve-captcha.json`: the `solve_captcha` action (CapSolver).
   - `examples/telegram-notification.json`: send results to Telegram (legacy keys).
   - `examples/outputs.json`: named outputs, with each target picking its own (see [Outputs](#-outputs)).
   - `examples/dynamodb.json`: one target sent to Telegram and to DynamoDB, choosing which values go into which columns (see [DynamoDB](#dynamodb)).
   - `examples/google-sheets.json`: the example-price sent to Telegram and appended as a row to a Google Sheet tab (see [Google Sheets](#google-sheets)).

4. **Run it:**
   ```bash
   # A specific config file
   CONFIG_FILE=examples/get-xpath.json npm start

   # Or the default ./config.json
   npm start
   ```

   `secret_manager[...]` values need AWS credentials in the environment. Export them from your AWS CLI login first:
   ```bash
   eval "$(aws configure export-credentials --format env)"
   ```

---

## 🧪 Testing Locally

### Run the tests

```bash
npm test
```

This runs two sets of tests:
- **Unit tests**: no browser or network needed.
- **End-to-end test**: drives a real headless Chromium against [test/fixtures/page.html](test/fixtures/page.html). It's skipped if Chromium is not installed.

### Call the Lambda handler without Docker

```bash
CONFIG_FILE=examples/get-xpath.json npm run invoke

# Optional event file: the Lambda event ("targets", "only", "outputs")
CONFIG_FILE=examples/get-xpath.json npm run invoke -- path/to/event.json

# Scrape and log only, sending to no output
echo '{ "outputs": [] }' > /tmp/event.json
CONFIG_FILE=examples/outputs.json npm run invoke -- /tmp/event.json
```

### Run the real Lambda image

The Lambda base image includes the Runtime Interface Emulator:

```bash
IMAGE_NAME=mpt-staging-web-scraper ./build_image.sh
docker run --platform linux/amd64 -p 9000:8080 \
  -e CONFIG_JSON="$(cat examples/get-xpath.json)" \
  mpt-staging-web-scraper:latest
curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" -d '{}'
```

To pass AWS credentials into the container, add the following to `docker run` after `eval "$(aws configure export-credentials --format env)"`:

```
-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION
```

---

## ☁️ AWS Lambda Deployment (Docker)

### 1. Build and tag the image

The build uses `linux/amd64` and requires a committed `package-lock.json`.

```bash
IMAGE_NAME=mpt-staging-web-scraper ./build_image.sh
```

### 2. Push to AWS ECR

```bash
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mpt-staging-web-scraper:latest
```

### 3. Lambda configuration

- **Handler**: set by the image (`src/lambda.handler`).
- **Environment variables**:
  - `CONFIG_JSON`: optional. The entire config JSON; takes priority over `CONFIG_FILE`.
  - `CONFIG_FILE`: optional. Defaults to `config.json`.
  - `LOG_LEVEL`: `DEBUG`, `INFO`, `WARNING` or `ERROR`. Defaults to `INFO`.
- **IAM**: give the execution role `secretsmanager:GetSecretValue` on the secrets your config references, and `dynamodb:PutItem` on the tables its `dynamodb` outputs write to. `google_sheets` outputs need nothing more than reading the secret that holds the key.
- **Memory/timeout**: 1024 MB or more, and a 3–5 minute timeout depending on targets.
- **Event**: optional.
  - EventBridge, console or CLI: `{ "only": ["<target name>"] }` runs just those configured targets. `{ "targets": [...] }` replaces the configured targets for that invocation. When the config sets `http_api_key`, event `targets` are refused unless `allow_event_targets` is `true`.
  - Each target sends its results to the outputs named in its own `outputs`; a target that names none only logs. `{ "outputs": ["<output name>"] }` in the event limits the run to those outputs, and `[]` sends nothing. See [Outputs](#-outputs).
  - HTTP requests are handled differently; see [HTTP Trigger](#-http-trigger-google-sheets--api-gateway--function-url).
- **Logs**: every refused invocation (bad event, unknown names, missing config) writes an `ERROR` line before it returns, so a failed scheduled run shows why in CloudWatch.

On Lambda the browser always runs headless without the Chromium sandbox, and `keep_browser_open` is ignored.

---

## 🌐 HTTP Trigger (Google Sheets → API Gateway / Function URL)

The same handler also accepts HTTP requests from API Gateway (REST or HTTP API) or a Lambda Function URL. It detects them automatically.

**What an HTTP request can do:**
- **Auth:** it must send the `x-api-key` header, matching the config's `http_api_key`. The key is checked in constant time. If `http_api_key` is not set, every HTTP request gets `503`.
- **Choose targets and outputs:** the JSON body may only carry `only` and `outputs`, which pick configured targets and outputs by name. Sending `targets` is refused, so a caller can't supply their own URLs, scripts or `secret_manager[...]` lookups, and output names can't add a destination.
- **Response:** the scraped values come back as JSON:
  ```json
  { "results": [ { "name": "ราคาทองคำ (สมาคมค้าทองคำ) - ทองคำแท่ง ขายออก", "value": "66,100.00" } ] }
  ```

**Supported integrations:** API Gateway REST API with **Lambda proxy integration**, HTTP API, or a Lambda Function URL. Other request-style events (WebSocket APIs, VPC Lattice, anything else carrying `headers` / `body` / `requestContext`) are refused with `400`. Don't use a REST API **non-proxy** integration: it hands the handler the bare request body, which looks like a trusted invocation and skips the `x-api-key` check. As a backstop, a config with `http_api_key` refuses event `targets` (see `allow_event_targets`), so such a caller still can't run their own URLs or scripts.

**Example config:**
```json
{
    "http_api_key": "secret_manager['mpt-scraper']['HTTP_API_KEY']",
    "targets": [ { "name": "ราคาทองคำ (สมาคมค้าทองคำ)", "url": "...", "actions": [ ... ] } ]
}
```

**Timeouts:**
- API Gateway waits at most about **29–30 seconds** for Lambda. A cold start plus one page usually fits; several targets or long `wait_timeout` values may not, and the caller then gets a `504` even though the scrape finishes.
- A **Lambda Function URL** has no extra charge and waits up to the function's own timeout, which makes it the safer fit for longer scrapes.
- When using an HTTP trigger, keep its configs short: lower `wait_timeout`, few targets.

**Google Apps Script example.** Keep the URL and key in *Project Settings → Script properties*, not in the code:
```js
function refreshexample-price() {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(props.getProperty('SCRAPER_URL'), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': props.getProperty('SCRAPER_API_KEY') },
    payload: JSON.stringify({ only: ['ราคาทองคำ (สมาคมค้าทองคำ)'] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error(res.getContentText());
  const sheet = SpreadsheetApp.getActiveSheet();
  JSON.parse(res.getContentText()).results
    .forEach((r) => sheet.appendRow([new Date(), r.name, r.value]));
}
```

**Deployment tips:**
- **Two functions from the same image:** one for EventBridge schedules (Telegram, no HTTP), and one for HTTP with its own `CONFIG_JSON` and an IAM role that can read only the secrets that config needs.
- **Cap concurrency:** set reserved concurrency on the HTTP function (for example 2), so a flood of requests can't run up the bill.
- **Rotate the key:** change it in Secrets Manager and in Script properties. No redeploy is needed.

---

## ⚙️ Configuration Loading Logic

### Configuration source

`loadConfig()` ([src/config.js](src/config.js)) searches in this order:
1. The `CONFIG_JSON` environment variable (stringified JSON).
2. The `CONFIG_FILE` environment variable (path to a file).
3. A local `config.json` file.

### Dynamic value resolution

Some fields support dynamic values: the `fill` action's `value_from`, a Telegram output's `bot_token` / `chat_id` (and the legacy `telegram_bot_token` / `telegram_chat_id`), a DynamoDB output's `table`, a Google Sheets output's `spreadsheet_id` / `client_email` / `private_key` / `tab`, `proxy.username` / `proxy.password`, and `solve_captcha`'s `api_key_from`.

- **AWS Secrets Manager**: `secret_manager['<secret_name_or_arn>']['<json_key>']`
  - Example: `"secret_manager['my-credentials']['password']"` fetches the `password` key from the `my-credentials` secret.
  - **Region**: the config's top-level `region`, then `AWS_REGION` / `AWS_DEFAULT_REGION`.
  - **Credentials**: the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars. Lambda sets these for the execution role.
- **Raw strings**: `string['<value>']`
  - Example: `"string['my_hardcoded_value']"` is parsed directly as `"my_hardcoded_value"`.
- **Plain values**: anything else is used exactly as provided.

### Top-level keys

| Key | Default | Purpose |
|-----|---------|---------|
| `targets` | _(required)_ | List of `{ "name", "url", "actions": [...] }`. Relative `file://./page.html` URLs resolve against the working directory. |
| `headless` | `true` | Set to `false` to watch the browser locally. |
| `keep_browser_open` | `false` | Local and visible browser only: leave the window open after the run (press Ctrl+C to exit). |
| `wait_timeout` | `15` | Seconds to wait after a page opens, before running actions. |
| `action_wait` | `2` | Seconds to wait after each click/fill/switch_path/solve_captcha. |
| `region` | _(unset)_ | AWS region for Secrets Manager lookups and DynamoDB outputs. |
| `http_api_key` | _(unset)_ | Required for HTTP requests (API Gateway / Function URL); compared against the `x-api-key` header. Supports `secret_manager[...]`. Without it, HTTP access is refused. |
| `allow_event_targets` | `true`, or `false` when `http_api_key` is set | Whether a trusted invocation's event may carry `targets`. Off by default on HTTP-facing functions, so caller-supplied URLs and scripts can't get in through a misconfigured integration. Set it explicitly to override. |
| `challenge_timeout` | `15` | Seconds to wait for a Cloudflare challenge to clear by itself after a page opens (also after `switch_path`). |
| `challenge_retries` | `1` | How many more times to open a target in a fresh browser context when its challenge doesn't clear. `0` turns retries off. |
| `headless_shell` | `false` | Headless runs use the full Chromium build. Set to `true` to use Playwright's lighter `chromium-headless-shell` instead, which is easier for sites to detect. |
| `chromium_sandbox` | `true` | Local runs only: keep Chromium's sandbox on while visiting third-party sites. Set to `false` only on hosts where the sandbox can't start (some Linux setups). Always off on Lambda, which can't run it. |
| `outputs` | _(unset)_ | Named destinations for results, e.g. `{ "telegram": { "type": "telegram", "bot_token": "...", "chat_id": "..." } }`. Each target names the ones it sends to in its own `outputs`. See [Outputs](#-outputs). |
| `telegram_bot_token` / `telegram_chat_id` | _(unset)_ | **Legacy.** Used only when `outputs` is not set: together they define one output named `telegram`, which targets still have to name. They fall back to the `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env vars. |
| `user_agent` | the browser's own, with `HeadlessChrome` → `Chrome` | Override the browser User-Agent string. A UA for another OS or Chrome version than the browser's own disagrees with `navigator.platform` and the client hints, which Cloudflare checks. |
| `locale` | `en-US` | Browser locale. |
| `timezone_id` | `Asia/Bangkok` | Emulated timezone (match it to your proxy region). |
| `viewport` | `{ "width": 1920, "height": 1080 }` | Browser viewport size. |
| `storage_state` | _(unset)_ | Path to a JSON file. Cookies and session are restored from it at start and saved back on exit, so a login can be reused across runs. On Lambda the path must be under `/tmp`, and it only lasts while the container stays warm. |
| `proxy` | _(unset)_ | Residential proxy, e.g. `{ "server": "http://host:port", "username": "secret_manager['x']['PROXY_USER']", "password": "secret_manager['x']['PROXY_PASS']" }`. Routing through a residential IP is the biggest lever against Cloudflare when running from Lambda. |

Boolean flags accept `true`/`false` or the strings `"true"`/`"false"`.

---

## 📤 Outputs

An output is a named destination for results. Destinations and credentials live in the config's `outputs`; each **target** names the outputs its results go to.

```json
{
    "outputs": {
        "telegram":       { "type": "telegram", "bot_token": "secret_manager['my-app-secrets']['TELEGRAM_BOT_TOKEN']", "chat_id": "secret_manager['my-app-secrets']['TELEGRAM_CHAT_ID']" },
        "telegram-alert": { "type": "telegram", "bot_token": "...", "chat_id": "..." }
    },
    "targets": [
        { "name": "SET TRI",       "url": "...", "actions": [ ... ], "outputs": ["telegram", "telegram-alert"] },
        { "name": "SET TRI debug", "url": "...", "actions": [ ... ] }
    ]
}
```

- **A target without `outputs`** (or with `[]` / `null`) sends nowhere. Its values are still logged ("Extraction successful: ..."), so it is a log-only target.
- **One message per output**: each output gets one batch per run, with the results of every target that names it.
- **The event's `outputs`** (EventBridge, console, CLI or HTTP body) limits a run to those names: `{ "outputs": ["telegram-alert"] }` drops every other output for that run, and `{ "outputs": [] }` sends nothing at all. Useful for test runs. Without it, each target uses all the outputs it names.
- **Targets sent in the event** (a cronjob's `targets`) carry their own `outputs` the same way.
- **Per-target options**: an entry in a target's `outputs` can be `{ "name": "<output>", ...options }` instead of a plain name, to set options for that target only. `dynamodb` takes `columns` (see [DynamoDB](#dynamodb)), and `google_sheets` takes `tab` and `columns` (see [Google Sheets](#google-sheets)).
- **Validation** happens before scraping:
  - An unknown output name, `outputs` that isn't a list of names or `{ "name": ... }` objects, or options the output doesn't accept refuses the run. That's a `400` when the event sent it (in its `outputs` or its `targets`), and a `500` when it comes from the configured targets.
  - An output with an unknown `type` or a bad definition (such as a `dynamodb` output without a `table`, or a `google_sheets` output without a `private_key`) fails every run with `500`.
- **Failures**: each output is sent separately. One failing is logged and doesn't stop the others.
- **Run log**: every run logs its routing, e.g. `Outputs: SET TRI -> telegram, telegram-alert; SET TRI debug -> none (log only).`
- **Legacy configs**: without `outputs`, `telegram_bot_token` / `telegram_chat_id` (or the `TELEGRAM_*` env vars) define one output named `telegram`. Targets still have to name it (`"outputs": ["telegram"]`): **since v3.0.0, a v2.x config whose targets name no outputs only logs.** When `outputs` is set, the legacy keys are ignored.

Output types:

| `type` | Fields | What it does |
|--------|--------|--------------|
| `telegram` | `bot_token`, `chat_id` (both support `secret_manager[...]`) | Posts one message with the results routed to it. If either value resolves empty, a warning is logged and nothing is sent. |
| `dynamodb` | `table` (supports `secret_manager[...]`); optional `partition_key` (default `target`), `sort_key` (default `scraped_at`, `null` for none), `region` (default: the config's) | Writes one item per target routed to it. Each target's `columns` choose which values go in and under which column names. See [DynamoDB](#dynamodb). |
| `google_sheets` | `spreadsheet_id`, `client_email`, `private_key`, optional `tab` (all support `secret_manager[...]`) | Appends one row per target routed to it, placing each value under its column name in the tab's header row. Each target can set its own `tab` and `columns`. See [Google Sheets](#google-sheets). |

A new type is one sender function registered in `SENDERS` in [src/outputs.js](src/outputs.js), plus checks in `CHECKS` if it has a definition to validate or takes per-target options. Each result it receives carries its `target` name and its `field` (the `get` action's `name`); the routing rules don't change.

### DynamoDB

```json
{
    "outputs": {
        "telegram": { "type": "telegram", "bot_token": "...", "chat_id": "..." },
        "dynamodb": { "type": "dynamodb", "table": "set-tri-history" }
    },
    "targets": [
        {
            "name": "SET TRI", "url": "...", "actions": [ ... ],
            "outputs": [
                "telegram",
                { "name": "dynamodb", "columns": { "date": "as_of", "BANK TRI": "bank_tri" } }
            ]
        }
    ]
}
```

Each run writes one item per target, for example:

```json
{ "target": "SET TRI", "scraped_at": "2026-10-18T02:00:00.000Z", "as_of": "17 ต.ค. 2569", "bank_tri": 1234.56 }
```

- **`columns`** maps a `get` action's `name` to the column its value goes in. Only the mapped fields are written; the target's other outputs still get every field (in `examples/dynamodb.json`, Telegram also gets `HELTH TRI`, which has no column). Name the output without options (`"outputs": ["dynamodb"]`) to write every field under its own name. A `get` without a `name` counts as the field `value`.
- **Values**: a plain number (`1,234.56`, `-0.25`) is stored as a DynamoDB number, without the thousands separators. Anything else (`17 ต.ค. 2569`, `1.2%`, `007`) is stored as the scraped string.
- **Keys**: the partition key is the target's name and the sort key is the run's time (ISO 8601, UTC), so every run adds an item. `partition_key` / `sort_key` rename them. With `"sort_key": null` (a table with only a partition key), each run overwrites the target's item, so the table holds the latest values only.
- **Missing values**: a mapped field with no value (its extraction failed, or `columns` has a typo) is logged as a warning and left out. A target with nothing to write writes no item.
- **Validation**: `columns` must map field names to non-empty column names, can't write a key attribute, and can't write the same column twice. See the [validation rules](#-outputs) above for `400` vs `500`.
- **Failures**: one target's write failing is logged; the other targets are still written.
- **Table and IAM**: the key attributes are strings. The execution role needs `dynamodb:PutItem` on the table. For example:

```bash
aws dynamodb create-table --table-name set-tri-history \
  --attribute-definitions AttributeName=target,AttributeType=S AttributeName=scraped_at,AttributeType=S \
  --key-schema AttributeName=target,KeyType=HASH AttributeName=scraped_at,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

### Google Sheets

```json
{
    "outputs": {
        "telegram": { "type": "telegram", "bot_token": "...", "chat_id": "..." },
        "sheets": {
            "type": "google_sheets",
            "spreadsheet_id": "<id from the sheet URL>",
            "client_email": "mpt-scraper@my-project.iam.gserviceaccount.com",
            "private_key": "secret_manager['my-app-secrets']['GOOGLE_PRIVATE_KEY']",
            "tab": "prices"
        }
    },
    "targets": [
        {
            "name": "ราคาทองคำ (สมาคมค้าทองคำ)", "url": "...", "actions": [ ... ],
            "outputs": [
                "telegram",
                { "name": "sheets", "tab": "gold", "columns": { "ทองคำแท่ง รับซื้อ": "bar_buy", "ทองคำแท่ง ขายออก": "bar_sell" } }
            ]
        }
    ]
}
```

Each run appends one row per target to its tab, for example:

| scraped_at | target | bar_buy | bar_sell |
|------------|--------|---------|----------|
| 2026-10-18T02:00:00.000Z | ราคาทองคำ (สมาคมค้าทองคำ) | 65900 | 66100 |

- **`spreadsheet_id`** is the part of the sheet's URL between `/d/` and `/edit`. All four output fields support `secret_manager[...]`.
- **Tab**: a target's `tab` wins over the output's; one of them must be set. The tab must already exist. The output never creates tabs, and a missing one is logged as an error for that target.
- **`columns`** works as for DynamoDB: only the mapped fields are written, under the mapped names. Name the output without `columns` to write every field under its own name. A `get` without a `name` counts as the field `value`. `scraped_at` and `target` are reserved.
- **Header row**: row 1 of the tab holds the column names, and each value goes in the column with its name. If row 1 is empty, the header is written first. Names missing from the header are added to its end. Existing headers are never moved or renamed, so you can rearrange columns or add your own; columns the output doesn't write stay empty in new rows.
- **Values**: a plain number (`66,100.00`) is written as a number, without the thousands separators, when it has at most 15 digits (what Sheets can store exactly). Anything else is written as text, and so is `scraped_at` (ISO 8601, UTC). Every write uses `valueInputOption=RAW`, so scraped text such as `=IMPORTXML(...)` stays text and never becomes a formula.
- **Missing values**: a mapped field with no value is logged as a warning and its cell is left empty. A target with nothing to write gets no row.
- **Validation**: `tab` must be a non-empty string, and `columns` follows the DynamoDB rules. See the [validation rules](#-outputs) above for `400` vs `500`.
- **Failures**: one target failing (a missing tab, a protected range) is logged; the other targets are still appended. Each run logs `Appended N row(s) to Google Sheet <id>.`
- **Auth**: the service-account JWT is signed in-process and exchanged for an access token. The token is cached until 5 minutes before it expires, so warm Lambda invocations reuse it. The key, the JWT and the token are never logged.

Setup:

1. Create a Google Cloud project and enable the Google Sheets API.
2. Create a service account (no roles) and a JSON key for it.
3. Share the sheet with the service account's email as Editor.
4. Put the key's `private_key` in Secrets Manager and `client_email` in the config. The key can be stored with real newlines or with `\n` escapes, as the Secrets Manager console usually saves it.

No new AWS IAM permission is needed beyond `secretsmanager:GetSecretValue` on the secret that holds the key. Access to the sheet itself is controlled by sharing it with the service account.

---

## 🎬 Actions

Every action accepts `continue_on_failure` (default `false`). When a `click`, `fill`, `switch_path`, `solve_captcha` or `click_turnstile` fails, the remaining actions of that target are skipped unless this is set.

| `type` | Fields | What it does |
|--------|--------|--------------|
| `click` | `xpath` **or** `script`, optional `iframe_title` | Scrolls to the element and clicks it, falling back to a JS `el.click()`. With `script`, runs the JavaScript instead. |
| `fill` | `xpath`, `value_from`, optional `iframe_title` | Clears the field and types the resolved value. |
| `get` | `xpath` **or** `script`, optional `name`, `iframe_title`, `telegram_message_options` | Extracts the element's text, or the script's `return` value. Each `get` becomes one result. |
| `sleep` | `duration` (`5`, `"5s"`, `"2m"`, `"1h"`) | Waits. |
| `switch_path` | `path` | Navigates to another path on the current site, e.g. `"/dashboard"`. |
| `solve_captcha` | see below | Solves a CAPTCHA via CapSolver and injects the token. |
| `click_turnstile` | optional `timeout` (default `30`) | Waits for the page's Cloudflare Turnstile widget (the "Verify you are human" box in a login form) to pass, clicking its checkbox when it doesn't pass by itself, and retrying a click that doesn't take. Fails when the widget still has no token after `timeout`. Place it before the submit `click`: forms like this ignore the submit until the widget has passed. |

How the fields work:
- **`script` snippets** use `return ...` to produce a value, and may use `await`.
- **`iframe_title`** runs the action inside `<iframe title="...">`.
- **`telegram_message_options: ["--no-codeblock"]`** sends that value as plain text instead of in a `<pre>` block.

---

## 🤖 Solving CAPTCHAs (CapSolver)

The `solve_captcha` action solves a CAPTCHA via [CapSolver](https://capsolver.com) and injects the resulting token into the page, so a later `click` on the submit button goes through. Place it **after** filling the form and **before** clicking submit.

**Supported `captcha_type` values:** `recaptcha_v2`, `recaptcha_v3`, `turnstile` (Cloudflare), `hcaptcha`.

```json
{
    "type": "solve_captcha",
    "captcha_type": "recaptcha_v2",
    "api_key_from": "secret_manager['my-app-secrets']['CAPSOLVER_API_KEY']",
    "website_key": null,
    "page_action": null,
    "invoke_callback": true,
    "timeout": "120s",
    "continue_on_failure": false
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `captcha_type` | no | Defaults to `recaptcha_v2`. |
| `api_key_from` | no | Your CapSolver key. Supports `secret_manager[...]`, `string[...]`, or a plain value. If omitted, falls back to the `CAPSOLVER_API_KEY` env var. |
| `website_key` | no | The CAPTCHA site key. If omitted or `null`, it is auto-detected from the page (the `data-sitekey` attribute or the widget iframe). Provide it explicitly if auto-detection fails. |
| `website_url` | no | Defaults to the current page URL. |
| `page_action` | no | For `recaptcha_v3`, the action name (e.g. `login`). For `turnstile`, it is passed as `metadata.action`. |
| `invoke_callback` | no | After injection, best-effort hand the token to the page's JS callback (reCAPTCHA and Turnstile). For Turnstile, see below. Default `false`. |
| `timeout` | no | Max time to wait for CapSolver (`120` / `"120s"` / `"2m"`). Default 120s. |
| `continue_on_failure` | no | If `true`, keep running the remaining actions when solving fails. Default `false`. |

> ⚠️ Only use this against sites you are authorized to automate. CapSolver charges each solve to your prepaid balance.

### Turnstile in a JavaScript form

Many sites render Turnstile from their own JavaScript (`turnstile.render(...)`) and take the token only from the widget's `callback`, for example as an Angular or React form control. On these pages:

- **The site key** isn't in a `data-sitekey` attribute, so auto-detection fails. Set `website_key`; it usually sits in the site's JavaScript bundle (it starts with `0x4`).
- **The token** written into `cf-turnstile-response` is ignored, and the submit button stays disabled. Set `invoke_callback: true`: the target's page then gets a small script at load that records the callbacks passed to `turnstile.render`, and the token is handed to them after solving. The script is added only for targets with such an action, and removed when the target finishes. If no callback was recorded, the run logs a warning.
- **`page_action`** must match the widget's `action`, if it has one.

```json
{
    "type": "solve_captcha",
    "captcha_type": "turnstile",
    "api_key_from": "secret_manager['my-app-secrets']['CAPSOLVER_API_KEY']",
    "website_key": "0x4AAAAAAA...",
    "page_action": "login-email",
    "invoke_callback": true
}
```

---

## 📝 Logging

- **Local**: logs go to stdout and to `scraper_run.log` (override with `LOG_FILE`), with timestamps.
- **AWS Lambda**: logs go to CloudWatch without our own timestamp, since Lambda adds one.
- Use the `LOG_LEVEL` environment variable to control verbosity.

---

## 📅 Scheduling

### macOS (launchd)

Generate the `.plist` file with the helper script. It uses absolute paths to your `node` binary and this repo.

```bash
npm run setup-cron -- --hour 13 --minute 0 --config examples/simple.json
cp com.user.mpt-cronjob.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.user.mpt-cronjob.plist
```

### AWS Lambda

Schedule it with **Amazon EventBridge (Scheduler)** using a cron expression, e.g. `cron(0 13 * * ? *)`.
