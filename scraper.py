import os
import json
import logging
import time
import sys
import re
import random
import html as html_escape

import requests
import boto3
from playwright.sync_api import (
    sync_playwright,
    Error as PlaywrightError,
    TimeoutError as PlaywrightTimeoutError,
)

# --- Configuration ---
CONFIG_FILE = os.environ.get("CONFIG_FILE", "config.json")
LOG_FILE = os.environ.get("LOG_FILE", "scraper_run.log")

# A realistic, recent desktop Chrome UA. Override via config "user_agent".
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)
DEFAULT_VIEWPORT = {"width": 1920, "height": 1080}

# Init script injected into every page/frame before any site code runs.
# Stock Playwright leaks navigator.webdriver=true and an empty window.chrome;
# these patches smooth over the most obvious automation tells. (This is best
# effort only -- a datacenter/Lambda IP remains the dominant Cloudflare signal.)
STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
"""


# Configure logging
def setup_logging():
    is_lambda = os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None
    log_level_str = os.environ.get("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_str, logging.INFO)

    # Define format: exclude timestamp for Lambda as it provides its own
    if is_lambda:
        log_format = '[%(levelname)s] [%(name)s] %(message)s'
        # Force configuration to ensure our format is applied and a handler is present
        # This handles cases where root.handlers might be empty at import time.
        logging.basicConfig(level=log_level, format=log_format, force=True)
        return logging.getLogger("Scraper")

    log_format = '[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s'
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE)
    ]

    logging.basicConfig(
        level=log_level,
        format=log_format,
        datefmt='%Y-%m-%d %H:%M:%S',
        handlers=handlers
    )
    return logging.getLogger("Scraper")


logger = setup_logging()


def load_config():
    """
    Load configuration from the CONFIG_JSON environment variable (highest priority),
    or fall back to the file pointed to by CONFIG_FILE env var (default: config.json).

    Returns the parsed config dict, or None if no config could be found.
    """
    config_json_env = os.environ.get("CONFIG_JSON")
    if config_json_env:
        logger.info("Loading configuration from environment variable CONFIG_JSON")
        return json.loads(config_json_env)

    config_file = os.environ.get("CONFIG_FILE", CONFIG_FILE)
    if os.path.exists(config_file):
        logger.info(f"Loading configuration from file {config_file}")
        with open(config_file, "r") as f:
            return json.load(f)

    return None


def get_secret(secret_name, key):
    region_name = os.environ.get('region')
    if region_name:
        client = boto3.client('secretsmanager', region_name=region_name)
    else:
        client = boto3.client('secretsmanager')
    try:
        response = client.get_secret_value(SecretId=secret_name)
    except Exception as e:
        raise e

    if 'SecretString' in response:
        secret = response['SecretString']
        try:
            secret_dict = json.loads(secret)
            return secret_dict.get(key)
        except json.JSONDecodeError:
            return None
    return None

def parse_duration(duration) -> float:
    """
    Parse a duration value into seconds (float).
    Accepts:
        - A number (int/float) treated as seconds.
        - A string with an optional unit suffix:
            '30'   -> 30 s
            '30s'  -> 30 s
            '2m'   -> 120 s
            '1h'   -> 3600 s
    """
    if isinstance(duration, (int, float)):
        return float(duration)
    s = str(duration).strip().lower()
    if s.endswith('h'):
        return float(s[:-1]) * 3600
    if s.endswith('m'):
        return float(s[:-1]) * 60
    if s.endswith('s'):
        return float(s[:-1])
    return float(s)


def resolve_value(value_str, error_logger=logger):
    if not isinstance(value_str, str):
        return value_str

    secret_match = re.match(r"secret_manager\['([^']+)'\]\['([^']+)'\]", value_str)
    string_match = re.match(r"string\['([^']+)'\]", value_str)

    if secret_match:
        secret_name = secret_match.group(1)
        secret_key = secret_match.group(2)
        try:
            secret_value = get_secret(secret_name, secret_key)
            if secret_value is None:
                error_logger.error(f"Secret key '{secret_key}' not found in '{secret_name}'")
            return secret_value
        except Exception as e:
            error_logger.error(f"Failed to get secret '{secret_name}': {e}")
            return None
    elif string_match:
        return string_match.group(1)

    return value_str


# ---------------------------------------------------------------------------- #
#                            Browser / Playwright                              #
# ---------------------------------------------------------------------------- #
def _build_launch_args():
    """Chromium launch flags. Lambda needs single-process/no-zygote to survive its
    constrained process model; the rest reduce automation fingerprints."""
    args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1920,1080",
    ]
    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        args += [
            "--single-process",
            "--no-zygote",
            "--disable-dev-tools",
        ]
    return args


def _resolve_proxy(config, target_logger=logger):
    """Optional residential proxy. Shape in config:
        "proxy": {
            "server": "http://host:port",
            "username": "secret_manager['x']['PROXY_USER']",  # resolved
            "password": "secret_manager['x']['PROXY_PASS']"
        }
    Routing through a residential IP is the single biggest lever against Cloudflare
    when running from an AWS/Lambda datacenter range.
    """
    proxy_cfg = config.get("proxy")
    if not proxy_cfg or not proxy_cfg.get("server"):
        return None
    proxy = {"server": proxy_cfg["server"]}
    if proxy_cfg.get("username"):
        proxy["username"] = resolve_value(proxy_cfg["username"], target_logger)
    if proxy_cfg.get("password"):
        proxy["password"] = resolve_value(proxy_cfg["password"], target_logger)
    return proxy


def launch_context(p, config):
    """Launch Chromium and return (browser, context). The caller owns teardown."""
    headless = config.get("headless", True)
    user_agent = config.get("user_agent", DEFAULT_USER_AGENT)

    launch_kwargs = {
        "headless": headless,
        "args": _build_launch_args(),
    }
    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        # Lambda's task dir is read-only; Chromium needs a writable HOME for its
        # profile/crashpad scratch space.
        launch_kwargs["env"] = {**os.environ, "HOME": "/tmp"}

    proxy = _resolve_proxy(config)
    if proxy:
        launch_kwargs["proxy"] = proxy
        logger.info(f"Launching with proxy server {proxy.get('server')}")

    browser = p.chromium.launch(**launch_kwargs)

    context_kwargs = {
        "user_agent": user_agent,
        "viewport": config.get("viewport", DEFAULT_VIEWPORT),
        "locale": config.get("locale", "en-US"),
        "timezone_id": config.get("timezone_id", "Asia/Bangkok"),
    }
    # Reuse a saved login/session across runs so we are not doing a fresh
    # (suspicious) cold login every time. Path is also written back on teardown.
    storage_state = config.get("storage_state")
    if storage_state and os.path.exists(storage_state):
        logger.info(f"Restoring browser session from {storage_state}")
        context_kwargs["storage_state"] = storage_state

    context = browser.new_context(**context_kwargs)
    context.add_init_script(STEALTH_INIT_SCRIPT)
    context.set_default_timeout(15000)
    return browser, context


def humanize_mouse(page, duration=2.0, interval=0.2):
    """Drift the mouse around to mimic human interaction. Best effort; never fatal."""
    try:
        vp = page.viewport_size or DEFAULT_VIEWPORT
        width = max(vp.get("width", 1920) - 1, 1)
        height = max(vp.get("height", 1080) - 1, 1)
        end_time = time.time() + duration
        while time.time() < end_time:
            page.mouse.move(
                random.randint(0, width),
                random.randint(0, height),
                steps=random.randint(2, 6),
            )
            time.sleep(interval)
    except Exception as e:
        logger.debug(f"humanize_mouse error: {e}")


def _eval_script(scope, script):
    """Run a user-supplied JS snippet against a Page or Frame, preserving Selenium's
    execute_script semantics (snippets use `return ...` to produce a value)."""
    return scope.evaluate(f"() => {{ {script} }}")


def _enter_frame(page, iframe_title, target_logger, step):
    """Return the Frame for an <iframe title="..."> so locators/scripts run inside it.
    Returns the page itself when no iframe_title is given."""
    if not iframe_title:
        return page
    handle = page.wait_for_selector(
        f"iframe[title='{iframe_title}']", timeout=15000, state="attached"
    )
    frame = handle.content_frame()
    if frame is None:
        raise PlaywrightError(f"Could not enter iframe '{iframe_title}'")
    target_logger.info(f"Step {step}: Entered iframe '{iframe_title}'.")
    return frame


# ---------------------------------------------------------------------------- #
#                          TODO: Simplify action order                         #
# ---------------------------------------------------------------------------- #
def execute_actions(page, target_logger, actions, action_wait):
    """Execute a list of actions sequentially. Returns a list of extracted values from 'get' actions."""
    extracted_values = []

    for i, action in enumerate(actions):
        action_type = action.get("type")
        xpath = action.get("xpath")
        continue_on_failure = action.get("continue_on_failure", False)

        if not action_type:
            target_logger.error(f"Action {i + 1}: Missing 'type'. Skipping.")
            continue

        # Actions that do not require an xpath element
        if action_type == "switch_path":
            path = action.get("path", "")
            try:
                from urllib.parse import urlparse
                current_url = page.url
                parsed = urlparse(current_url)
                # Rebuild origin: scheme://netloc  (includes port if non-standard)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                # Ensure path starts with /
                if path and not path.startswith("/"):
                    path = "/" + path
                destination = origin + path
                target_logger.info(f"Step {i + 1}: Switching path to '{destination}'...")
                page.goto(destination, wait_until="domcontentloaded")
                target_logger.info(f"Step {i + 1}: Navigated to '{destination}'. Waiting {action_wait}s...")
                time.sleep(action_wait)
                humanize_mouse(page, 2)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: switch_path failed: {e}")
                if continue_on_failure:
                    target_logger.warning(f"Step {i + 1}: Continuing despite switch_path failure (continue_on_failure=true).")
                    continue
                return extracted_values
            continue

        if action_type == "sleep":
            raw_duration = action.get("duration", 0)
            try:
                seconds = parse_duration(raw_duration)
            except (ValueError, TypeError) as e:
                target_logger.error(f"Step {i + 1}: Invalid sleep duration '{raw_duration}': {e}. Skipping.")
                continue
            target_logger.info(f"Step {i + 1}: Sleeping for {seconds}s...")
            time.sleep(seconds)
            target_logger.info(f"Step {i + 1}: Sleep complete.")
            continue

        is_contain_script = action.get("script") is not None
        is_contain_xpath = action.get("xpath") is not None
        if action_type in ("click", "get") and not (is_contain_script or is_contain_xpath):
            target_logger.error(f"Action {i + 1}: Missing 'xpath' or 'script' for action type '{action_type}'. Skipping.")
            continue

        if action_type == "click":
            iframe_title = action.get("iframe_title")
            script = action.get("script")

            target_logger.info(f"Step {i + 1}: Clicking element{' (inside iframe: ' + iframe_title + ')' if iframe_title else ''}...")
            try:
                scope = _enter_frame(page, iframe_title, target_logger, i + 1)

                if script:
                    target_logger.info(f"Step {i + 1}: Executing click script: `{script}`")
                    _eval_script(scope, script)
                    humanize_mouse(page, 3)
                else:
                    locator = scope.locator(f"xpath={xpath}").first
                    # Playwright auto-waits for the element to be actionable.
                    locator.scroll_into_view_if_needed(timeout=15000)
                    time.sleep(1)  # let any scroll-triggered content settle
                    try:
                        locator.click(timeout=15000)
                        humanize_mouse(page, 2)
                    except PlaywrightError:
                        target_logger.warning(f"Step {i + 1}: Standard click failed, using Javascript fallback.")
                        locator.evaluate("el => el.click()")

                    target_logger.info(f"Step {i + 1}: Click successful. Waiting {action_wait}s...")
                    time.sleep(action_wait)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: Click failed: {e}")
                if continue_on_failure:
                    target_logger.warning(f"Step {i + 1}: Continuing despite click failure (continue_on_failure=true).")
                    continue
                return extracted_values

        elif action_type == "fill":
            target_logger.info(f"Step {i + 1}: Filling element...")
            iframe_title = action.get("iframe_title")
            value_from = action.get("value_from")
            if not value_from:
                target_logger.error(f"Step {i + 1}: Missing 'value_from' for fill action.")
                continue

            secret_value = resolve_value(value_from, target_logger)
            if secret_value is None:
                target_logger.error(f"Step {i + 1}: Failed to resolve 'value_from': {value_from}")
                continue

            try:
                scope = _enter_frame(page, iframe_title, target_logger, i + 1)
                locator = scope.locator(f"xpath={xpath}").first
                locator.scroll_into_view_if_needed(timeout=15000)
                time.sleep(1)

                # fill() clears the field then types the value.
                locator.fill(str(secret_value))
                target_logger.info(f"Step {i + 1}: Fill successful. Waiting {action_wait}s...")
                humanize_mouse(page, 2)
                time.sleep(action_wait)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: Fill failed: {e}")
                if continue_on_failure:
                    target_logger.warning(f"Step {i + 1}: Continuing despite fill failure (continue_on_failure=true).")
                    continue
                return extracted_values

        elif action_type == "get":
            target_logger.info(f"Step {i + 1}: Extracting value...")
            iframe_title = action.get("iframe_title")
            script = action.get("script")

            try:
                scope = _enter_frame(page, iframe_title, target_logger, i + 1)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: Could not enter iframe for get: {e}")
                extracted_values.append(None)
                continue

            if script:
                # --- Script-based extraction ---
                try:
                    result_value = _eval_script(scope, script)
                    if result_value is None:
                        result_value = ""
                    result_value = str(result_value).strip()
                    target_logger.debug(f"Step {i + 1}: Script extracted '{result_value}'")

                    action_name = action.get("name")
                    options = action.get("telegram_message_options", [])

                    item = {"value": result_value, "options": options}
                    if action_name:
                        item["name"] = action_name
                    extracted_values.append(item)
                except Exception as e:
                    target_logger.error(f"Step {i + 1}: Script execution failed: {e}")
                    extracted_values.append(None)
            else:
                # --- XPath-based extraction ---
                # For attribute/text-node extraction use a `script` get instead;
                # locators resolve to elements.
                try:
                    locator = scope.locator(f"xpath={xpath}").first
                    text = locator.text_content(timeout=15000)
                    result_value = (text or "").strip()
                    target_logger.debug(f"Step {i + 1}: Extracted '{result_value}'")

                    action_name = action.get("name")
                    options = action.get("telegram_message_options", [])

                    item = {"value": result_value, "options": options}
                    if action_name:
                        item["name"] = action_name
                    extracted_values.append(item)
                except (PlaywrightError, PlaywrightTimeoutError):
                    target_logger.error(f"Step {i + 1}: No data found at XPath.")
                    extracted_values.append(None)

        else:
            target_logger.warning(f"Action {i + 1}: Unknown action type '{action_type}'. Skipping.")

    return extracted_values


def scrape_target(page, name, url, actions, wait_timeout, action_wait):
    target_logger = logging.getLogger(name)
    try:
        target_logger.info(f"Initiating extraction from {url}")
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        target_logger.info("Page opened, performing initial random mouse movement...")
        humanize_mouse(page, duration=2)

        # Scroll the page progressively to trigger lazy loading
        try:
            total_height = int(page.evaluate("() => document.body.scrollHeight"))
            for y in range(1, total_height, 400):
                page.evaluate(f"window.scrollTo(0, {y});")
                time.sleep(0.1)
            page.evaluate("window.scrollTo(0, 0);")  # Scroll back to top
        except Exception as e:
            target_logger.warning(f"Scrolling to trigger lazy loads failed: {e}")

        # Wait for JS content to load
        time.sleep(wait_timeout)

        # Validate that there is at least one 'get' action
        if not actions or not any(a.get("type") == "get" for a in actions):
            target_logger.warning("Invalid actions: Must contain at least one action of type 'get'.")

        results = execute_actions(page, target_logger, actions, action_wait)

        successful_results = [r for r in results if r is not None]

        extracted_items = []
        if successful_results:
            for res in successful_results:
                if isinstance(res, dict) and "value" in res:
                    val = res["value"]
                    options = res.get("options", [])
                    if "name" in res:
                        res_name = res["name"]
                        target_logger.info(f"Extraction successful: {name}. {res_name}: {val}")
                        extracted_items.append((f"{name} - {res_name}", val, options))
                    else:
                        target_logger.info(f"Extraction successful: {name}. Value: {val}")
                        extracted_items.append((name, val, options))
                elif isinstance(res, dict):
                    for key, val in res.items():
                        target_logger.info(f"Extraction successful: {name}. {key}: {val}")
                        extracted_items.append((f"{name} - {key}", val, []))
                else:
                    target_logger.info(f"Extraction successful: {name}. Value: {res}")
                    extracted_items.append((name, res, []))
            return extracted_items
        else:
            target_logger.error(f"Extraction failed: {name}.")
            return []

    except Exception as e:
        target_logger.error(f"An unexpected error occurred: {e}")
        return []


def run_all(config):
    """Open one browser session, run every target, and return the aggregated results.
    Shared by both the local entrypoint (main) and the Lambda handler."""
    targets = config.get("targets", [])
    wait_timeout = config.get("wait_timeout", 15)
    action_wait = config.get("action_wait", 2)
    keep_browser_open = config.get("keep_browser_open", False)
    storage_state = config.get("storage_state")

    all_results = []
    with sync_playwright() as p:
        browser, context = launch_context(p, config)
        page = context.new_page()
        try:
            for target in targets:
                name = target.get("name", "UnnamedTarget")
                url = target.get("url")
                actions = target.get("actions", [])

                if url and actions:
                    target_results = scrape_target(page, name, url, actions, wait_timeout, action_wait)
                    if target_results:
                        all_results.extend(target_results)
                else:
                    logger.warning(f"Skipping target '{name}': Missing URL or actions.")
        finally:
            # Persist cookies/session so the next run can reuse the login.
            if storage_state:
                try:
                    context.storage_state(path=storage_state)
                    logger.info(f"Saved browser session to {storage_state}")
                except Exception as e:
                    logger.warning(f"Failed to save storage_state: {e}")
            if not keep_browser_open:
                context.close()
                browser.close()
                logger.info("Browser closed.")
            else:
                # Note: under `with sync_playwright()` the browser is still torn
                # down when this function returns; keep_browser_open only skips
                # the explicit close for local interactive debugging.
                logger.info("Browser kept open as per configuration.")

    return all_results


def send_telegram_message(bot_token, chat_id, results):
    if not bot_token or not chat_id or not results:
        return

    blocks = []
    for item in results:
        if len(item) == 3:
            name, value, options = item
        else:
            name, value = item
            options = []

        safe_name = html_escape.escape(str(name))
        safe_value = html_escape.escape(str(value))

        no_codeblock = False
        other_options = {}
        if isinstance(options, list):
            for opt in options:
                if opt == "--no-codeblock":
                    no_codeblock = True
                elif isinstance(opt, dict):
                    other_options.update(opt)

        if no_codeblock:
            blocks.append(f"{safe_name}\n{safe_value}")
        else:
            blocks.append(f"{safe_name}\n<pre>{safe_value}</pre>")

    message = "\n".join(blocks)
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"

    try:
        response = requests.post(
            url,
            json={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
            headers={'Content-Type': 'application/json'}
        )
        response.raise_for_status()
        logger.info("Successfully sent Telegram message.")
    except requests.exceptions.RequestException as e:
        error_msg = e.response.text if e.response is not None else str(e)
        logger.error(f"Failed to send Telegram message: {error_msg}")


def main():
    try:
        config = load_config()

        if not config:
            logger.error(f"Configuration not found. Please set CONFIG_JSON env var or create <name>.json and pass to `CONFIG_FILE=<name>.json python3 scraper.py`")
            return

        if config.get("region"):
            os.environ["region"] = config.get("region")

        targets = config.get("targets", [])
        if not isinstance(targets, list) or len(targets) == 0:
            logger.error("Invalid config: 'targets' must be a non-empty list.")
            return

        logger.info(f"Starting scraping process for {len(targets)} targets.")

        all_results = run_all(config)

        logger.info("All scraping tasks processed.")

        telegram_bot_token = resolve_value(config.get("telegram_bot_token") or os.environ.get("TELEGRAM_BOT_TOKEN"))
        telegram_chat_id = resolve_value(config.get("telegram_chat_id") or os.environ.get("TELEGRAM_CHAT_ID"))
        if telegram_bot_token and telegram_chat_id and all_results:
            send_telegram_message(telegram_bot_token, telegram_chat_id, all_results)

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse config.json: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred during execution: {e}")


if __name__ == "__main__":
    main()
