import fs from "node:fs";
import { isLambda } from "./util.js";

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

let logFileFailed = false;

function threshold() {
    const name = (process.env.LOG_LEVEL || "INFO").toUpperCase();
    return LEVELS[name === "WARN" ? "WARNING" : name] ?? LEVELS.INFO;
}

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, name, message) {
    if (LEVELS[level] < threshold()) return;

    // Lambda prepends its own timestamp in CloudWatch, so leave ours out there.
    // console.warn/error map to WARN/ERROR levels in the Lambda log stream.
    if (isLambda()) {
        const line = `[${level}] [${name}] ${message}`;
        if (level === "ERROR") console.error(line);
        else if (level === "WARNING") console.warn(line);
        else console.log(line);
        return;
    }

    // Locally: stdout plus an append-only log file (LOG_FILE, default scraper_run.log).
    const line = `[${timestamp()}] [${level}] [${name}] ${message}`;
    console.log(line);
    if (logFileFailed) return;
    try {
        fs.appendFileSync(process.env.LOG_FILE || "scraper_run.log", `${line}\n`);
    } catch (e) {
        logFileFailed = true;
        console.log(`[${timestamp()}] [WARNING] [Logger] Cannot write log file: ${e.message}`);
    }
}

/** A named logger with DEBUG / INFO / WARNING / ERROR levels. */
export function getLogger(name = "Scraper") {
    return {
        debug: (message) => write("DEBUG", name, message),
        info: (message) => write("INFO", name, message),
        warning: (message) => write("WARNING", name, message),
        error: (message) => write("ERROR", name, message),
    };
}
