import json
import os
import logging
from scraper import run_all, setup_logging, load_config, send_telegram_message, resolve_value

# Reuse the logger configuration from scraper.py or set up new one
logger = setup_logging()


def lambda_handler(event, context):
    """
    AWS Lambda entry point.
    Expects config in 'CONFIG_JSON' env var (priority), 'config.json' file, or passed via event (optional).
    """
    try:
        config = load_config()

        if not config:
            return {
                "statusCode": 500,
                "body": json.dumps({"error": "Configuration not found. Please set CONFIG_JSON env var or provide a config file."})
            }

        if config.get("region"):
            os.environ["region"] = config.get("region")

        # Allow event to override the target list
        if event and event.get("targets"):
            config["targets"] = event["targets"]

        targets = config.get("targets", [])
        if not targets:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "No targets configured."})
            }

        logger.info(f"Starting Lambda scraping for {len(targets)} targets.")

        all_results = run_all(config)

        telegram_bot_token = resolve_value(config.get("telegram_bot_token") or os.environ.get("TELEGRAM_BOT_TOKEN"), logger)
        telegram_chat_id = resolve_value(config.get("telegram_chat_id") or os.environ.get("TELEGRAM_CHAT_ID"), logger)
        if telegram_bot_token and telegram_chat_id and all_results:
            send_telegram_message(telegram_bot_token, telegram_chat_id, all_results)

        return {
            "statusCode": 200,
            "body": json.dumps({"message": "Scraping completed successfully.", "results": len(all_results)})
        }

    except Exception as e:
        logger.error(f"Lambda execution failed: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
