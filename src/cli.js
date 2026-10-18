// Local entry point:  CONFIG_FILE=examples/get-xpath.json npm start
import { setAwsRegion } from "./aws.js";
import { loadConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { describeRoutes, routeOutputs, sendOutputs } from "./outputs.js";
import { runAll } from "./scraper.js";

const logger = getLogger("Scraper");

async function main() {
    let config;
    try {
        config = loadConfig(logger);
    } catch (e) {
        logger.error(`Failed to parse config: ${e.message}`);
        return 1;
    }

    if (!config) {
        logger.error("Configuration not found. Please set CONFIG_JSON env var or create <name>.json "
            + "and run `CONFIG_FILE=<name>.json npm start`");
        return 1;
    }

    setAwsRegion(config.region);

    const targets = config.targets;
    if (!Array.isArray(targets) || targets.length === 0) {
        logger.error("Invalid config: 'targets' must be a non-empty list.");
        return 1;
    }

    let routes;
    try {
        routes = routeOutputs(config, targets, undefined);
    } catch (e) {
        logger.error(`Invalid config: ${e.message}`);
        return 1;
    }

    logger.info(`Starting scraping process for ${targets.length} targets.`);
    logger.info(`Outputs: ${describeRoutes(routes)}.`);
    const results = await runAll(config);
    logger.info("All scraping tasks processed.");

    await sendOutputs(routes, results, logger);
    return 0;
}

main().then(
    (code) => { process.exitCode = code; },
    (e) => {
        logger.error(`An unexpected error occurred during execution: ${e.message}`);
        process.exitCode = 1;
    },
);
