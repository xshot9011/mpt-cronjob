// Generate a macOS launchd .plist that runs the scraper once a day:
//   npm run setup-cron -- --hour 13 --minute 0 [--config examples/simple.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PLIST_FILE = "com.user.mpt-cronjob.plist";
const LABEL = "com.user.mpt-cronjob";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
    options: {
        hour: { type: "string", default: "13" },
        minute: { type: "string", default: "0" },
        config: { type: "string" },
    },
});

const hour = Number(values.hour);
const minute = Number(values.minute);
if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    console.error("Error: --hour must be 0-23 and --minute must be 0-59.");
    process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, "node_modules", "playwright"))) {
    console.error(`Error: dependencies not installed in ${ROOT}. Run \`npm ci\` first.`);
    process.exit(1);
}

const xml = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

// launchd starts with a minimal environment, so use absolute paths throughout.
const envBlock = values.config
    ? `
    <key>EnvironmentVariables</key>
    <dict>
        <key>CONFIG_FILE</key>
        <string>${xml(path.resolve(values.config))}</string>
    </dict>`
    : "";

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(process.execPath)}</string>
        <string>${xml(path.join(ROOT, "src", "cli.js"))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(ROOT)}</string>${envBlock}
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(path.join(ROOT, "stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(path.join(ROOT, "stderr.log"))}</string>
</dict>
</plist>
`;

fs.writeFileSync(path.join(ROOT, PLIST_FILE), plist);

console.log(`Successfully generated ${PLIST_FILE}`);
console.log("\nTo install the cronjob, run:");
console.log(`cp ${PLIST_FILE} ~/Library/LaunchAgents/`);
console.log(`launchctl load ~/Library/LaunchAgents/${PLIST_FILE}`);
console.log("\nTo unload it later:");
console.log(`launchctl unload ~/Library/LaunchAgents/${PLIST_FILE}`);
console.log(`rm ~/Library/LaunchAgents/${PLIST_FILE}`);
