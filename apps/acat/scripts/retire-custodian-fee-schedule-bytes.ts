import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  decideFeeScheduleByteRetirement,
  type FeeScheduleIdentity,
} from "../src/lib/custodian-fee-documents";

const CONFIRM = "RETIRE_CUSTODIAN_FEE_SCHEDULE_BYTES";
const APPROVAL_LINE = "retention-approved: ticket custodian fee-schedule bytes";
const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SELECT = { id: true, byteSize: true, sha256: true } as const;

type RetirementClient = {
  custodianFeeScheduleDocument: {
    findMany: (args: { select: typeof SELECT }) => Promise<FeeScheduleIdentity[]>;
    updateMany: (args: {
      where: { id: { in: string[] } };
      data: { content: null };
    }) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: RetirementClient) => Promise<T>) => Promise<T>;
};

export function readRetirementGates(argv: readonly string[]):
  | { ok: false; line: "retirement-refused: missing-gate" }
  | { ok: true; evidencePath: string; backupId: string; retentionPath: string } {
  const missing = { ok: false as const, line: "retirement-refused: missing-gate" as const };
  const value = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next === "" || next.startsWith("--")) return undefined;
    return next;
  };
  const evidencePath = value("--evidence");
  const backupId = value("--backup-id");
  const retentionPath = value("--retention-record");
  const confirm = value("--confirm");
  if (!evidencePath || !backupId || !retentionPath || confirm !== CONFIRM) return missing;
  return { ok: true, evidencePath, backupId, retentionPath };
}

export function retentionApproved(text: string): boolean {
  return text.split("\n").includes(APPROVAL_LINE);
}

export function backupIdAccepted(backupId: string): boolean {
  return BACKUP_ID.test(backupId);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
}

export async function clearRetiredFeeScheduleBytes(
  client: RetirementClient,
  evidence: readonly FeeScheduleIdentity[],
): Promise<{ cleared: number } | { refused: "duplicate-id" | "unexpected-evidence-file" | "missing-stored-file" | "byte-count" | "checksum" }> {
  const stored = await client.custodianFeeScheduleDocument.findMany({ select: SELECT });
  const decision = decideFeeScheduleByteRetirement(stored, evidence);
  if (decision.action === "refuse") return { refused: decision.reason };
  const ids = decision.ids;
  return client.$transaction(async (tx) => {
    const again = await tx.custodianFeeScheduleDocument.findMany({ select: SELECT });
    const second = decideFeeScheduleByteRetirement(again, evidence);
    if (second.action !== "clear" || !sameIds(second.ids, ids)) {
      throw new Error("retirement-refused: comparison-changed");
    }
    await tx.custodianFeeScheduleDocument.updateMany({
      where: { id: { in: ids } },
      data: { content: null },
    });
    return { cleared: ids.length };
  });
}

function evidenceDocuments(text: string): FeeScheduleIdentity[] | null {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("documents" in parsed)) return null;
  const documents = (parsed as { documents?: unknown }).documents;
  if (!Array.isArray(documents)) return null;
  const rows: FeeScheduleIdentity[] = [];
  for (const row of documents) {
    if (typeof row !== "object" || row === null) return null;
    const record = row as { id?: unknown; byteSize?: unknown; sha256?: unknown };
    if (typeof record.id !== "string" || typeof record.byteSize !== "number" || typeof record.sha256 !== "string") {
      return null;
    }
    rows.push({ id: record.id, byteSize: record.byteSize, sha256: record.sha256 });
  }
  return rows;
}

async function main() {
  const gates = readRetirementGates(process.argv.slice(2));
  if (!gates.ok) {
    console.log(gates.line);
    process.exit(2);
  }
  let documents: FeeScheduleIdentity[] | null = null;
  try {
    const approved = retentionApproved(readFileSync(gates.retentionPath, "utf8"));
    const backupOk = backupIdAccepted(gates.backupId);
    documents = evidenceDocuments(readFileSync(gates.evidencePath, "utf8"));
    if (!approved || !backupOk || documents === null) {
      console.log("retirement-refused: missing-gate");
      process.exit(2);
    }
  } catch {
    console.log("retirement-refused: missing-gate");
    process.exit(2);
  }
  // Dynamic import is the documented exception: a missing gate must not construct PrismaClient.
  const { prisma } = await import("../src/lib/prisma");
  const result = await clearRetiredFeeScheduleBytes(prisma as unknown as RetirementClient, documents);
  if ("refused" in result) {
    console.log(`retirement-refused: ${result.refused}`);
    process.exit(3);
  }
  console.log(`retirement-cleared: ${result.cleared}`);
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
