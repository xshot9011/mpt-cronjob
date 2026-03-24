import os
import json
import logging
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from lxml import html

# --- Configuration ---
CONFIG_FILE = "config.json"
LOG_FILE = "scraper_run.log"

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("Scraper")


def create_driver(chrome_driver_path=None, headless=True):
    """Create a Chrome WebDriver instance."""
    chrome_options = Options()
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
    """Execute a list of actions sequentially. Returns the extracted value from the final 'get' action."""
    result_value = None

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
                return None

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
            else:
                target_logger.error(f"Step {i + 1}: No data found at XPath.")
                return None

        else:
            target_logger.warning(f"Action {i + 1}: Unknown action type '{action_type}'. Skipping.")

    return result_value


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

        # Validate that the last action is 'get'
        if not actions or actions[-1].get("type") != "get":
            target_logger.error("Invalid actions: The last action must be of type 'get'.")
            return

        result = execute_actions(driver, target_logger, actions, action_wait)

        if result is not None:
            target_logger.info(f"Extraction successful: {name}. Value: {result}")
        else:
            target_logger.error(f"Extraction failed: {name}.")

    except Exception as e:
        target_logger.error(f"An unexpected error occurred: {e}")


def main():
    if not os.path.exists(CONFIG_FILE):
        logger.error(f"Configuration file {CONFIG_FILE} not found.")
        return

    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)

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
        try:
            for target in targets:
                name = target.get("name", "UnnamedTarget")
                url = target.get("url")
                actions = target.get("actions", [])

                if url and actions:
                    scrape_target(driver, name, url, actions, wait_timeout, action_wait)
                else:
                    logger.warning(f"Skipping target '{name}': Missing URL or actions.")
        finally:
            driver.quit()
            logger.info("Browser closed.")

        logger.info("All scraping tasks processed.")

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse config.json: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred during execution: {e}")


if __name__ == "__main__":
    main()
