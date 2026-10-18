import { a1Range, appendValues, columnLetters, getValues, sheetTitles, updateValues } from "./google.js";
import { resolveValue } from "./resolve.js";
import { checkColumns, digitCount, isName, plainNumber } from "./util.js";

/** Every row starts with these columns, so `columns` can't write them. */
const RESERVED = ["scraped_at", "target"];

/** The output fields every google_sheets output needs. */
const REQUIRED = ["spreadsheet_id", "client_email", "private_key"];

/** What's wrong with a `type: "google_sheets"` output definition, or null. */
export function checkSheetsOutput(output) {
    for (const key of REQUIRED) {
        if (!isName(output[key])) return `needs a '${key}'.`;
    }
    if (output.tab !== undefined && !isName(output.tab)) return "'tab' must be a non-empty string.";
    return null;
}

/**
 * What's wrong with the options a target gives a google_sheets output, or null:
 *   { "name": "sheets", "tab": "<tab>", "columns": { "<get action name>": "<column>" } }
 * The target's `tab` wins over the output's; one of them must be set.
 */
export function checkSheetsRoute(options, output) {
    const { tab, columns, ...rest } = options;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) return `unknown option(s) ${unknown.join(", ")} (google_sheets takes 'tab' and 'columns').`;
    if (tab !== undefined && !isName(tab)) return "'tab' must be a non-empty string.";
    if (tab === undefined && output.tab === undefined) return "needs a 'tab', on the target's entry or on the output.";
    if (columns === undefined) return null;
    return checkColumns(columns, RESERVED, "is reserved (every row starts with scraped_at and target)");
}

/**
 * A scraped value as a cell: a plain number ("66,100.00") as a JSON number,
 * anything else as the scraped string. Numbers of more than 15 digits stay
 * strings, since Sheets stores doubles and would round them.
 */
export function toSheetsCell(value) {
    const number = plainNumber(value);
    return number !== null && digitCount(number) <= 15 ? Number(number) : String(value);
}

/**
 * One record per target: scraped_at (`now`, ISO 8601 UTC), target, then one
 * cell per value. With `columns`, only the mapped fields are written, under
 * the mapped names; without, every field is written under its own name. A
 * `get` without a name is the field "value". Targets with nothing to write
 * are left out. Returns [{ target, record: Map<column, cell> }].
 */
export function buildSheetsRecords(results, optionsByTarget, now, logger) {
    const records = [];
    for (const [target, targetResults] of Map.groupBy(results, (r) => r.target)) {
        const columns = optionsByTarget.get(target)?.columns;
        const record = new Map([["scraped_at", now.toISOString()], ["target", target]]);
        const written = new Set();
        for (const { field = "value", value } of targetResults) {
            const column = columns === undefined ? field : Object.hasOwn(columns, field) ? columns[field] : undefined;
            if (column === undefined || value == null) continue;
            if (RESERVED.includes(column)) {
                logger.warning(`Google Sheets: '${target}' field '${field}' not written: '${column}' is a reserved column.`);
                continue;
            }
            record.set(column, toSheetsCell(value));
            written.add(field);
        }
        const missing = Object.keys(columns ?? {}).filter((f) => !written.has(f));
        if (missing.length > 0) {
            logger.warning(`Google Sheets: no value for '${target}' field(s) ${missing.join(", ")}; those cells are left empty.`);
        }
        if (written.size > 0) records.push({ target, record });
    }
    return records;
}

/**
 * Lay a record out under a tab's header (row 1): each cell goes in the
 * column whose header is its name, the first one if a name repeats. Names
 * the header lacks are added to its end; existing headers never move or
 * change. Returns { added: names to add to the header, row: the new row }.
 */
export function placeRecord(header, record) {
    const index = new Map();
    header.forEach((name, i) => {
        if (!index.has(name)) index.set(name, i);
    });
    const added = [];
    for (const name of record.keys()) {
        if (index.has(name)) continue;
        index.set(name, header.length + added.length);
        added.push(name);
    }
    const row = [];
    for (const [name, cell] of record) row[index.get(name)] = cell;
    return { added, row: Array.from(row, (cell) => cell ?? "") };
}

/** Append one record to a tab, writing the header first where row 1 lacks its names. */
async function appendRecord(auth, spreadsheetId, tab, record) {
    const [header = []] = await getValues(auth, spreadsheetId, a1Range(tab, "1:1"));
    const { added, row } = placeRecord(header.map(String), record);
    if (added.length > 0) {
        const first = columnLetters(header.length);
        const last = columnLetters(header.length + added.length - 1);
        await updateValues(auth, spreadsheetId, a1Range(tab, `${first}1:${last}1`), [added]);
    }
    await appendValues(auth, spreadsheetId, a1Range(tab, "A1"), [row]);
}

/**
 * Sender for `type: "google_sheets"` outputs: one appended row per target
 * routed to it, in the target's `tab` or else the output's. The tab must
 * exist. spreadsheet_id, client_email, private_key and tab accept
 * secret_manager[...], string[...] or plain values. One target failing is
 * logged and doesn't stop the rest.
 */
export async function sendGoogleSheets(output, results, logger, optionsByTarget = new Map()) {
    if (results.length === 0) {
        logger.info("No results to write to Google Sheets.");
        return;
    }
    const resolved = {};
    for (const key of [...REQUIRED, "tab"]) resolved[key] = await resolveValue(output[key], logger);
    const missing = REQUIRED.filter((key) => !resolved[key]);
    if (missing.length > 0) {
        const verb = missing.length > 1 ? "are" : "is";
        logger.warning(`Google Sheet rows not written: ${missing.join(", ")} ${verb} empty or could not be resolved.`);
        return;
    }
    const spreadsheetId = resolved.spreadsheet_id;
    const auth = { clientEmail: resolved.client_email, privateKey: resolved.private_key };

    const records = buildSheetsRecords(results, optionsByTarget, new Date(), logger);
    let titles = [];
    if (records.length > 0) {
        try {
            titles = await sheetTitles(auth, spreadsheetId);
        } catch (e) {
            logger.error(`Failed to read Google Sheet ${spreadsheetId}: ${e.message}`);
            return;
        }
    }

    let appended = 0;
    for (const { target, record } of records) {
        const tab = optionsByTarget.get(target)?.tab ?? resolved.tab;
        try {
            if (!tab) throw new Error("no tab: the output's 'tab' is empty or could not be resolved.");
            if (!titles.includes(tab)) throw new Error(`tab '${tab}' doesn't exist (tabs: ${titles.join(", ")}). Create it first.`);
            await appendRecord(auth, spreadsheetId, tab, record);
            appended += 1;
        } catch (e) {
            logger.error(`Failed to append '${target}' to Google Sheet ${spreadsheetId}: ${e.message}`);
        }
    }
    logger.info(`Appended ${appended} row(s) to Google Sheet ${spreadsheetId}.`);
}
