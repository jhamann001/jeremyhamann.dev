import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPORT_IDENTITY,
  buildMoveCheckReport,
  reportCustodianSnapshot,
  type StoredEvidenceItem,
} from "@/lib/data/custodian-snapshot-evidence";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export type ReportDeps = {
  read: (snapshotSha256: string) => Promise<readonly StoredEvidenceItem[] | null>;
  write: (name: string) => Promise<void>;
};

function installServerOnlyResolver(): void {
  require("tsx/cjs");
  const moduleApi = require("node:module") as {
    _resolveFilename: (this: unknown, request: string, ...args: unknown[]) => string;
  };
  const original = moduleApi._resolveFilename;
  const marker = require.resolve("next/dist/compiled/server-only/empty.js");
  moduleApi._resolveFilename = function (this: unknown, request: string, ...args: unknown[]) {
    return request === "server-only" ? marker : original.call(this, request, ...args);
  };
}

function snapshotSha(argv: readonly string[]): string {
  const index = argv.indexOf("--snapshot-sha256");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || !/^[0-9a-f]{64}$/.test(value)) throw new Error("usage");
  return value;
}

export async function runCustodianSnapshotReport(argv: readonly string[], deps: ReportDeps): Promise<{ stdout: string; exitCode: number }> {
  const snapshotSha256 = snapshotSha(argv);
  const stored = await deps.read(snapshotSha256);
  const report = buildMoveCheckReport(snapshotSha256, stored == null ? null : [...stored]);
  return { stdout: `${JSON.stringify(report)}\n`, exitCode: report.refused ? 1 : 0 };
}

async function main(): Promise<number> {
  const snapshotSha256 = snapshotSha(process.argv);
  if (!process.env.DATABASE_URL) throw new Error("usage");
  installServerOnlyResolver();
  const scope = require(path.join(root, "lib/rls.ts")) as {
    withUserScope: <T>(identity: typeof REPORT_IDENTITY, fn: (tx: unknown) => Promise<T>) => Promise<T>;
  };
  const report = await scope.withUserScope(REPORT_IDENTITY, (tx) => reportCustodianSnapshot(snapshotSha256, tx as Parameters<typeof reportCustodianSnapshot>[1]));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.refused ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "usage"}\n`);
    process.exitCode = 1;
  });
}
