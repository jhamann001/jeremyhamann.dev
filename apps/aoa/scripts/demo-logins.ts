// Gives the demo database's runtime logins their passwords and writes the settings the deploy hands the Worker as
// secrets (lib/demo/logins). Run as the owner, after the migrations:
//
//   DIRECT_DATABASE_URL=<owner URL> npm run demo:logins -- <json file>     (from apps/aoa)
//
// The file is one JSON object, readable only by its owner: the web service's four database settings
// (DATABASE_URL, DIRECT_DATABASE_URL, INGEST_DATABASE_URL, CRM_RECONCILER_DATABASE_URL) and RESET_GATE_TOKEN, the
// token the nightly reset shows the Worker's "resetting" page with. The deploy adds its other secrets and passes
// the file to `wrangler deploy --secrets-file`. Nothing secret is printed.

import { chmodSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { demoLoginUrls, demoResetGateToken, ensureDemoLogins } from "../lib/demo/logins";

async function main() {
  const file = process.argv[2];
  const ownerUrl = process.env.DIRECT_DATABASE_URL;
  if (!file || !ownerUrl) {
    console.error("usage: DIRECT_DATABASE_URL=<owner URL> npm run demo:logins -- <json file>");
    process.exit(1);
  }
  const settings = { ...demoLoginUrls(ownerUrl), RESET_GATE_TOKEN: demoResetGateToken(ownerUrl) };
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  try {
    await ensureDemoLogins(owner, ownerUrl);
  } finally {
    await owner.$disconnect();
  }
  writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Set the runtime logins' passwords and wrote ${Object.keys(settings).length} settings to ${file}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "demo_logins_failed");
  process.exit(1);
});
