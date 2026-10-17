import fs from "node:fs";

/**
 * Load configuration from the CONFIG_JSON environment variable (highest priority),
 * or fall back to the file pointed to by CONFIG_FILE (default: config.json).
 *
 * Returns the parsed config object, or null if no config could be found.
 * Throws if the JSON is malformed.
 */
export function loadConfig(logger) {
    if (process.env.CONFIG_JSON) {
        logger.info("Loading configuration from environment variable CONFIG_JSON");
        return JSON.parse(process.env.CONFIG_JSON);
    }

    const configFile = process.env.CONFIG_FILE || "config.json";
    if (fs.existsSync(configFile)) {
        logger.info(`Loading configuration from file ${configFile}`);
        return JSON.parse(fs.readFileSync(configFile, "utf8"));
    }

    return null;
}
