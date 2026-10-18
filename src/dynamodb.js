import { awsJsonCall } from "./aws.js";
import { resolveValue } from "./resolve.js";
import { isPlainObject } from "./util.js";

const isName = (v) => typeof v === "string" && v !== "";

/** The table's key attribute names: [partition key, sort key or null for none]. */
function keyNames(output) {
    return [output.partition_key ?? "target", output.sort_key === undefined ? "scraped_at" : output.sort_key];
}

/** What's wrong with a `type: "dynamodb"` output definition, or null. */
export function checkDynamoOutput(output) {
    if (!isName(output.table)) return "needs a 'table'.";
    const [partitionKey, sortKey] = keyNames(output);
    if (!isName(partitionKey)) return "'partition_key' must be a non-empty string.";
    if (sortKey !== null && !isName(sortKey)) return "'sort_key' must be a non-empty string, or null for a table without one.";
    if (sortKey === partitionKey) return "'partition_key' and 'sort_key' must differ.";
    if (output.region !== undefined && !isName(output.region)) return "'region' must be a non-empty string.";
    return null;
}

/**
 * What's wrong with the options a target gives a dynamodb output, or null:
 *   { "name": "dynamodb", "columns": { "<get action name>": "<column>" } }
 */
export function checkDynamoRoute(options, output) {
    const { columns, ...rest } = options;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) return `unknown option(s) ${unknown.join(", ")} (dynamodb takes 'columns').`;
    if (columns === undefined) return null;
    if (!isPlainObject(columns) || Object.keys(columns).length === 0 || !Object.values(columns).every(isName)) {
        return "'columns' must map field names to column names.";
    }
    const keys = keyNames(output);
    const seen = new Set();
    for (const column of Object.values(columns)) {
        if (keys.includes(column)) return `column '${column}' is one of the table's key attributes.`;
        if (seen.has(column)) return `more than one field writes column '${column}'.`;
        seen.add(column);
    }
    return null;
}

const NUMBER_RE = /^[+-]?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$/;

/**
 * A scraped value as a DynamoDB number ("1,234.56" -> "1234.56"), or null when
 * it isn't a plain number ("17 Oct 2026", "1.2%", "007") and stays a string.
 */
export function toDynamoNumber(value) {
    const s = String(value).trim();
    if (!NUMBER_RE.test(s)) return null;
    const number = s.replace(/,/g, "").replace(/^\+/, "");
    return number.replace(/\D/g, "").length <= 38 ? number : null; // DynamoDB keeps 38 digits
}

/**
 * One item per target: the key attributes (partition key = target name, sort
 * key = `now`), then one column per value. With `columns`, only the mapped
 * fields are written, under the mapped names; without, every field is written
 * under its own name. A `get` without a name is the field "value".
 * Returns [{ target, item }] in DynamoDB's attribute-value format.
 */
export function buildDynamoItems(output, results, optionsByTarget, now, logger) {
    const [partitionKey, sortKey] = keyNames(output);
    const byTarget = new Map();
    for (const result of results) {
        if (!byTarget.has(result.target)) byTarget.set(result.target, []);
        byTarget.get(result.target).push(result);
    }

    const items = [];
    for (const [target, targetResults] of byTarget) {
        const columns = optionsByTarget.get(target)?.columns;
        const item = { [partitionKey]: { S: target } };
        if (sortKey !== null) item[sortKey] = { S: now.toISOString() };
        const written = new Set();
        for (const { field = "value", value } of targetResults) {
            const column = columns === undefined ? field : Object.hasOwn(columns, field) ? columns[field] : undefined;
            if (column === undefined || value == null) continue;
            if (column === partitionKey || column === sortKey) {
                logger.warning(`DynamoDB: '${target}' field '${field}' not written: '${column}' is a key attribute.`);
                continue;
            }
            const number = toDynamoNumber(value);
            item[column] = number === null ? { S: String(value) } : { N: number };
            written.add(field);
        }
        const missing = Object.keys(columns ?? {}).filter((f) => !written.has(f));
        if (missing.length > 0) {
            logger.warning(`DynamoDB: no value for '${target}' field(s) ${missing.join(", ")}; those columns are left out.`);
        }
        if (written.size > 0) items.push({ target, item });
    }
    return items;
}

/**
 * Sender for `type: "dynamodb"` outputs: one PutItem per target routed to it.
 * `table` accepts secret_manager[...], string[...] or a plain name. One item
 * failing is logged and doesn't stop the rest.
 */
export async function sendDynamoDB(output, results, logger, optionsByTarget = new Map()) {
    if (results.length === 0) {
        logger.info("No results to write to DynamoDB.");
        return;
    }
    const table = await resolveValue(output.table, logger);
    if (!table) {
        logger.warning("DynamoDB items not written: table is empty or could not be resolved.");
        return;
    }
    let written = 0;
    for (const { target, item } of buildDynamoItems(output, results, optionsByTarget, new Date(), logger)) {
        try {
            await awsJsonCall({
                service: "dynamodb",
                endpointId: "DYNAMODB",
                contentType: "application/x-amz-json-1.0",
                amzTarget: "DynamoDB_20120810.PutItem",
                payload: { TableName: table, Item: item },
                region: output.region,
            });
            written += 1;
        } catch (e) {
            logger.error(`Failed to write '${target}' to DynamoDB table '${table}': ${e.message}`);
        }
    }
    logger.info(`Wrote ${written} item(s) to DynamoDB table '${table}'.`);
}
