// Call the Lambda handler on your machine, without Docker:
//   CONFIG_FILE=examples/get-xpath.json npm run invoke [-- event.json]
// The optional event file may carry a "targets" array that overrides the config's.
import fs from "node:fs";
import { handler } from "../src/lambda.js";

const eventFile = process.argv[2];
const event = eventFile ? JSON.parse(fs.readFileSync(eventFile, "utf8")) : {};

const result = await handler(event, {});
console.log(JSON.stringify(result, null, 2));
if (result.statusCode !== 200) process.exitCode = 1;
