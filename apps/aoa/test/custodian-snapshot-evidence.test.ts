import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { markCase } from "./acat-book-flywheel";
import {
  EVIDENCE_REPORT_SELECT,
  REPORT_IDENTITY,
  buildMoveCheckReport,
  orderMoveCheckItems,
  reportCustodianSnapshot,
  type MoveCheckKind,
  type StoredEvidenceItem,
} from "@/lib/data/custodian-snapshot-evidence";
import { runCustodianSnapshotReport } from "@/scripts/report-custodian-snapshot-import";

const SHA = "0".repeat(64);
const HEX = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
};

function row(kind: MoveCheckKind, originalId: string, authorityId: string, byteCount: number, checksum: string, revision: number | null): StoredEvidenceItem {
  return { kind, originalId, authorityId, byteCount, checksum, revision, confirmed: true };
}

const SOURCE_A: StoredEvidenceItem[] = [
  row("custodian", "cus_z", "auth_z", 10, HEX.a, 1),
  row("fee_rule", "fee_z", "fee_auth_z", 11, HEX.b, 1),
  row("fee_schedule_file", "file_z", "file_z", 12, HEX.c, null),
  row("custodian", "cus_a", "auth_a", 13, HEX.d, 2),
  row("fee_rule", "fee_a", "fee_auth_a", 14, HEX.e, 2),
  row("fee_schedule_file", "file_a", "file_a", 15, HEX.f, null),
];

const CANONICAL_IDS = ["cus_a", "cus_z", "fee_a", "fee_z", "file_a", "file_z"];

function reportJson(stored: readonly StoredEvidenceItem[]): string {
  return JSON.stringify(buildMoveCheckReport(SHA, stored));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custodian snapshot move check", () => {
  it("orders two custodians by kind then originalId", () => {
    expect(SOURCE_A[0].originalId).toBe("cus_z");
    const report = buildMoveCheckReport(SHA, SOURCE_A);
    expect(report.refused).toBeNull();
    if (report.refused) return;
    expect(report.items.map((item) => item.originalId)).toEqual(CANONICAL_IDS);
    expect(report.items.map((item) => item.kind)).toEqual([
      "custodian", "custodian", "fee_rule", "fee_rule", "fee_schedule_file", "fee_schedule_file",
    ]);
    expect(orderMoveCheckItems(SOURCE_A)[0].originalId).toBe("cus_a");
    markCase("custodian-snapshot-evidence", "orders two custodians by kind then originalId");
  });

  it("swapped source order and a resumed fee stringify to the same report", () => {
    const swapped = [...SOURCE_A].reverse();
    expect(swapped[0].originalId).toBe("file_a");
    const fee = SOURCE_A.find((item) => item.originalId === "fee_a");
    if (!fee) throw new Error("missing fee_a");
    const resumed = [...SOURCE_A.filter((item) => item.originalId !== "fee_a"), fee];
    expect(resumed[resumed.length - 1].originalId).toBe("fee_a");
    const first = reportJson(SOURCE_A);
    expect(reportJson(swapped)).toBe(first);
    expect(reportJson(resumed)).toBe(first);
    expect(first).toContain("\"originalId\":\"cus_a\"");
    const cusA = first.indexOf("\"originalId\":\"cus_a\"");
    const cusZ = first.indexOf("\"originalId\":\"cus_z\"");
    const feeA = first.indexOf("\"originalId\":\"fee_a\"");
    const fileZ = first.indexOf("\"originalId\":\"file_z\"");
    expect(cusA < cusZ && cusZ < feeA && feeA < fileZ).toBe(true);
    markCase("custodian-snapshot-evidence", "swapped source order and a resumed fee stringify to the same report");
  });

  it("a second call returns that same string", () => {
    const first = reportJson(SOURCE_A);
    const second = reportJson(SOURCE_A);
    expect(second).toBe(first);
    expect(second.startsWith("{\"refused\":null,\"snapshotSha256\":\"" + SHA + "\"")).toBe(true);
    markCase("custodian-snapshot-evidence", "a second call returns that same string");
  });

  it("the select lists evidence columns and has no content or orderBy", async () => {
    const keys = Object.keys(EVIDENCE_REPORT_SELECT.items.select).sort().join(",");
    expect(keys).toBe("authorityId,byteCount,checksum,confirmed,kind,originalId,revision");
    expect(Object.hasOwn(EVIDENCE_REPORT_SELECT.items, "orderBy")).toBe(false);
    const seen: unknown[] = [];
    const db = {
      custodianSnapshotImport: {
        async findUnique(args: { select: typeof EVIDENCE_REPORT_SELECT }) {
          seen.push(args.select);
          return { items: SOURCE_A };
        },
      },
    };
    const report = await reportCustodianSnapshot(SHA, db);
    expect(seen).toEqual([EVIDENCE_REPORT_SELECT]);
    expect(report.refused).toBeNull();
    markCase("custodian-snapshot-evidence", "the select lists evidence columns and has no content or orderBy");
  });

  it("an incomplete run returns storedCount and confirmedCount", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const partial = SOURCE_A.map((item, index) => index === 4 ? { ...item, confirmed: false } : item);
    const report = buildMoveCheckReport(SHA, partial);
    expect(report).toEqual({ refused: "incomplete", snapshotSha256: SHA, storedCount: 6, confirmedCount: 5 });
    expect(Object.hasOwn(report, "items")).toBe(false);
    expect(errors.some((line) => line.includes("\"feature\":\"custodian-snapshot-evidence\"") && line.includes("\"outcome\":\"incomplete\""))).toBe(true);
    markCase("custodian-snapshot-evidence", "an incomplete run returns storedCount and confirmedCount");
  });

  it("a missing run returns evidence_missing", () => {
    const report = buildMoveCheckReport(SHA, null);
    expect(report).toEqual({ refused: "evidence_missing", snapshotSha256: SHA });
    expect(Object.hasOwn(report, "items")).toBe(false);
    markCase("custodian-snapshot-evidence", "a missing run returns evidence_missing");
  });

  it("the command prints the ordered JSON when the import switch is off", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "0";
    const writes: string[] = [];
    const first = await runCustodianSnapshotReport(["--snapshot-sha256", SHA], {
      read: async () => SOURCE_A,
      write: async (name: string) => {
        writes.push(name);
      },
    });
    const second = await runCustodianSnapshotReport(["--snapshot-sha256", SHA], {
      read: async () => [...SOURCE_A].reverse(),
      write: async (name: string) => {
        writes.push(name);
      },
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(`${reportJson(SOURCE_A)}\n`);
    expect(second.stdout).toBe(first.stdout);
    expect(writes).toEqual([]);
    const missing = await runCustodianSnapshotReport(["--snapshot-sha256", SHA], {
      read: async () => null,
      write: async () => {
        writes.push("write");
      },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe(`${JSON.stringify({ refused: "evidence_missing", snapshotSha256: SHA })}\n`);
    markCase("custodian-snapshot-evidence", "the command prints the ordered JSON when the import switch is off");
  });
});

const gated = process.env.CUSTODIAN_EVIDENCE_TEST_DB === "1" ? describe : describe.skip;

gated("stored evidence reads back in canonical order", () => {
  it("reads stored rows in canonical order without writing authority", async () => {
    const ownerUrl = process.env.DIRECT_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !appUrl || !ownerUrl.includes("aoa_tkt420") || !appUrl.includes("aoa_tkt420")) {
      throw new Error("scratch database aoa_tkt420 is required");
    }
    const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const importId = `tkt420_${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 12)}`;
    try {
      await owner.custodianSnapshotImport.create({
        data: {
          id: importId,
          snapshotSha256: SHA,
          items: {
            create: SOURCE_A.map((item) => ({
              id: `${importId}_${item.originalId}`,
              kind: item.kind,
              originalId: item.originalId,
              authorityId: item.authorityId,
              byteCount: item.byteCount,
              checksum: item.checksum,
              revision: item.revision == null ? null : BigInt(item.revision),
              confirmed: true,
            })),
          },
        },
      });
      const report = await withUserScope(REPORT_IDENTITY, (tx) => reportCustodianSnapshot(SHA, tx as unknown as Parameters<typeof reportCustodianSnapshot>[1]));
      expect(report.refused).toBeNull();
      if (report.refused) return;
      expect(report.items.map((item) => item.originalId)).toEqual(CANONICAL_IDS);
      const profiles = await owner.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM app.custodian_profile`;
      const documents = await owner.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM app.custodian_fee_schedule_document`;
      expect(profiles[0].n).toBe(0);
      expect(documents[0].n).toBe(0);
      expect(JSON.stringify(report).includes("content")).toBe(false);
    } finally {
      await owner.custodianSnapshotImportItem.deleteMany({ where: { importId } });
      await owner.custodianSnapshotImport.deleteMany({ where: { id: importId } });
      await owner.$disconnect();
    }
    markCase("custodian-snapshot-evidence", "reads stored rows in canonical order without writing authority", "integration");
  });
});
