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

# --- Configuration ---
CONFIG_FILE = "config.json"
LOG_FILE = "scraper_run.log"

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


def create_driver(chrome_driver_path=None, headless=True):
    """Create a Chrome WebDriver instance, with specific settings for AWS Lambda if detected."""
    is_lambda = os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None
    chrome_options = Options()

    if is_lambda:
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

        driver_path = "/opt/bin/chromedriver"
        service = Service(executable_path=driver_path)
        return webdriver.Chrome(service=service, options=chrome_options)
    
    # Local environment
    if headless:
        chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

    if chrome_driver_path:
        service = Service(executable_path=chrome_driver_path)
        driver = webdriver.Chrome(service=service, options=chrome_options)
    else:
        driver = webdriver.Chrome(options=chrome_options)

    return driver


from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

def execute_actions(driver, target_logger, actions, action_wait):
    """Execute a list of actions sequentially. Returns a list of extracted values from 'get' actions."""
    extracted_values = []

    for i, action in enumerate(actions):
        action_type = action.get("type")
        xpath = action.get("xpath")

        if not action_type or not xpath:
            target_logger.error(f"Action {i + 1}: Missing 'type' or 'xpath'. Skipping.")
            continue

        if action_type == "click":
            target_logger.info(f"Step {i + 1}: Clicking element...")
            try:
                # Wait for element to be present in DOM
                wait = WebDriverWait(driver, 15)
                element = wait.until(EC.presence_of_element_located((By.XPATH, xpath)))
                
                # Scroll element into the center of the viewport
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
                time.sleep(1) # Wait for scrolling to finish
                
                # Attempt standard click, fallback to javascript click
                try:
                    element.click()
                except Exception as click_err:
                    target_logger.warning(f"Step {i + 1}: Standard click failed, using Javascript fallback.")
                    driver.execute_script("arguments[0].click();", element)
                    
                target_logger.info(f"Step {i + 1}: Click successful. Waiting {action_wait}s...")
                time.sleep(action_wait)
            except Exception as e:
                target_logger.error(f"Step {i + 1}: Click failed: {e}")
                return extracted_values

        elif action_type == "get":
            target_logger.info(f"Step {i + 1}: Extracting value...")
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
                if action_name:
                    extracted_values.append({action_name: result_value})
                else:
                    extracted_values.append(result_value)
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
            target_logger.error("Invalid actions: Must contain at least one action of type 'get'.")
            return []

        results = execute_actions(driver, target_logger, actions, action_wait)
        
        successful_results = [r for r in results if r is not None]

        extracted_items = []
        if successful_results:
            for res in successful_results:
                if isinstance(res, dict):
                    for key, val in res.items():
                        target_logger.info(f"Extraction successful: {name}. {key}: {val}")
                        extracted_items.append((f"{name} - {key}", val))
                else:
                    target_logger.info(f"Extraction successful: {name}. Value: {res}")
                    extracted_items.append((name, res))
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
    for name, value in results:
        safe_name = html_escape.escape(str(name))
        safe_value = html_escape.escape(str(value))
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
            logger.error(f"Configuration not found. Please set CONFIG_JSON env var or create {CONFIG_FILE}.")
            return

        chrome_driver_path = config.get("chrome_driver_path")
        headless = config.get("headless", True)
        wait_timeout = config.get("wait_timeout", 15)
        action_wait = config.get("action_wait", 2)
        targets = config.get("targets", [])

        if not isinstance(targets, list) or len(targets) == 0:
            logger.error("Invalid config: 'targets' must be a non-empty list.")
            return

        logger.info(f"Starting scraping process for {len(targets)} targets.")

        driver = create_driver(chrome_driver_path, headless)
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
            driver.quit()
            logger.info("Browser closed.")

        logger.info("All scraping tasks processed.")
        
        telegram_bot_token = config.get("telegram_bot_token") or os.environ.get("TELEGRAM_BOT_TOKEN")
        telegram_chat_id = config.get("telegram_chat_id") or os.environ.get("TELEGRAM_CHAT_ID")
        if telegram_bot_token and telegram_chat_id and all_results:
            send_telegram_message(telegram_bot_token, telegram_chat_id, all_results)

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse config.json: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred during execution: {e}")


if __name__ == "__main__":
    main()
