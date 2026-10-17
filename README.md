# mpt-cronjob

A Playwright-based web scraper written in Node.js. It runs locally (macOS/Linux) and on AWS Lambda as a container image.

## 🚀 Overview

- **Engine**: Official [Playwright](https://playwright.dev/) (Microsoft) driving Chromium.
- **Runs on**:
  - **Local**: run manually, or schedule it with macOS `launchd`.
  - **Cloud**: AWS Lambda container image (`public.ecr.aws/lambda/nodejs`), scheduled by EventBridge.
- **Dynamic config**: targets and actions come from a JSON file or an environment variable.
- **Integrations**: AWS Secrets Manager, Telegram, CapSolver.

> **Note on Cloudflare:** running headless from an AWS/Lambda datacenter IP is the
> weakest position against Cloudflare's managed challenges. The scraper applies
> best-effort stealth (init-script `navigator.webdriver` patches,
> `--disable-blink-features=AutomationControlled`, realistic UA/locale/timezone,
> human-like mouse movement). It also supports an optional residential `proxy` and a
> persisted `storage_state` session (see Configuration). If challenges still
> block you, a residential proxy or moving off Lambda are the next levers.

---

## 🔒 Supply chain

The project keeps its dependency surface as small as possible.

- **One runtime dependency**: `playwright`, pinned to an exact version. Its only dependencies are `playwright-core` from the same Microsoft release, plus the optional, macOS-only `fsevents`.
- **No AWS SDK**: Secrets Manager is called directly with a small SigV4 signer ([src/sigv4.js](src/sigv4.js)) built on `node:crypto`. This avoids the roughly 80 transitive packages the SDK would pull in.
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
   - `examples/outputs.json`: named outputs, which each run can pick from (see [Outputs](#-outputs)).

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
- **IAM**: give the execution role `secretsmanager:GetSecretValue` on the secrets your config references.
- **Memory/timeout**: 1024 MB or more, and a 3–5 minute timeout depending on targets.
- **Event**: optional.
  - EventBridge, console or CLI: `{ "only": ["<target name>"] }` runs just those configured targets. `{ "targets": [...] }` replaces the configured targets for that invocation.
  - `{ "outputs": ["<output name>"] }` sends the results only to those configured outputs; `[]` sends them nowhere. Without it, every configured output gets them. See [Outputs](#-outputs).
  - HTTP requests are handled differently; see [HTTP Trigger](#-http-trigger-google-sheets--api-gateway--function-url).
- **Logs**: every refused invocation (bad event, unknown names, missing config) writes an `ERROR` line before it returns, so a failed scheduled run shows why in CloudWatch.

On Lambda the browser always runs headless, and `keep_browser_open` is ignored.

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
function refreshGoldPrice() {
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

Some fields support dynamic values: the `fill` action's `value_from`, a Telegram output's `bot_token` / `chat_id` (and the legacy `telegram_bot_token` / `telegram_chat_id`), `proxy.username` / `proxy.password`, and `solve_captcha`'s `api_key_from`.

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
| `region` | _(unset)_ | AWS region for Secrets Manager lookups. |
| `http_api_key` | _(unset)_ | Required for HTTP requests (API Gateway / Function URL); compared against the `x-api-key` header. Supports `secret_manager[...]`. Without it, HTTP access is refused. |
| `outputs` | _(unset)_ | Named destinations for the results, e.g. `{ "telegram": { "type": "telegram", "bot_token": "...", "chat_id": "..." } }`. Each run sends to all of them unless its event picks some by name. See [Outputs](#-outputs). |
| `telegram_bot_token` / `telegram_chat_id` | _(unset)_ | **Legacy.** Used only when `outputs` is not set: together they become one output named `telegram`. They fall back to the `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env vars. |
| `user_agent` | recent desktop Chrome UA | Override the browser User-Agent string. |
| `locale` | `en-US` | Browser locale. |
| `timezone_id` | `Asia/Bangkok` | Emulated timezone (match it to your proxy region). |
| `viewport` | `{ "width": 1920, "height": 1080 }` | Browser viewport size. |
| `storage_state` | _(unset)_ | Path to a JSON file. Cookies and session are restored from it at start and saved back on exit, so a login can be reused across runs. On Lambda the path must be under `/tmp`, and it only lasts while the container stays warm. |
| `proxy` | _(unset)_ | Residential proxy, e.g. `{ "server": "http://host:port", "username": "secret_manager['x']['PROXY_USER']", "password": "secret_manager['x']['PROXY_PASS']" }`. Routing through a residential IP is the biggest lever against Cloudflare when running from Lambda. |

Boolean flags accept `true`/`false` or the strings `"true"`/`"false"`.

---

## 📤 Outputs

An output is a named destination for a run's results. Destinations and credentials live in the config; an event only picks outputs by name, the same way `only` picks targets.

```json
{
    "outputs": {
        "telegram":       { "type": "telegram", "bot_token": "secret_manager['my-app-secrets']['TELEGRAM_BOT_TOKEN']", "chat_id": "secret_manager['my-app-secrets']['TELEGRAM_CHAT_ID']" },
        "telegram-alert": { "type": "telegram", "bot_token": "...", "chat_id": "..." }
    },
    "targets": [ ... ]
}
```

Event (EventBridge schedule, console, CLI or HTTP body):
```json
{ "only": ["SET TRI"], "outputs": ["telegram-alert"] }
```

- **No `outputs` in the event**: every configured output gets the results.
- **`"outputs": []`**: scrape and log only; nothing is sent. Useful for test runs.
- **Validation**: `outputs` must be a list of configured names, or the run is refused with `400` before scraping. An output with an unknown `type` in the config fails every run with `500`.
- **Failures**: each output is sent separately. One failing is logged and doesn't stop the others.
- **Legacy configs**: without `outputs`, `telegram_bot_token` / `telegram_chat_id` (or the `TELEGRAM_*` env vars) become one output named `telegram`, so v2.0.0 configs keep working. When `outputs` is set, the legacy keys are ignored.

Output types:

| `type` | Fields | What it does |
|--------|--------|--------------|
| `telegram` | `bot_token`, `chat_id` (both support `secret_manager[...]`) | Posts one message with every result. If either value resolves empty, a warning is logged and nothing is sent. |

A new type is one sender function registered in `SENDERS` in [src/outputs.js](src/outputs.js); the selection rules don't change.

---

## 🎬 Actions

Every action accepts `continue_on_failure` (default `false`). When a `click`, `fill`, `switch_path` or `solve_captcha` fails, the remaining actions of that target are skipped unless this is set.

| `type` | Fields | What it does |
|--------|--------|--------------|
| `click` | `xpath` **or** `script`, optional `iframe_title` | Scrolls to the element and clicks it, falling back to a JS `el.click()`. With `script`, runs the JavaScript instead. |
| `fill` | `xpath`, `value_from`, optional `iframe_title` | Clears the field and types the resolved value. |
| `get` | `xpath` **or** `script`, optional `name`, `iframe_title`, `telegram_message_options` | Extracts the element's text, or the script's `return` value. Each `get` becomes one result. |
| `sleep` | `duration` (`5`, `"5s"`, `"2m"`, `"1h"`) | Waits. |
| `switch_path` | `path` | Navigates to another path on the current site, e.g. `"/dashboard"`. |
| `solve_captcha` | see below | Solves a CAPTCHA via CapSolver and injects the token. |

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
| `invoke_callback` | no | Best-effort firing of the reCAPTCHA JS callback after injection (reCAPTCHA only). Default `false`. |
| `timeout` | no | Max time to wait for CapSolver (`120` / `"120s"` / `"2m"`). Default 120s. |
| `continue_on_failure` | no | If `true`, keep running the remaining actions when solving fails. Default `false`. |

> ⚠️ Only use this against sites you are authorized to automate. CapSolver charges each solve to your prepaid balance.

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
