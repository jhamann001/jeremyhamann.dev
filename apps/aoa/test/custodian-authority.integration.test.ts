import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import {
  confirmCustodianAuthorityRevision,
  listCustodianAuthorityRevisions,
  mergeCustodianAuthority,
  readCustodianAuthorityProfiles,
  saveCustodianAuthority,
} from "@/lib/data/custodian-authority";
import { withUserScope } from "@/lib/rls";
import { markCase } from "./acat-book-flywheel";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADMIN = { role: "ADMIN", email: "tkt399-admin@example.test" };
const OPS = { role: "OPERATIONS", email: "tkt399-ops@example.test" };
const PREFIX = "tkt399-";
const FAIL_PREFIX = "tkt399-fail-";
const SWITCHES = ["ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399", "EPIC_ACAT_CUSTODIAN_ADMIN_TKT323", "SHOW_ACAT_CUSTODIAN_ADMIN_TKT337"];

function ownerClient(): PrismaClient {
  return new PrismaClient({
    datasourceUrl: process.env.AUDIT_TEST_CLEANUP_URL
      ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`,
  });
}

gated("custodian authority storage (AUDIT_TEST_DB_URL)", () => {
  let owner: PrismaClient;

  async function cleanup(): Promise<void> {
    await owner.$executeRawUnsafe(`DELETE FROM app.custodian_authority_event
      WHERE custodian_id IN (SELECT id FROM app.custodian_profile WHERE name LIKE 'TKT399 %')`);
    await owner.$executeRawUnsafe(`DELETE FROM app.custodian_fee_rule
      WHERE custodian_id IN (SELECT id FROM app.custodian_profile WHERE name LIKE 'TKT399 %')`);
    await owner.$executeRawUnsafe(`UPDATE app.custodian_profile SET merged_into_id = NULL WHERE name LIKE 'TKT399 %'`);
    await owner.$executeRawUnsafe(`DELETE FROM app.custodian_profile WHERE name LIKE 'TKT399 %'`);
    await owner.$executeRawUnsafe(`DELETE FROM audit."AuditLog" WHERE "actorEmail" LIKE 'tkt399-%'`);
    await owner.$executeRawUnsafe("DROP TRIGGER IF EXISTS zztest_tkt399_audit_failure ON audit.\"AuditLog\"");
    await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS audit.zztest_tkt399_audit_failure()");
  }

  async function seedCustodian(id: string, name: string): Promise<void> {
    await owner.$executeRaw`INSERT INTO app.custodian_profile (id, name, revision) VALUES (${id}, ${name}, 0)`;
    await owner.$executeRaw`INSERT INTO app.custodian_fee_rule (id, custodian_id, fee_type, amount, revision)
      VALUES (${`${id}-fee`}, ${id}, 'ACAT_OUT', 75, 0)`;
  }

  async function confirmTransferCopy(): Promise<void> {
    await owner.$executeRawUnsafe(
      "UPDATE app.custodian_authority_state SET confirmed_revision = accepted_revision WHERE id = 1",
    );
  }

  async function state(): Promise<{ accepted: bigint; confirmed: bigint; events: bigint }> {
    const [row] = await owner.$queryRaw<Array<{ accepted: bigint; confirmed: bigint; events: bigint }>>`
      SELECT s.accepted_revision AS accepted, s.confirmed_revision AS confirmed,
             (SELECT count(*) FROM app.custodian_authority_event) AS events
        FROM app.custodian_authority_state s WHERE s.id = 1`;
    return row;
  }

  async function failAuditFor(action: string): Promise<void> {
    await owner.$executeRawUnsafe(`CREATE FUNCTION audit.zztest_tkt399_audit_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action = '${action}' AND NEW."entityId" LIKE '${FAIL_PREFIX}%' THEN
          RAISE EXCEPTION 'synthetic custodian authority audit failure';
        END IF;
        RETURN NEW;
      END $$`);
    await owner.$executeRawUnsafe(
      'CREATE TRIGGER zztest_tkt399_audit_failure BEFORE INSERT ON audit."AuditLog" FOR EACH ROW EXECUTE FUNCTION audit.zztest_tkt399_audit_failure()',
    );
  }

  beforeAll(async () => {
    for (const key of SWITCHES) process.env[key] = "1";
    owner = ownerClient();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    await confirmTransferCopy();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await cleanup();
    await confirmTransferCopy();
    await owner.$disconnect();
    for (const key of SWITCHES) delete process.env[key];
  });

  it("saves a new custodian, its fee rules, one event, one audit row and the accepted revision together", async () => {
    const before = await state();
    const result = await saveCustodianAuthority(ADMIN, {
      profile: { name: "TKT399 Created", transfer_type: "ACAT_API", contact_method: "EMAIL" },
      fees: [{ fee_type: "ACAT_OUT", amount: 50 }, { fee_type: "ACAT_IN", account_type: "IRA", amount_text: "Varies" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBe(before.accepted + BigInt(1));
    const after = await state();
    expect(after).toEqual({ accepted: result.value.revision, confirmed: before.confirmed, events: before.events + BigInt(1) });
    const fees = await owner.custodianFeeRule.count({ where: { custodian_id: result.value.custodianId, retired_at: null } });
    expect(fees).toBe(2);
    const event = await owner.custodianAuthorityEvent.findUniqueOrThrow({ where: { revision: result.value.revision } });
    expect(event.kind).toBe("CUSTODIAN_SAVE");
    expect((event.payload as { name: string; fee_rules: unknown[] }).name).toBe("TKT399 Created");
    expect((event.payload as { fee_rules: unknown[] }).fee_rules).toHaveLength(2);
    const audits = await owner.auditLog.count({ where: { action: "custodian_authority.save", entityId: result.value.custodianId } });
    expect(audits).toBe(1);
    markCase("custodian-authority-integration", "saves a new custodian, its fee rules, one event, one audit row and the accepted revision together", "integration");
  });

  it("creates a custodian and fee rule with the supplied tracker ids", async () => {
    const id = `${PREFIX}tracker-id`;
    const feeId = `${id}-fee`;
    const result = await saveCustodianAuthority(ADMIN, {
      profile: { id, name: "TKT399 Tracker Id", transfer_type: "MANUAL" },
      fees: [{ id: feeId, fee_type: "ACAT_OUT", amount: 40 }],
    });
    expect(result).toMatchObject({ ok: true, value: { custodianId: id } });
    if (!result.ok) return;
    const profile = await owner.custodianProfile.findUniqueOrThrow({ where: { id } });
    expect(profile.name).toBe("TKT399 Tracker Id");
    const fees = await owner.custodianFeeRule.findMany({ where: { custodian_id: id, retired_at: null } });
    expect(fees.map((fee) => fee.id)).toEqual([feeId]);
    const event = await owner.custodianAuthorityEvent.findUniqueOrThrow({ where: { revision: result.value.revision } });
    const payload = event.payload as { id: string; fee_rules: Array<{ id: string }> };
    expect(payload.id).toBe(id);
    expect(payload.fee_rules.map((fee) => fee.id)).toEqual([feeId]);
    markCase("custodian-authority-integration", "creates a custodian and fee rule with the supplied tracker ids", "integration");
  });

  it("refuses an unknown fee id on an existing custodian and a fee id owned elsewhere", async () => {
    const id = `${PREFIX}fee-miss`;
    await seedCustodian(id, "TKT399 Fee Miss");
    const before = await state();
    const missing = await saveCustodianAuthority(ADMIN, {
      profile: { id, name: "TKT399 Fee Miss" },
      fees: [{ id: `${id}-other`, fee_type: "ACAT_OUT", amount: 10 }],
    });
    expect(missing).toEqual({ ok: false, reason: "not_found" });
    expect(await state()).toEqual(before);

    const borrowed = await saveCustodianAuthority(ADMIN, {
      profile: { id: `${PREFIX}fee-borrow`, name: "TKT399 Fee Borrow" },
      fees: [{ id: `${id}-fee`, fee_type: "ACAT_OUT", amount: 10 }],
    });
    expect(borrowed).toEqual({ ok: false, reason: "not_found" });
    expect(await owner.custodianProfile.findUnique({ where: { id: `${PREFIX}fee-borrow` } })).toBeNull();
    expect(await state()).toEqual(before);
    markCase("custodian-authority-integration", "refuses an unknown fee id on an existing custodian and a fee id owned elsewhere", "integration");
  });

  it("WO-AC-1: a save whose audit write fails leaves the prior custodian, fees and revision unchanged", async () => {
    const id = `${FAIL_PREFIX}save`;
    await seedCustodian(id, "TKT399 Save Failure");
    await failAuditFor("custodian_authority.save");
    const before = await state();
    const result = await saveCustodianAuthority(ADMIN, {
      profile: { id, name: "TKT399 Save Failure Renamed" },
      fees: [{ fee_type: "ACAT_IN", amount: 10 }],
    });
    expect(result).toEqual({ ok: false, reason: "save_failed" });
    const profile = await owner.custodianProfile.findUniqueOrThrow({ where: { id } });
    expect(profile.name).toBe("TKT399 Save Failure");
    expect(profile.revision).toBe(BigInt(0));
    const fees = await owner.custodianFeeRule.findMany({ where: { custodian_id: id } });
    expect(fees.map((fee) => [fee.id, fee.retired_at])).toEqual([[`${id}-fee`, null]]);
    expect(await state()).toEqual(before);
    markCase("custodian-authority-integration", "WO-AC-1: a save whose audit write fails leaves the prior custodian, fees and revision unchanged", "integration");
  });

  it("WO-AC-1: a save rejected by a database constraint leaves the prior custodian unchanged", async () => {
    const id = `${PREFIX}constraint`;
    await seedCustodian(id, "TKT399 Constraint");
    const before = await state();
    const result = await saveCustodianAuthority(ADMIN, {
      profile: { id, name: "TKT399 Constraint Renamed" },
      fees: [{ fee_type: "ACAT_OUT", account_type: "NOT_A_TYPE" }],
    });
    expect(result).toEqual({ ok: false, reason: "save_failed" });
    expect((await owner.custodianProfile.findUniqueOrThrow({ where: { id } })).name).toBe("TKT399 Constraint");
    expect(await owner.custodianFeeRule.count({ where: { custodian_id: id } })).toBe(1);
    expect(await state()).toEqual(before);
    markCase("custodian-authority-integration", "WO-AC-1: a save rejected by a database constraint leaves the prior custodian unchanged", "integration");
  });

  it("WO-AC-2: refuses further edits until the transfer copy confirms the accepted revision", async () => {
    const id = `${PREFIX}behind`;
    await seedCustodian(id, "TKT399 Behind");
    const first = await saveCustodianAuthority(ADMIN, { profile: { id, name: "TKT399 Behind One" }, fees: [{ id: `${id}-fee`, fee_type: "ACAT_OUT", amount: 80 }] });
    expect(first.ok).toBe(true);
    const behind = await state();
    expect(behind.accepted).toBe(behind.confirmed + BigInt(1));

    const refused = await saveCustodianAuthority(ADMIN, { profile: { id, name: "TKT399 Behind Two" }, fees: [] });
    expect(refused).toEqual({ ok: false, reason: "transfer_copy_behind" });
    const merge = await mergeCustodianAuthority(ADMIN, { sourceId: id, targetId: `${PREFIX}missing` });
    expect(merge).toEqual({ ok: false, reason: "transfer_copy_behind" });
    expect((await owner.custodianProfile.findUniqueOrThrow({ where: { id } })).name).toBe("TKT399 Behind One");
    expect(await state()).toEqual(behind);

    await confirmTransferCopy();
    const accepted = await saveCustodianAuthority(ADMIN, { profile: { id, name: "TKT399 Behind Two" }, fees: [] });
    expect(accepted.ok).toBe(true);
    expect(await owner.custodianFeeRule.count({ where: { custodian_id: id, retired_at: null } })).toBe(0);
    markCase("custodian-authority-integration", "WO-AC-2: refuses further edits until the transfer copy confirms the accepted revision", "integration");
  });

  it("merges a custodian into the survivor as one MERGE event and one audit row", async () => {
    await seedCustodian(`${PREFIX}source`, "TKT399 Source");
    await seedCustodian(`${PREFIX}target`, "TKT399 Target");
    const result = await mergeCustodianAuthority(ADMIN, { sourceId: `${PREFIX}source`, targetId: `${PREFIX}target` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = await owner.custodianProfile.findUniqueOrThrow({ where: { id: `${PREFIX}source` } });
    expect(source.merged_into_id).toBe(`${PREFIX}target`);
    expect(source.retired_at).not.toBeNull();
    const event = await owner.custodianAuthorityEvent.findUniqueOrThrow({ where: { revision: result.value.revision } });
    expect([event.kind, event.custodian_id, event.merged_from_id]).toEqual(["CUSTODIAN_MERGE", `${PREFIX}target`, `${PREFIX}source`]);
    expect(await owner.auditLog.count({ where: { action: "custodian_authority.merge", entityId: `${PREFIX}target` } })).toBe(1);
    markCase("custodian-authority-integration", "merges a custodian into the survivor as one MERGE event and one audit row", "integration");
  });

  it("WO-AC-3: a merge whose audit write fails leaves both custodians and the change log unchanged", async () => {
    const source = `${FAIL_PREFIX}msource`;
    const target = `${FAIL_PREFIX}mtarget`;
    await seedCustodian(source, "TKT399 Merge Source");
    await seedCustodian(target, "TKT399 Merge Target");
    await failAuditFor("custodian_authority.merge");
    const before = await state();
    const result = await mergeCustodianAuthority(ADMIN, { sourceId: source, targetId: target });
    expect(result).toEqual({ ok: false, reason: "merge_failed" });
    const rows = await owner.custodianProfile.findMany({ where: { id: { in: [source, target] } }, orderBy: { id: "asc" } });
    expect(rows.map((row) => [row.id, row.retired_at, row.merged_into_id, row.revision])).toEqual([
      [source, null, null, BigInt(0)],
      [target, null, null, BigInt(0)],
    ]);
    expect(await owner.custodianFeeRule.count({ where: { custodian_id: { in: [source, target] }, retired_at: null } })).toBe(2);
    expect(await state()).toEqual(before);
    markCase("custodian-authority-integration", "WO-AC-3: a merge whose audit write fails leaves both custodians and the change log unchanged", "integration");
  });

  it("refuses a merge into a retired or missing custodian without writing", async () => {
    await seedCustodian(`${PREFIX}orphan`, "TKT399 Orphan");
    const before = await state();
    const result = await mergeCustodianAuthority(ADMIN, { sourceId: `${PREFIX}orphan`, targetId: `${PREFIX}absent` });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(await state()).toEqual(before);
    markCase("custodian-authority-integration", "refuses a merge into a retired or missing custodian without writing", "integration");
  });

  it("lists the saved event body and confirms that same revision twice", async () => {
    const saved = await saveCustodianAuthority(ADMIN, {
      profile: { name: "TKT399 Listed", contact_method: "PHONE" },
      fees: [{ fee_type: "ACAT_OUT", amount: 25 }],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const revision = Number(saved.value.revision);
    const listed = await listCustodianAuthorityRevisions();
    const row = listed.find((item) => item.revision === revision);
    expect(row?.body).toMatchObject({ name: "TKT399 Listed" });
    expect((row?.body as { fee_rules: unknown[] }).fee_rules).toHaveLength(1);

    await expect(confirmCustodianAuthorityRevision(revision)).resolves.toBeUndefined();
    const once = await state();
    expect(once.confirmed).toBe(saved.value.revision);
    await expect(confirmCustodianAuthorityRevision(revision)).resolves.toBeUndefined();
    const twice = await state();
    expect(twice.confirmed).toBe(once.confirmed);
    expect(twice.accepted).toBe(once.accepted);
    expect(twice.events).toBe(once.events);

    await expect(confirmCustodianAuthorityRevision(revision + 1)).rejects.toThrow("revision_not_accepted");
    expect(await state()).toEqual(twice);

    const next = await saveCustodianAuthority(ADMIN, {
      profile: { id: saved.value.custodianId, name: "TKT399 Listed Again" },
      fees: [],
    });
    expect(next.ok).toBe(true);
    markCase("custodian-authority-integration", "lists the saved event body and confirms that same revision twice", "integration");
  });

  it("refuses a confirmation that skips an unconfirmed revision or passes the accepted revision", async () => {
    const id = `${PREFIX}gap`;
    await seedCustodian(id, "TKT399 Confirm Gap");
    await owner.$executeRaw`INSERT INTO app.custodian_authority_event
      (revision, kind, custodian_id, payload, actor_email)
      VALUES (1, 'CUSTODIAN_SAVE', ${id}, '{"marker":1}'::jsonb, 'tkt399-seed@example.test'),
             (2, 'CUSTODIAN_SAVE', ${id}, '{"marker":2}'::jsonb, 'tkt399-seed@example.test')`;
    await owner.$executeRaw`UPDATE app.custodian_authority_state
      SET accepted_revision = 2, confirmed_revision = 0 WHERE id = 1`;

    await expect(confirmCustodianAuthorityRevision(2)).rejects.toThrow("revision_not_accepted");
    await expect(confirmCustodianAuthorityRevision(3)).rejects.toThrow("revision_not_accepted");
    expect(await state()).toMatchObject({ accepted: BigInt(2), confirmed: BigInt(0) });

    await expect(confirmCustodianAuthorityRevision(1)).resolves.toBeUndefined();
    await expect(confirmCustodianAuthorityRevision(1)).resolves.toBeUndefined();
    expect((await state()).confirmed).toBe(BigInt(1));
    await expect(confirmCustodianAuthorityRevision(2)).resolves.toBeUndefined();
    expect((await state()).confirmed).toBe(BigInt(2));
    markCase("custodian-authority-integration", "refuses a confirmation that skips an unconfirmed revision or passes the accepted revision", "integration");
  });

  it("reads active profiles for ADMIN and OPERATIONS and omits a retired merge source", async () => {
    const created = await saveCustodianAuthority(ADMIN, {
      profile: { name: "TKT399 Readable", contact_method: "EMAIL" },
      fees: [
        { fee_type: "ACAT_OUT", amount: 10 },
        { fee_type: "ACAT_IN", amount: 20 },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await confirmCustodianAuthorityRevision(Number(created.value.revision));
    const kept = await owner.custodianFeeRule.findFirstOrThrow({
      where: { custodian_id: created.value.custodianId, fee_type: "ACAT_OUT" },
    });
    const trimmed = await saveCustodianAuthority(ADMIN, {
      profile: { id: created.value.custodianId, name: "TKT399 Readable" },
      fees: [{ id: kept.id, fee_type: "ACAT_OUT", amount: 10 }],
    });
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    await confirmCustodianAuthorityRevision(Number(trimmed.value.revision));

    const beforeMerge = await readCustodianAuthorityProfiles("ADMIN");
    expect(beforeMerge.ok).toBe(true);
    if (!beforeMerge.ok) return;
    const active = beforeMerge.value.find((profile) => profile.id === created.value.custodianId);
    expect(active?.fees.map((fee) => fee.feeType)).toEqual(["ACAT_OUT"]);
    expect(active).toMatchObject({ contactMethod: "EMAIL", name: "TKT399 Readable" });

    const target = await saveCustodianAuthority(ADMIN, {
      profile: { name: "TKT399 Readable Target" },
      fees: [],
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    await confirmCustodianAuthorityRevision(Number(target.value.revision));
    const merged = await mergeCustodianAuthority(ADMIN, {
      sourceId: created.value.custodianId,
      targetId: target.value.custodianId,
    });
    expect(merged.ok).toBe(true);

    const admin = await readCustodianAuthorityProfiles("ADMIN");
    expect(admin.ok).toBe(true);
    if (!admin.ok) return;
    expect(admin.value.some((profile) => profile.id === created.value.custodianId)).toBe(false);
    expect(admin.value.some((profile) => profile.id === target.value.custodianId)).toBe(true);
    const ops = await readCustodianAuthorityProfiles("OPERATIONS");
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;
    expect(ops.value.some((profile) => profile.id === target.value.custodianId)).toBe(true);
    await expect(readCustodianAuthorityProfiles("VIEWER"))
      .resolves.toEqual({ ok: false, reason: "not_permitted" });
    markCase("custodian-authority-integration", "reads active profiles for ADMIN and OPERATIONS and omits a retired merge source", "integration");
  });

  it("lets OPERATIONS read but not write, and gives app_rw no DELETE", async () => {
    await seedCustodian(`${PREFIX}rls`, "TKT399 RLS");
    const visible = await withUserScope(OPS, (tx) => tx.custodianProfile.count({ where: { id: `${PREFIX}rls` } }));
    expect(visible).toBe(1);
    await expect(withUserScope(OPS, (tx) => tx.custodianProfile.update({ where: { id: `${PREFIX}rls` }, data: { name: "TKT399 RLS Ops" } })))
      .rejects.toThrow();
    await expect(withUserScope(ADMIN, (tx) => tx.$executeRawUnsafe(`DELETE FROM app.custodian_profile WHERE id = '${PREFIX}rls'`)))
      .rejects.toThrow(/permission denied/i);
    expect((await owner.custodianProfile.findUniqueOrThrow({ where: { id: `${PREFIX}rls` } })).name).toBe("TKT399 RLS");
    markCase("custodian-authority-integration", "lets OPERATIONS read but not write, and gives app_rw no DELETE", "integration");
  });
});
