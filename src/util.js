import { setTimeout as delay } from "node:timers/promises";

export const isLambda = () => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

/** Sleep for a number of seconds (fractions allowed). */
export const sleep = (seconds) => delay(Math.max(0, Number(seconds) || 0) * 1000);

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A target's name, as used in results, logs, `only` and output routing. */
export const targetName = (target) => target.name ?? "UnnamedTarget";

/** Random integer in [min, max], both inclusive. */
export const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * Read a boolean config flag. Strings are parsed, so "false" is false
 * rather than truthy.
 */
export function toBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === "string") {
        return ["true", "1", "yes", "y", "on"].includes(value.trim().toLowerCase());
    }
    return Boolean(value);
}
