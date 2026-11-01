import { inspectLegacy } from "./legacy";
import { pathToFileURL } from "node:url";
import { sha256 } from "./canonical";
import { safeErrorCode } from "./engine";
import { readJson, writeRestricted } from "./files";
import { buildManifest, summarizeManifest, validateManifest } from "./manifest";
import { validateEvidence } from "./match";
import { reviewPacket } from "./review-packet";
import { importWarehouse } from "./warehouse";
import { acceptCoverage, coverageSummary, sourceCoverage } from "./coverage";

export function parseArgs(args: string[]): { command: string; values: Record<string, string> } {
  const [command = "help", ...rest] = args;
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error("INVALID_ARGUMENTS");
    const key = rest[i].slice(2);
    if (values[key]) throw new Error("DUPLICATE_ARGUMENT");
    values[key] = rest[i + 1];
  }
  return { command, values };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, values } = parseArgs(args);
  const required = (key: string) => { if (!values[key]) throw new Error(`MISSING_${key.replace(/-/g, "_").toUpperCase()}`); return values[key]; };
  if (command === "help") {
    console.log("ticket identity backfill v2: inspect-legacy | import-warehouse | accept-coverage | plan | summary | review-packet | bind-directory | apply | verify | undo-plan | undo-apply. Writes require an exact reviewed digest, approval reference, explicit target and credential variable; default commands are read-only. accept-coverage records an owner assumption only; it grants no row or production-write approval.");
    return;
  }
  if (command === "import-warehouse") {
    const evidence = importWarehouse(readJson(required("directory")), readJson(required("accounts")), readJson(required("transfers")), required("extracted-at"), required("snapshot-id"));
    writeRestricted(required("out"), evidence);
    console.log(JSON.stringify({ evidenceHash: sha256(evidence), clients: evidence.clients.length, accountRows: evidence.accounts.length, transferRows: evidence.transfers.length, upstreamFreshness: evidence.upstreamFreshness }));
    return;
  }
  if (command === "accept-coverage") {
    const evidence = acceptCoverage(readJson(required("evidence")), { acceptedBy: required("accepted-by"), acceptedAt: required("accepted-at"), reference: required("reference"), reason: required("reason") });
    writeRestricted(required("out"), evidence);
    console.log(JSON.stringify({ evidenceHash: sha256(evidence), sourceCoverage: coverageSummary(sourceCoverage(evidence)) }));
    return;
  }
  if (command === "plan") {
    const manifest = buildManifest(readJson(required("tracker")), readJson(required("evidence")));
    writeRestricted(required("out"), manifest);
    console.log(JSON.stringify(summarizeManifest(manifest)));
    return;
  }
  if (command === "inspect-legacy") {
    console.log(JSON.stringify(inspectLegacy(readJson(required("artifact")))));
    return;
  }
  if (command === "summary") {
    const input = readJson(required("manifest"));
    const legacy = typeof input === "object" && input !== null && "version" in input && input.version === 1;
    console.log(JSON.stringify(legacy ? inspectLegacy(input) : summarizeManifest(validateManifest(input))));
    return;
  }
  if (command === "review-packet") {
    const manifest = validateManifest(readJson(required("manifest")));
    const evidence = validateEvidence(readJson(required("evidence")));
    writeRestricted(required("out"), reviewPacket(manifest, evidence), true);
    console.log(JSON.stringify({ records: manifest.rows.length, manifestHash: sha256(manifest), reviewPacketWritten: true }));
    return;
  }
  // Database commands are loaded only on demand so early warehouse planning
  // needs neither a DB credential nor an already migrated generated client.
  const { databaseCommand } = await import("./database-cli");
  await databaseCommand(command, values);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ error: safeErrorCode(error) })); process.exitCode = 1; });
}
