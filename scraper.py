import os
import json
import logging
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from lxml import html
import sys
import requests
import re
import boto3
import random
from selenium.webdriver import ActionChains

# --- Configuration ---
CONFIG_FILE = os.environ.get("CONFIG_FILE", "config.json")
LOG_FILE = os.environ.get("LOG_FILE", "scraper_run.log")

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


def create_driver(chrome_driver_path=None, headless=True, keep_browser_open=False):
    """Create a Chrome WebDriver instance, with specific settings for AWS Lambda if detected."""
    is_lambda = os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None
    chrome_options = Options()

    if is_lambda:
        logger.info("Create driver with lambda env")
        # Standard Lambda Chrome options
        chrome_options.binary_location = "/opt/bin/headless-chromium/chrome-headless-shell"
        chrome_options.add_argument("--headless=new")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-tools")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--disable-gpu")
        chrome_options.add_argument("--no-zygote")
        chrome_options.add_argument("--single-process")
        chrome_options.add_argument("--data-path=/tmp/data-path")
        chrome_options.add_argument("--disk-cache-dir=/tmp/cache-dir")
        chrome_options.add_argument("--remote-debugging-pipe")
        chrome_options.add_argument("--verbose")
        chrome_options.add_argument("--log-path=/tmp")
        chrome_options.add_argument("--disable-blink-features=AutomationControlled")
        chrome_options.add_argument("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.22 Safari/537.36")
        chrome_options.add_argument("--window-size=1920,1080")

        driver_path = "/opt/bin/chromedriver"
        service = Service(executable_path=driver_path)
        return webdriver.Chrome(service=service, options=chrome_options)
    
    # Local environment
    if headless:
        chrome_options.add_argument("--headless=new")
    
    if keep_browser_open and not is_lambda:
        chrome_options.add_experimental_option("detach", True)

    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.22 Safari/537.36")

    if chrome_driver_path:
        service = Service(executable_path=chrome_driver_path)
        driver = webdriver.Chrome(service=service, options=chrome_options)
    else:
        driver = webdriver.Chrome(options=chrome_options)

    return driver

def random_mouse_movements(driver, duration=5, interval=0.2):
    """
    Simulate random mouse movements over the page to mimic human interaction.
    Parameters:
        driver: Selenium WebDriver instance.
        duration: Total time in seconds to perform movements.
        interval: Time between movements in seconds.
    """
    try:
        is_lambda = os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None
        if is_lambda:
            # In Lambda the display is headless; use JavaScript to dispatch mousemove events
            end_time = time.time() + duration
            while time.time() < end_time:
                # Random coordinates within the viewport
                viewport = driver.get_window_size()
                width = viewport.get('width', 1920)
                height = viewport.get('height', 1080)
                x = random.randint(0, max(width - 1, 0))
                y = random.randint(0, max(height - 1, 0))
                # Dispatch a mousemove event at (x, y)
                script = """
                var ev = new MouseEvent('mousemove', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: %d,
                    clientY: %d
                });
                document.elementFromPoint(%d, %d).dispatchEvent(ev);
                """ % (x, y, x, y)
                try:
                    driver.execute_script(script)
                except Exception as js_err:
                    logger.debug(f"JS mouse move error: {js_err}")
                time.sleep(interval)
            return
        # Non-Lambda (local) environment – use ActionChains with body element
        viewport = driver.get_window_size()
        viewport_width = viewport.get('width', 1920)
        viewport_height = viewport.get('height', 1080)
        body = driver.find_element(By.TAG_NAME, 'body')
        body_size = body.size
        width = int(body_size.get('width', viewport_width))
        height = int(body_size.get('height', viewport_height))
        end_time = time.time() + duration
        while time.time() < end_time:
            x_offset = random.randint(0, max(width - 1, 0))
            y_offset = random.randint(0, max(height - 1, 0))
            try:
                ActionChains(driver).move_to_element_with_offset(body, x_offset, y_offset).perform()
            except Exception as move_err:
                logger.debug(f"Random mouse move out of bounds ({x_offset},{y_offset}): {move_err}")
                try:
                    ActionChains(driver).move_to_element_with_offset(body, 0, 0).perform()
                except Exception:
                    pass
            time.sleep(interval)
    except Exception as e:
        logger.warning(f"Random mouse movement encountered an error: {e}")


from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

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
#                      CapSolver CAPTCHA solving integration                   #
# ---------------------------------------------------------------------------- #
CAPSOLVER_API_BASE = os.environ.get("CAPSOLVER_API_BASE", "https://api.capsolver.com")

# Maps the friendly `captcha_type` from config to:
#   (CapSolver proxy-less task type, the field in `solution` holding the token)
CAPSOLVER_TASK_MAP = {
    "recaptcha_v2": ("ReCaptchaV2TaskProxyLess", "gRecaptchaResponse"),
    "recaptcha_v3": ("ReCaptchaV3TaskProxyLess", "gRecaptchaResponse"),
    "turnstile": ("AntiTurnstileTaskProxyLess", "token"),
    "hcaptcha": ("HCaptchaTaskProxyLess", "gRecaptchaResponse"),
}

# JS snippets that try to read the site key from the DOM when it is not in config.
_SITEKEY_DETECT_JS = {
    "recaptcha_v2": """
        var el = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
        if (el) { return el.getAttribute('data-sitekey'); }
        var ifr = document.querySelector('iframe[src*="recaptcha"]');
        if (ifr) { var m = ifr.src.match(/[?&]k=([^&]+)/); if (m) { return decodeURIComponent(m[1]); } }
        return null;
    """,
    "hcaptcha": """
        var el = document.querySelector('.h-captcha[data-sitekey], [data-sitekey]');
        if (el) { return el.getAttribute('data-sitekey'); }
        var ifr = document.querySelector('iframe[src*="hcaptcha"]');
        if (ifr) { var m = ifr.src.match(/[?&]sitekey=([^&]+)/); if (m) { return decodeURIComponent(m[1]); } }
        return null;
    """,
    "turnstile": """
        var el = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey]');
        if (el) { return el.getAttribute('data-sitekey'); }
        return null;
    """,
}
# reCAPTCHA v3 detects the same way as v2.
_SITEKEY_DETECT_JS["recaptcha_v3"] = _SITEKEY_DETECT_JS["recaptcha_v2"]

# JS that writes the solved token into the response field(s) the page expects,
# creating the field if the widget never rendered it (common in headless).
_INJECT_TOKEN_JS = """
var token = arguments[0];
var fieldNames = arguments[1];
var tag = arguments[2]; // 'textarea' or 'input'
fieldNames.forEach(function (name) {
    var els = document.querySelectorAll(tag + '[name="' + name + '"], #' + name);
    if (els.length === 0) {
        var el = document.createElement(tag);
        el.name = name;
        el.id = name;
        el.style.display = 'block';
        document.body.appendChild(el);
        els = [el];
    }
    els.forEach(function (el) {
        el.value = token;
        if (tag === 'textarea') { el.innerHTML = token; }
    });
});
return true;
"""

# Best-effort firing of a reCAPTCHA callback so pages relying on it proceed.
_INVOKE_RECAPTCHA_CALLBACK_JS = """
var token = arguments[0];
try {
    var cfg = window.___grecaptcha_cfg;
    if (!cfg || !cfg.clients) { return false; }
    var fired = false;
    Object.values(cfg.clients).forEach(function (client) {
        Object.values(client).forEach(function (level1) {
            if (level1 && typeof level1 === 'object') {
                Object.values(level1).forEach(function (level2) {
                    if (level2 && typeof level2 === 'object' && typeof level2.callback === 'function') {
                        try { level2.callback(token); fired = true; } catch (e) {}
                    }
                });
            }
        });
    });
    return fired;
} catch (e) { return false; }
"""

# Which response field names each CAPTCHA writes its token into.
_TOKEN_FIELDS = {
    "recaptcha_v2": (["g-recaptcha-response"], "textarea"),
    "recaptcha_v3": (["g-recaptcha-response"], "textarea"),
    "hcaptcha": (["h-captcha-response", "g-recaptcha-response"], "textarea"),
    "turnstile": (["cf-turnstile-response"], "input"),
}


def solve_captcha_with_capsolver(api_key, captcha_type, website_url, website_key,
                                 page_action, timeout, target_logger,
                                 poll_interval=3.0):
    """
    Submit a CAPTCHA to CapSolver and poll until the token is ready.
    Returns the solved token string, or raises on error/timeout.
    """
    task_type, solution_field = CAPSOLVER_TASK_MAP[captcha_type]

    task = {
        "type": task_type,
        "websiteURL": website_url,
        "websiteKey": website_key,
    }
    if captcha_type == "recaptcha_v3":
        # pageAction must match the value the site uses; default to a common one.
        task["pageAction"] = page_action or "verify"
    elif captcha_type == "turnstile" and page_action:
        # Turnstile carries the action (and optional cdata) under metadata.
        task["metadata"] = {"action": page_action}

    create_resp = requests.post(
        f"{CAPSOLVER_API_BASE}/createTask",
        json={"clientKey": api_key, "task": task},
        timeout=30,
    )
    create_resp.raise_for_status()
    create_data = create_resp.json()
    if create_data.get("errorId"):
        raise RuntimeError(
            f"CapSolver createTask failed: {create_data.get('errorCode')} - "
            f"{create_data.get('errorDescription')}"
        )

    task_id = create_data.get("taskId")
    if not task_id:
        raise RuntimeError("CapSolver createTask returned no taskId.")

    target_logger.info(f"CapSolver task created ({task_id}); polling for result...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(poll_interval)
        result_resp = requests.post(
            f"{CAPSOLVER_API_BASE}/getTaskResult",
            json={"clientKey": api_key, "taskId": task_id},
            timeout=30,
        )
        result_resp.raise_for_status()
        result_data = result_resp.json()
        if result_data.get("errorId"):
            raise RuntimeError(
                f"CapSolver getTaskResult failed: {result_data.get('errorCode')} - "
                f"{result_data.get('errorDescription')}"
            )

        status = result_data.get("status")
        if status == "ready":
            token = (result_data.get("solution") or {}).get(solution_field)
            if not token:
                raise RuntimeError(
                    f"CapSolver returned ready but no '{solution_field}' in solution."
                )
            return token
        # status == "processing" (or "idle") -> keep polling
        target_logger.debug(f"CapSolver task {task_id} status: {status}")

    raise TimeoutError(f"CapSolver did not solve the CAPTCHA within {timeout}s.")


def inject_captcha_token(driver, captcha_type, token, invoke_callback, target_logger):
    """Write the solved token into the page and optionally fire the reCAPTCHA callback."""
    field_names, tag = _TOKEN_FIELDS[captcha_type]
    driver.execute_script(_INJECT_TOKEN_JS, token, field_names, tag)
    target_logger.info(f"Injected CAPTCHA token into: {', '.join(field_names)}")

    if invoke_callback and captcha_type in ("recaptcha_v2", "recaptcha_v3"):
        try:
            fired = driver.execute_script(_INVOKE_RECAPTCHA_CALLBACK_JS, token)
            target_logger.info(
                "reCAPTCHA callback fired." if fired
                else "No reCAPTCHA callback found to fire."
            )
        except Exception as e:
            target_logger.warning(f"reCAPTCHA callback invocation failed: {e}")


# ---------------------------------------------------------------------------- #
#                          TODO: Simplify action order                         #
# ---------------------------------------------------------------------------- #
def execute_actions(driver, target_logger, actions, action_wait):
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
                current_url = driver.current_url
                parsed = urlparse(current_url)
                # Rebuild origin: scheme://netloc  (includes port if non-standard)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                # Ensure path starts with /
                if path and not path.startswith("/"):
                    path = "/" + path
                destination = origin + path
                target_logger.info(f"Step {i + 1}: Switching path to '{destination}'...")
                driver.get(destination)
                target_logger.info(f"Step {i + 1}: Navigated to '{destination}'. Waiting {action_wait}s...")
                time.sleep(action_wait)
                random_mouse_movements(driver, 2)
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

        if action_type == "solve_captcha":
            captcha_type = (action.get("captcha_type") or "recaptcha_v2").lower()
            if captcha_type not in CAPSOLVER_TASK_MAP:
                target_logger.error(
                    f"Step {i + 1}: Unsupported captcha_type '{captcha_type}'. "
                    f"Expected one of {list(CAPSOLVER_TASK_MAP)}."
                )
                if continue_on_failure:
                    continue
                return extracted_values

            # API key: resolve via secret_manager[...]/string[...]/plain, else env var.
            api_key_from = action.get("api_key_from")
            api_key = (
                resolve_value(api_key_from, target_logger) if api_key_from
                else os.environ.get("CAPSOLVER_API_KEY")
            )
            if not api_key:
                target_logger.error(
                    f"Step {i + 1}: No CapSolver API key. Set 'api_key_from' or the "
                    f"CAPSOLVER_API_KEY env var."
                )
                if continue_on_failure:
                    continue
                return extracted_values

            website_url = action.get("website_url") or driver.current_url
            website_key = action.get("website_key")
            if not website_key:
                try:
                    website_key = driver.execute_script(_SITEKEY_DETECT_JS[captcha_type])
                except Exception as e:
                    target_logger.warning(f"Step {i + 1}: Site key auto-detection failed: {e}")
                if website_key:
                    target_logger.info(f"Step {i + 1}: Auto-detected site key: {website_key}")
                else:
                    target_logger.error(
                        f"Step {i + 1}: Could not determine site key. Provide 'website_key'."
                    )
                    if continue_on_failure:
                        continue
                    return extracted_values

            try:
                timeout = parse_duration(action.get("timeout", 120))
            except (ValueError, TypeError):
                timeout = 120.0

            target_logger.info(
                f"Step {i + 1}: Solving {captcha_type} via CapSolver for {website_url}..."
            )
            try:
                token = solve_captcha_with_capsolver(
                    api_key=api_key,
                    captcha_type=captcha_type,
                    website_url=website_url,
                    website_key=website_key,
                    page_action=action.get("page_action"),
                    timeout=timeout,
                    target_logger=target_logger,
                )
                inject_captcha_token(
                    driver, captcha_type, token,
                    action.get("invoke_callback", False), target_logger,
                )
                target_logger.info(f"Step {i + 1}: CAPTCHA solved. Waiting {action_wait}s...")
                time.sleep(action_wait)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: CAPTCHA solving failed: {e}")
                if continue_on_failure:
                    target_logger.warning(
                        f"Step {i + 1}: Continuing despite CAPTCHA failure (continue_on_failure=true)."
                    )
                    continue
                return extracted_values
            continue

        is_missing_x_path = False
        is_contain_script = action.get("script") is not None
        is_contain_xpath = action.get("xpath") is not None
        if action_type == "click" and not(is_contain_script or is_contain_xpath):
            is_missing_x_path = True
        if action_type == "get" and not(is_contain_script or is_contain_xpath):
            is_missing_x_path = True
        if is_missing_x_path:
            target_logger.error(f"Action {i + 1}: Missing 'xpath' for action type '{action_type}'. Skipping.")
            continue

        if action_type == "click":
            iframe_title = action.get("iframe_title")
            script = action.get("script")

            target_logger.info(f"Step {i + 1}: Clicking element{' (inside iframe: ' + iframe_title + ')' if iframe_title else ''}...")
            try:
                if iframe_title:
                    # Switch into the iframe identified by its title attribute
                    wait = WebDriverWait(driver, 15)
                    iframe_element = wait.until(
                        EC.presence_of_element_located(
                            (By.XPATH, f"//iframe[@title='{iframe_title}']")
                        )
                    )
                    driver.switch_to.frame(iframe_element)
                    target_logger.info(f"Step {i + 1}: Switched into iframe '{iframe_title}'.")

                try:
                    if script:
                        target_logger.info(f"Step {i + 1}: Executing click script: `{script}`")
                        driver.execute_script(script)
                        random_mouse_movements(driver, 3)
                    else:
                        # Wait for element to be present in DOM (inside iframe if applicable)
                        wait = WebDriverWait(driver, 15)
                        element = wait.until(EC.presence_of_element_located((By.XPATH, xpath)))

                        # Scroll element into the center of the viewport
                        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
                        time.sleep(1)  # Wait for scrolling to finish

                        # Attempt standard click, fallback to javascript click
                        try:
                            element.click()
                            random_mouse_movements(driver, 2)
                        except Exception:
                            target_logger.warning(f"Step {i + 1}: Standard click failed, using Javascript fallback.")
                            driver.execute_script("arguments[0].click();", element)

                        target_logger.info(f"Step {i + 1}: Click successful. Waiting {action_wait}s...")
                        time.sleep(action_wait)
                finally:
                    if iframe_title:
                        # Always switch back to the main document
                        driver.switch_to.default_content()
                        target_logger.info(f"Step {i + 1}: Switched back to default content.")
            except Exception as e:
                target_logger.error(f"Step {i + 1}: Click failed: {e}")
                # Ensure we are back on the main document even after an error
                try:
                    driver.switch_to.default_content()
                except Exception:
                    pass
                if continue_on_failure:
                    target_logger.warning(f"Step {i + 1}: Continuing despite click failure (continue_on_failure=true).")
                    continue
                return extracted_values

        elif action_type == "fill":
            target_logger.info(f"Step {i + 1}: Filling element...")
            value_from = action.get("value_from")
            if not value_from:
                target_logger.error(f"Step {i + 1}: Missing 'value_from' for fill action.")
                continue
            
            secret_value = resolve_value(value_from, target_logger)
            if secret_value is None:
                target_logger.error(f"Step {i + 1}: Failed to resolve 'value_from': {value_from}")
                continue

            try:
                wait = WebDriverWait(driver, 15)
                element = wait.until(EC.presence_of_element_located((By.XPATH, xpath)))
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
                time.sleep(1)
                
                element.clear()
                element.send_keys(secret_value)
                target_logger.info(f"Step {i + 1}: Fill successful. Waiting {action_wait}s...")
                random_mouse_movements(driver, 2)
                time.sleep(action_wait)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: Fill failed: {e}")
                if continue_on_failure:
                    target_logger.warning(f"Step {i + 1}: Continuing despite fill failure (continue_on_failure=true).")
                    continue
                return extracted_values

        elif action_type == "get":
            target_logger.info(f"Step {i + 1}: Extracting value...")
            script = action.get("script")

            if script:
                # --- Script-based extraction ---
                try:
                    result_value = driver.execute_script(script)
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
                page_source = driver.page_source
                tree = html.fromstring(page_source)
                result = tree.xpath(xpath)

                if result:
                    first_match = result[0]
                    if hasattr(first_match, 'text_content'):
                        result_value = first_match.text_content().strip()
                    elif hasattr(first_match, 'strip'):
                        result_value = first_match.strip()
                    else:
                        result_value = str(first_match).strip()
                    target_logger.debug(f"Step {i + 1}: Extracted '{result_value}'")

                    action_name = action.get("name")
                    options = action.get("telegram_message_options", [])

                    item = {"value": result_value, "options": options}
                    if action_name:
                        item["name"] = action_name
                    extracted_values.append(item)
                else:
                    target_logger.error(f"Step {i + 1}: No data found at XPath.")
                    extracted_values.append(None)

        else:
            target_logger.warning(f"Action {i + 1}: Unknown action type '{action_type}'. Skipping.")

    return extracted_values


def scrape_target(driver, name, url, actions, wait_timeout, action_wait):
    target_logger = logging.getLogger(name)
    try:
        target_logger.info(f"Initiating extraction from {url}")
        driver.get(url)
        target_logger.info("Page opened, performing initial random mouse movement...")
        random_mouse_movements(driver, duration=2)

        # Scroll the page progressively to trigger lazy loading
        try:
            total_height = int(driver.execute_script("return document.body.scrollHeight"))
            for i in range(1, total_height, 400):
                driver.execute_script(f"window.scrollTo(0, {i});")
                time.sleep(0.1)
            driver.execute_script("window.scrollTo(0, 0);") # Scroll back to top
        except Exception as e:
            target_logger.warning(f"Scrolling to trigger lazy loads failed: {e}")

        # Wait for JS content to load
        time.sleep(wait_timeout)

        # Validate that there is at least one 'get' action
        if not actions or not any(a.get("type") == "get" for a in actions):
            target_logger.warning("Invalid actions: Must contain at least one action of type 'get'.")

        results = execute_actions(driver, target_logger, actions, action_wait)
        
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

import html as html_escape

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
            logger.error(f"Configuration not found. Please set CONFIG_JSON env var or create <name>.json and pass to `CONFIG_FILE=<name>.json python3 main.py`")
            return

        if config.get("region"):
            os.environ["region"] = config.get("region")

        chrome_driver_path = config.get("chrome_driver_path")
        headless = config.get("headless", True)
        wait_timeout = config.get("wait_timeout", 15)
        action_wait = config.get("action_wait", 2)
        keep_browser_open = config.get("keep_browser_open", False)
        targets = config.get("targets", [])

        if not isinstance(targets, list) or len(targets) == 0:
            logger.error("Invalid config: 'targets' must be a non-empty list.")
            return

        logger.info(f"Starting scraping process for {len(targets)} targets.")

        driver = create_driver(chrome_driver_path, headless, keep_browser_open)
        driver.execute_script("""
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            })
        """)
        all_results = []
        try:
            for target in targets:
                name = target.get("name", "UnnamedTarget")
                url = target.get("url")
                actions = target.get("actions", [])

                if url and actions:
                    target_results = scrape_target(driver, name, url, actions, wait_timeout, action_wait)
                    if target_results:
                        all_results.extend(target_results)
                else:
                    logger.warning(f"Skipping target '{name}': Missing URL or actions.")
        finally:
            if not keep_browser_open:
                driver.quit()
                logger.info("Browser closed.")
            else:
                logger.info("Browser kept open as per configuration.")

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
