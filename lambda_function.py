import json
import os
import logging
from scraper import create_driver, scrape_target

# Reuse the logger configuration from scraper.py or set up new one
logger = logging.getLogger("LambdaHandler")

def lambda_handler(event, context):
    """
    AWS Lambda entry point.
    Expects config in 'config.json' file or passed via event (optional).
    """
    config_file = os.environ.get("CONFIG_FILE", "config.json")
    
    if not os.path.exists(config_file):
        return {
            "statusCode": 500,
            "body": json.dumps({"error": f"Configuration file {config_file} not found."})
        }

    try:
        with open(config_file, "r") as f:
            config = json.load(f)

        # Allow event to override target list
        targets = event.get("targets", config.get("targets", []))
        chrome_driver_path = config.get("chrome_driver_path")
        headless = config.get("headless", True)
        wait_timeout = config.get("wait_timeout", 15)
        action_wait = config.get("action_wait", 2)

        if not targets:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "No targets configured."})
            }

        logger.info(f"Starting Lambda scraping for {len(targets)} targets.")
        
        driver = create_driver(chrome_driver_path, headless)
        results = []
        
        try:
            for target in targets:
                name = target.get("name", "UnnamedTarget")
                url = target.get("url")
                actions = target.get("actions", [])

                if url and actions:
                    # scrape_target logs results internally
                    scrape_target(driver, name, url, actions, wait_timeout, action_wait)
                else:
                    logger.warning(f"Skipping target '{name}': Missing URL or actions.")
        finally:
            driver.quit()

        return {
            "statusCode": 200,
            "body": json.dumps({"message": "Scraping completed successfully."})
        }

    except Exception as e:
        logger.error(f"Lambda execution failed: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
