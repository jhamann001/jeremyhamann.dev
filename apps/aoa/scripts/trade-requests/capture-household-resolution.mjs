// Records the standalone resolver's output for the synthetic household cases (ticket).
// Run from $TRADE_REQUEST_SERVICE_DIR/server with: npx tsx <this file>
import { pathToFileURL } from "node:url";
import { CASES, CLIENTS, householdConfig } from "./household-resolution-cases.mjs";

const dir = process.env.TRADE_REQUEST_SERVICE_DIR;
if (!dir) throw new Error("set TRADE_REQUEST_SERVICE_DIR");
const { resolveHouseholdsForClients } = await import(pathToFileURL(`${dir}/server/src/services/householdResolution.ts`).href);
const out = {};
for (const [name, input] of Object.entries(CASES)) {
  out[name] = resolveHouseholdsForClients({ ...input, clients: CLIENTS, householdConfig: householdConfig() });
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
