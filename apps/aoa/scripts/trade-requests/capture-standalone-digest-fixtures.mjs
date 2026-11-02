// Captures the standalone Trade Request digest exactly as the standalone service posts it (ticket).
// Run from "$TRADE_REQUEST_SERVICE_DIR/server" with npx tsx; prints JSON to stdout. Never contacts Slack or a database.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { CASES } from "./digest-fixture-cases.mjs";

const serverDir = process.cwd();
const require = createRequire(path.join(serverDir, "package.json"));
const { WebClient } = require("@slack/web-api");

let posts = [];
WebClient.prototype.apiCall = async function apiCall(method, options) {
  posts.push({ method, channel: options.channel, mrkdwn: options.mrkdwn, text: options.text });
  return { ok: true };
};

const digest = await import(pathToFileURL(path.join(serverDir, "src/services/digest.ts")).href);

const out = {};
for (const [name, c] of Object.entries(CASES)) {
  posts = [];
  let claim = null;
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO digest_runs/.test(sql)) {
        claim = { runDate: params[0], summary: params[1] };
        return { rows: c.claimed ? [] : [{ run_date: params[0] }] };
      }
      return { rows: structuredClone(c.rows) };
    },
  };
  const result = await digest.sendDailyDigest(pool, new Date(c.now));
  out[name] = { result: { sent: result.sent, reason: result.reason ?? null }, claim, posts };
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
