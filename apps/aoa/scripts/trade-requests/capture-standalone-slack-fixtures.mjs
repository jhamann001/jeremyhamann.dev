// Captures the standalone Trade Request Slack messages (ticket wording fixture).
// Run from "$TRADE_REQUEST_SERVICE_DIR/server" with `npx tsx` (the standalone checkout pinned at d41b6c9) and
// SLACK_BOT_TOKEN=xoxb-fixture SLACK_CHANNEL_ID=CFIXTURE DRIFT_SLACK_CHANNEL_ID=CDRIFT
// CLIENT_ORIGIN=https://standalone.example LOG_LEVEL=silent; prints JSON to stdout. Nothing reaches Slack:
// WebClient.prototype.apiCall is replaced by a recorder before the standalone module loads.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CASES } from "./slack-fixture-cases.mjs";

const dir = process.env.TRADE_REQUEST_SERVICE_DIR;
if (!dir) throw new Error("TRADE_REQUEST_SERVICE_DIR is not set");
const serverDir = join(dir, "server");

const require = createRequire(join(serverDir, "package.json"));
const { WebClient } = require("@slack/web-api");
const recorded = [];
WebClient.prototype.apiCall = async function apiCall(method, options) {
  recorded.push({ method, channel: options?.channel, text: options?.text });
  return { ok: true };
};

const slack = await import(pathToFileURL(join(serverDir, "src/services/slack.ts")).href);

const out = {};
for (const [name, [fn, input]] of Object.entries(CASES)) {
  const before = recorded.length;
  await slack[fn](input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const posts = recorded.slice(before);
  if (posts.length !== 1 || posts[0].method !== "chat.postMessage") {
    throw new Error(`${name}: expected exactly one chat.postMessage, saw ${posts.length}`);
  }
  out[name] = { channel: posts[0].channel, text: posts[0].text };
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
