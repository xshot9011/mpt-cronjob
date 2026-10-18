import { setTimeout as delay } from "node:timers/promises";

export const isLambda = () => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

/** Sleep for a number of seconds (fractions allowed). */
export const sleep = (seconds) => delay(Math.max(0, Number(seconds) || 0) * 1000);

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const isName = (v) => typeof v === "string" && v !== "";

const NUMBER_RE = /^[+-]?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$/;

/**
 * A scraped value that is a plain number, without thousands separators or a
 * leading "+" ("1,234.56" -> "1234.56"); null when it isn't one ("17 Oct
 * 2026", "1.2%", "007"). Each output applies its own digit limit.
 */
export function plainNumber(value) {
    const s = String(value).trim();
    return NUMBER_RE.test(s) ? s.replace(/,/g, "").replace(/^\+/, "") : null;
}

/** How many digits a plainNumber() string has ("-1234.56" -> 6). */
export const digitCount = (number) => number.replace(/\D/g, "").length;

/**
 * What's wrong with a target's `columns` option ({ "<field>": "<column>" }),
 * or null. `reserved` are the columns the output writes itself; mapping a
 * field to one is refused with "column '<name>' <why>."
 */
export function checkColumns(columns, reserved, why) {
    if (!isPlainObject(columns) || Object.keys(columns).length === 0 || !Object.values(columns).every(isName)) {
        return "'columns' must map field names to column names.";
    }
    const seen = new Set();
    for (const column of Object.values(columns)) {
        if (reserved.includes(column)) return `column '${column}' ${why}.`;
        if (seen.has(column)) return `more than one field writes column '${column}'.`;
        seen.add(column);
    }
    return null;
}

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
