import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  IMPORT_IDENTITY,
  feeDigest,
  importCustodianSnapshot,
  profileDigest,
  safeRevision,
  sha256Hex,
  type CustodianSnapshot,
  type ImportCustodianSnapshotDeps,
  type StoredImportItem,
} from "@/lib/data/custodian-snapshot-import";
import { readEvidenceRevision } from "@/scripts/import-custodian-snapshot";

const PDF = Buffer.from("%PDF-synthetic");
const FILE_SHA = "a01de6a6a86f3503b20a3a18ba0e5cca91f7ab089e7ab0d2e559297331b7294b";

const EVENT = {
  id: "auth_1",
  name: "Synthetic Custodian",
  fee_rules: [{
    id: "fee_auth_1",
    fee_type: "ACAT Out",
    account_type: "ANY",
    transfer_type: "FULL",
    direction: "OUT",
    amount: 25,
    notes: null,
    amount_text: null,
    documentation: null,
  }],
};

function snapshot(): CustodianSnapshot {
  return {
    schemaVersion: 1,
    custodians: [{
      id: "cus_synthetic_1",
      name: "Synthetic Custodian",
      reviewStatus: "VERIFIED",
      acatFeeAmount: 0,
      transferType: null,
      documentationStatus: null,
      dtcNumber: null,
      receivingAccountNumber: null,
      signature: null,
      letterOfAcceptance: null,
      medallionRequired: null,
      liquidationMethod: null,
      returnMethod: null,
      watchouts: null,
      paperworkOnFile: null,
      transfersToDate: null,
      avgProcessingDays: 7,
      contactEmail: null,
      contactMethod: null,
      contactDetails: null,
      fees: [{
        id: "fee_synthetic_1",
        feeType: "ACAT Out",
        accountType: "ANY",
        transferType: "FULL",
        direction: "OUT",
        amount: 25,
        amountText: null,
        notes: null,
        documentation: null,
        createdAt: "2026-10-19T16:00:00.000Z",
        updatedAt: "2026-10-19T16:00:00.000Z",
      }],
      feeScheduleDocuments: [{
        id: "file_synthetic_1",
        filename: "fees.pdf",
        contentType: "application/pdf",
        byteSize: 14,
        sha256: FILE_SHA,
        createdAt: "2026-10-19T16:00:00.000Z",
        createdBy: "admin@example.test",
      }],
    }],
  };
}

function files(): Record<string, Uint8Array> {
  return { file_synthetic_1: PDF };
}

function harness(state = { acceptedRevision: 0n, confirmedRevision: 0n }) {
  const saved: unknown[] = [];
  const confirmed: number[] = [];
  const inserted: Array<{ id: string; custodianId: string; content: Uint8Array }> = [];
  const runs = new Map<string, { id: string; items: StoredImportItem[] }>();
  const catalog: { rows: Array<{ revision: number; body: unknown }> } = { rows: [{ revision: 1, body: EVENT }] };
  const deps: ImportCustodianSnapshotDeps = {
    async saveCustodianAuthority(identity, input) {
      saved.push({ identity, input });
      state.acceptedRevision += 1n;
      return { ok: true, value: { custodianId: "auth_1", revision: state.acceptedRevision } };
    },
    async confirmCustodianAuthorityRevision(revision) {
      confirmed.push(revision);
      state.confirmedRevision = BigInt(revision);
    },
    async listCustodianAuthorityRevisions() {
      return catalog.rows;
    },
    async readAuthorityState() {
      return { ...state };
    },
    evidence: {
      async findRun(snapshotSha256) {
        return runs.get(snapshotSha256) ?? null;
      },
      async createRun(snapshotSha256) {
        const run = { id: `run_${runs.size + 1}`, items: [] as StoredImportItem[] };
        runs.set(snapshotSha256, run);
        return { id: run.id };
      },
      async upsertItem(importId, item) {
        const run = [...runs.values()].find((candidate) => candidate.id === importId);
        if (!run) throw new Error("missing run");
        const index = run.items.findIndex((existing) => existing.kind === item.kind && existing.originalId === item.originalId);
        if (index === -1) run.items.push(item);
        else run.items[index] = item;
      },
    },
    async findFeeSchedule(originalId) {
      const row = inserted.find((item) => item.id === originalId);
      return row ? { id: row.id } : null;
    },
    async insertFeeSchedule(row) {
      inserted.push({ id: row.id, custodianId: row.custodianId, content: row.content });
    },
  };
  return { deps, saved, confirmed, inserted, state, catalog, runs };
}

function stored(runs: Map<string, { id: string; items: StoredImportItem[] }>, kind: StoredImportItem["kind"], originalId: string): StoredImportItem {
  const run = [...runs.values()][0];
  const item = run?.items.find((candidate) => candidate.kind === kind && candidate.originalId === originalId);
  if (!item) throw new Error(`missing ${kind} ${originalId}`);
  return item;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("importCustodianSnapshot", () => {
  it("refuses unless the import switch is exactly 1", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const { deps, saved } = harness();
    for (const value of [undefined, "", "0", "true", " 1", "1 "]) {
      if (value === undefined) delete process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403;
      else process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = value;
      process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397 = "1";
      const result = await importCustodianSnapshot(snapshot(), files(), deps);
      expect(result).toEqual({ refused: "flag_off", snapshotSha256: null, runId: null });
    }
    expect(saved).toHaveLength(0);
    expect(errors.some((line) => line.includes("\"feature\":\"custodian-snapshot-import\"") && line.includes("\"reason\":\"flag_off\""))).toBe(true);
    markCase("custodian-snapshot-import", "refuses unless the import switch is exactly 1");
  });

  it("stores checksum evidence after save and confirm", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      errors.push(String(line));
    });
    const body = snapshot();
    (body.custodians[0].fees[0] as CustodianSnapshot["custodians"][0]["fees"][0] & { custodianId?: string }).custodianId = "cus_synthetic_1";
    const { deps, saved, confirmed, inserted, runs } = harness();
    const result = await importCustodianSnapshot(body, files(), deps);
    expect(profileDigest(body.custodians[0])).toEqual({
      byteCount: 452,
      checksum: "25354b803d3e8fc6340eb56b696b955127cacb7d5614cd950c9feec648140144",
    });
    expect(feeDigest(body.custodians[0].fees[0])).toEqual({
      byteCount: 247,
      checksum: "68681287a4ab0f85eeef0cb395bdd7397bc41416163472ecfc3707b1c89b3ff0",
    });
    expect(sha256Hex(PDF)).toBe(FILE_SHA);
    expect(saved).toHaveLength(1);
    const call = saved[0] as { identity: typeof IMPORT_IDENTITY; input: { profile: object; fees: object[] } };
    expect(call.identity).toEqual(IMPORT_IDENTITY);
    expect(call.input.profile).toMatchObject({ id: "cus_synthetic_1" });
    expect(call.input.fees[0]).toMatchObject({ id: "fee_synthetic_1" });
    expect(call.input.fees[0]).not.toHaveProperty("custodian_id");
    expect(confirmed).toEqual([1]);
    expect(inserted).toEqual([{ id: "file_synthetic_1", custodianId: "auth_1", content: PDF }]);
    expect(Object.keys(result).sort()).toEqual(["refused", "runId", "snapshotSha256"]);
    expect(result).toMatchObject({ refused: null, runId: "run_1" });
    expect(stored(runs, "custodian", "cus_synthetic_1")).toMatchObject({
      authorityId: "auth_1", byteCount: 452, checksum: "25354b803d3e8fc6340eb56b696b955127cacb7d5614cd950c9feec648140144", revision: 1, confirmed: true,
    });
    expect(stored(runs, "fee_rule", "fee_synthetic_1")).toMatchObject({
      authorityId: "fee_auth_1", byteCount: 247, checksum: "68681287a4ab0f85eeef0cb395bdd7397bc41416163472ecfc3707b1c89b3ff0", revision: 1, confirmed: true,
    });
    expect(stored(runs, "fee_schedule_file", "file_synthetic_1")).toMatchObject({
      authorityId: "file_synthetic_1", byteCount: 14, checksum: FILE_SHA, revision: null, confirmed: true,
    });
    expect(errors.some((line) => line.includes("\"feature\":\"custodian-snapshot-import\"") && line.includes("\"outcome\":\"ok\""))).toBe(true);
    markCase("custodian-snapshot-import", "stores checksum evidence after save and confirm");
  });

  it("replay keeps the same run and does not save or store bytes again", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const { deps, saved, inserted, runs } = harness();
    const first = await importCustodianSnapshot(snapshot(), files(), deps);
    const feeBefore = stored(runs, "fee_rule", "fee_synthetic_1").checksum;
    const second = await importCustodianSnapshot(snapshot(), files(), deps);
    expect(second).toEqual(first);
    expect(saved).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(stored(runs, "fee_rule", "fee_synthetic_1").checksum).toBe(feeBefore);
    markCase("custodian-snapshot-import", "replay keeps the same run and does not save or store bytes again");
  });

  it("resumes an unconfirmed custodian by confirming only", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const { deps, saved, confirmed, inserted, runs } = harness();
    const first = await importCustodianSnapshot(snapshot(), files(), deps);
    expect(first.refused).toBeNull();
    const run = await deps.evidence.findRun(first.snapshotSha256!);
    const custodian = run!.items.find((item) => item.kind === "custodian")!;
    await deps.evidence.upsertItem(run!.id, { ...custodian, confirmed: false });
    await importCustodianSnapshot(snapshot(), files(), deps);
    expect(saved).toHaveLength(1);
    expect(confirmed).toEqual([1, 1]);
    expect(inserted).toHaveLength(1);
    expect(stored(runs, "custodian", "cus_synthetic_1").confirmed).toBe(true);
    markCase("custodian-snapshot-import", "resumes an unconfirmed custodian by confirming only");
  });

  it("a mismatched pending revision returns save_failed", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const { deps, saved, confirmed, state, catalog, runs } = harness({ acceptedRevision: 1n, confirmedRevision: 0n });
    catalog.rows = [{ revision: 1, body: { id: "auth_1", name: "Other Custodian", fee_rules: EVENT.fee_rules } }];
    const mismatched = await importCustodianSnapshot(snapshot(), files(), deps);
    expect(mismatched.refused).toBe("save_failed");
    expect(mismatched.runId).toBeNull();
    expect(confirmed).toEqual([]);
    expect(state.confirmedRevision).toBe(0n);
    catalog.rows = [{ revision: 1, body: EVENT }];
    const result = await importCustodianSnapshot(snapshot(), files(), deps);
    expect(saved).toHaveLength(0);
    expect(confirmed).toEqual([1]);
    expect(result).toMatchObject({ refused: null, runId: "run_1" });
    expect(stored(runs, "custodian", "cus_synthetic_1").authorityId).toBe("auth_1");
    markCase("custodian-snapshot-import", "a mismatched pending revision returns save_failed");
  });

  it("refuses bytes that do not match the declared checksum", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const { deps, saved, inserted } = harness();
    const result = await importCustodianSnapshot(snapshot(), { file_synthetic_1: Buffer.from("%PDF-other") }, deps);
    expect(result).toEqual({ refused: "checksum_mismatch", snapshotSha256: null, runId: null });
    expect(saved).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    markCase("custodian-snapshot-import", "refuses bytes that do not match the declared checksum");
  });

  it("refuses a duplicate original id", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const body = snapshot();
    body.custodians.push({ ...body.custodians[0] });
    const { deps, saved } = harness();
    const result = await importCustodianSnapshot(body, files(), deps);
    expect(result.refused).toBe("duplicate_id");
    expect(saved).toHaveLength(0);
    markCase("custodian-snapshot-import", "refuses a duplicate original id");
  });

  it("maps equal fee rules onto distinct generated ids", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const body = snapshot();
    const base = body.custodians[0].fees[0];
    body.custodians[0].feeScheduleDocuments = [];
    body.custodians[0].fees = [
      { ...base, id: "fee_noted", notes: "call first", amountText: "$25", documentation: "schedule" },
      { ...base, id: "fee_low", notes: null, amountText: null, documentation: null },
      { ...base, id: "fee_high", notes: null, amountText: null, documentation: null },
    ];
    const { deps, catalog, runs } = harness();
    const match = { fee_type: "ACAT Out", account_type: "ANY", transfer_type: "FULL", direction: "OUT", amount: 25 };
    catalog.rows = [{
      revision: 1,
      body: {
        id: "auth_1",
        name: "Synthetic Custodian",
        fee_rules: [
          { id: "z_plain", ...match, notes: null, amount_text: null, documentation: null },
          { id: "0_decoy", ...match, notes: "call first", amount_text: null, documentation: null },
          { id: "a_plain", ...match, notes: null, amount_text: null, documentation: null },
          { id: "m_noted", ...match, notes: "call first", amount_text: "$25", documentation: "schedule" },
        ],
      },
    }];
    const result = await importCustodianSnapshot(body, {}, deps);
    expect(result.refused).toBeNull();
    const seeded = catalog.rows[0]?.body as { fee_rules: Array<{ id: string }> };
    expect(seeded.fee_rules.map((rule) => rule.id).sort()).toEqual(["0_decoy", "a_plain", "m_noted", "z_plain"]);
    expect(stored(runs, "fee_rule", "fee_noted").authorityId).toBe("m_noted");
    expect(stored(runs, "fee_rule", "fee_low").authorityId).toBe("a_plain");
    expect(stored(runs, "fee_rule", "fee_high").authorityId).toBe("z_plain");
    markCase("custodian-snapshot-import", "maps equal fee rules onto distinct generated ids");
  });

  it("converts a safe bigint revision and rejects an unsafe one", async () => {
    expect(readEvidenceRevision(1n)).toBe(1);
    expect(safeRevision(1n)).toBe(1);
    expect(() => readEvidenceRevision(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("revision_not_safe");
    expect(() => safeRevision(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("revision_not_safe");
    markCase("custodian-snapshot-import", "converts a safe bigint revision and rejects an unsafe one");
  });

  it("records a missing fee without a second save", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const { deps, saved, confirmed, inserted, runs } = harness();
    const first = await importCustodianSnapshot(snapshot(), files(), deps);
    expect(first.refused).toBeNull();
    const run = await deps.evidence.findRun(first.snapshotSha256!);
    const feeIndex = run!.items.findIndex((item) => item.kind === "fee_rule");
    const fileBefore = stored(runs, "fee_schedule_file", "file_synthetic_1").checksum;
    run!.items.splice(feeIndex, 1);
    await importCustodianSnapshot(snapshot(), files(), deps);
    expect(saved).toHaveLength(1);
    expect(confirmed).toEqual([1]);
    expect(inserted).toHaveLength(1);
    expect(stored(runs, "fee_rule", "fee_synthetic_1").authorityId).toBe("fee_auth_1");
    expect(stored(runs, "custodian", "cus_synthetic_1").authorityId).toBe("auth_1");
    expect(stored(runs, "fee_schedule_file", "file_synthetic_1").checksum).toBe(fileBefore);
    markCase("custodian-snapshot-import", "records a missing fee without a second save");
  });

  it("a second custodian resumes without rewriting the first", async () => {
    process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 = "1";
    const base = harness();
    base.catalog.rows = [];
    let calls = 0;
    let block = true;
    base.deps.saveCustodianAuthority = async (_identity, input) => {
      calls += 1;
      if (block && calls === 2) return { ok: false, reason: "save_failed" };
      base.saved.push(input.profile.name);
      base.state.acceptedRevision += 1n;
      const revision = Number(base.state.acceptedRevision);
      const custodianId = input.profile.name === "Zulu Custodian" ? "auth_z" : "auth_a";
      const feeId = input.profile.name === "Zulu Custodian" ? "fee_z" : "fee_a";
      base.catalog.rows.push({
        revision,
        body: {
          id: custodianId,
          name: input.profile.name,
          fee_rules: [{ id: feeId, fee_type: "ACAT Out", account_type: "ANY", transfer_type: "FULL", direction: "OUT", amount: 25, notes: null, amount_text: null, documentation: null }],
        },
      });
      return { ok: true, value: { custodianId, revision: base.state.acceptedRevision } };
    };
    const one = snapshot().custodians[0];
    const body: CustodianSnapshot = {
      schemaVersion: 1,
      custodians: [
        { ...one, id: "cus_z", name: "Zulu Custodian", fees: [{ ...one.fees[0], id: "fee_z" }], feeScheduleDocuments: [{ ...one.feeScheduleDocuments[0], id: "file_z" }] },
        { ...one, id: "cus_a", name: "Alpha Custodian", fees: [{ ...one.fees[0], id: "fee_a" }], feeScheduleDocuments: [{ ...one.feeScheduleDocuments[0], id: "file_a" }] },
      ],
    };
    const bytes = { file_z: PDF, file_a: PDF };
    const stopped = await importCustodianSnapshot(body, bytes, base.deps);
    expect(stopped.refused).toBe("save_failed");
    expect(stored(base.runs, "custodian", "cus_z").authorityId).toBe("auth_z");
    expect(base.inserted.map((row) => row.id)).toEqual(["file_z"]);
    block = false;
    const resumed = await importCustodianSnapshot(body, bytes, base.deps);
    expect(resumed.refused).toBeNull();
    expect(base.saved).toEqual(["Zulu Custodian", "Alpha Custodian"]);
    expect(base.inserted.map((row) => row.id)).toEqual(["file_z", "file_a"]);
    expect(stored(base.runs, "custodian", "cus_z").authorityId).toBe("auth_z");
    expect(stored(base.runs, "custodian", "cus_a").authorityId).toBe("auth_a");
    expect(stored(base.runs, "fee_rule", "fee_z").authorityId).toBe("fee_z");
    expect(stored(base.runs, "fee_rule", "fee_a").authorityId).toBe("fee_a");
    markCase("custodian-snapshot-import", "a second custodian resumes without rewriting the first");
  });

  it("evidence SQL creates both audit triggers", () => {
    const sql = readFileSync("prisma/migrations/20261102140000_custodian_snapshot_import/migration.sql", "utf8");
    expect(sql).toContain("CREATE TRIGGER custodian_snapshot_import_audit");
    expect(sql).toContain("CREATE TRIGGER custodian_snapshot_import_item_audit");
    expect(sql).toContain("EXECUTE FUNCTION audit.log_row_change()");
    expect(sql).toContain("kind IN ('custodian', 'fee_rule', 'fee_schedule_file')");
    expect(sql.includes("content bytea")).toBe(false);
    markCase("custodian-snapshot-import", "evidence SQL creates both audit triggers");
  });
});
