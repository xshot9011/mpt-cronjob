# mpt-cronjob

A Playwright-based web scraper built for both local environments (macOS/Linux) and cloud deployment (AWS Lambda as a container). 

## 🚀 Overview

- **Engine**: Official [Playwright](https://playwright.dev/python/) (Microsoft) driving Chromium.
- **Support**: 
  - **Local**: Scheduled via macOS `launchd` or ran manually.
  - **Cloud**: Packaged as a Docker container for AWS Lambda.
- **Dynamic Config**: Loads targets and actions from environment variables or a JSON file.

> **Note on Cloudflare:** running headless from an AWS/Lambda datacenter IP is the
> weakest position against Cloudflare's managed challenges. The scraper applies
> best-effort stealth (init-script `navigator.webdriver` patches,
> `--disable-blink-features=AutomationControlled`, realistic UA/locale/timezone,
> human-like mouse movement) and supports an optional residential `proxy` and a
> persisted `storage_state` session (see Configuration). If challenges still
> block you, a residential proxy or moving off Lambda are the next levers.

---

## 🛠 Prerequisites

### For Local Usage:
- **Python 3.9+**
- Playwright + its Chromium browser (installed via the steps below — no separate
  Chrome/ChromeDriver download needed):
  ```bash
  pip3 install -r requirements.txt
  python3 -m playwright install chromium
  ```

### For AWS Lambda (Container):
- **Docker** installed and running.
- **AWS CLI** configured with appropriate permissions.

---

## 💻 Local Setup

1. **Create and Activate Virtual Environment**:
  ```bash
  python3 -m venv venv
  source venv/bin/activate
  ```

2. **Install Dependencies**:
  ```bash
  source venv/bin/activate
  pip3 install -r requirements.txt
  python3 -m playwright install chromium
  ```

3. **Configure Targets**:
   Define `targets` with a sequence of `actions` (`click`, `get`, `fill`) in a JSON file. 
   Check the `examples/` directory for sample configurations:
   - `examples/simple.json` - Basic `click` and `get` actions.
   - `examples/local.json` - Demonstrates `fill` action using raw strings.
   - `examples/local-secret-manager.json` - Demonstrates `fill` action integrating with AWS Secrets Manager.

4. **Run Manually**:
   You can run the scraper by pointing the `CONFIG_FILE` environment variable to your desired configuration:
   ```bash
   # Using a specific config file
   CONFIG_FILE=examples/local.json python scraper.py
   
   # Or using default config.json
   python scraper.py
   ```

---

## ☁️ AWS Lambda Deployment (Docker)

The project includes a `Dockerfile` optimized for AWS Lambda (AL2023) using Python 3.13.

### 1. Build and Tag Image
Use the provided script to build the image (defaults to `linux/amd64`):
```bash
./build_image.sh
```

### 2. Push to AWS ECR
```bash
# Login to ECR
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

# Push image
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/mpt-staging-web-scraper:latest
```

### 3. Lambda Configuration
When creating the Lambda function from the container image:
- **Environment Variables**:
  - `CONFIG_JSON`: (Optional) Paste the entire config JSON here for highest priority.
  - `CONFIG_FILE`: (Optional) Defaults to `config.json`.
  - `LOG_LEVEL`: `INFO`, `DEBUG`, `ERROR` (defaults to `INFO`).
- **Memory/Timeout**: Recommend 1024MB+ memory and 3-5 minute timeout depending on targets.

---

## ⚙️ Configuration Loading Logic

### Configuration Source
The code uses a shared `load_config()` function in `scraper.py` which searches in this order:
1. `CONFIG_JSON` environment variable (stringified JSON).
2. `CONFIG_FILE` environment variable (path to file).
3. Local `config.json` file.

### Dynamic Value Resolution
For certain configuration fields (e.g., the `fill` action's `value_from`, `telegram_bot_token`, and `telegram_chat_id`), the scraper supports dynamic value resolution using the following syntax:

- **AWS Secrets Manager**: `secret_manager['<secret_name_or_arn>']['<json_key>']`
  *Example*: `"secret_manager['my-credentials']['password']"` fetches the `password` key from the `my-credentials` secret.
- **Raw Strings**: `string['<value>']`
  *Example*: `"string['my_hardcoded_value']"` will be parsed directly as `"my_hardcoded_value"`.
- **Plain Values**: Any value not matching the above syntax will be evaluated exactly as provided.

### Optional Anti-Bot / Session Keys
These top-level config keys are optional and default to sensible values:

| Key | Default | Purpose |
|-----|---------|---------|
| `user_agent` | recent desktop Chrome UA | Override the browser User-Agent string. |
| `locale` | `en-US` | Browser locale. |
| `timezone_id` | `Asia/Bangkok` | Emulated timezone (match it to your proxy region). |
| `viewport` | `{ "width": 1920, "height": 1080 }` | Browser viewport size. |
| `storage_state` | _(unset)_ | Path to a JSON file. Cookies/session are restored from it at start and saved back on exit — lets you reuse a login across runs instead of a cold login each time. |
| `proxy` | _(unset)_ | Residential proxy, e.g. `{ "server": "http://host:port", "username": "secret_manager['x']['PROXY_USER']", "password": "secret_manager['x']['PROXY_PASS']" }`. `username`/`password` support the same dynamic resolution as `value_from`. Routing through a residential IP is the biggest lever against Cloudflare when running from Lambda. |

---

## 📝 Logging

- **Local**: Logs are written to `scraper_run.log` and standard output with timestamps.
- **AWS Lambda**: Logs are optimized for CloudWatch; local timestamps are removed to avoid redundancy as Lambda prepends its own. Use `LOG_LEVEL` environment variable to control verbosity.

---

## 📅 Scheduling

### macOS (launchd)
Use the helper script to generate the `.plist` file:
```bash
python setup_cron.py --hour 13 --minute 0
cp com.user.mpt-cronjob.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.user.mpt-cronjob.plist
```

### AWS Lambda
Schedule via **Amazon EventBridge (Scheduler)** using a cron expression (e.g., `cron(0 13 * * ? *)`).
