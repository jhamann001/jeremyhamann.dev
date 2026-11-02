import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import {
  flagCrmContactDuplicateCandidate,
  flagCrmDuplicateCandidate,
  getCrmDuplicateCandidateDetail,
  listCrmDuplicateCandidates,
  resolveCrmDuplicateCanonicalIdentity,
  updateCrmDuplicateReview,
} from "@/lib/data/crm-duplicate-review";
import { listClients } from "@/lib/data/clients";
import { getHousehold, listHouseholds } from "@/lib/data/households";
import {
  crmCanonicalHouseholdSourceKeys,
  resolveCrmRouteKey,
} from "@/lib/crm/resolve";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "crm-duplicate-ops@example.test" };
// CRM joins intentionally use Salesforce's case-insensitive 15-character
// key. Keep the fixture IDs distinct inside those first 15 characters so the
// test models two real source households instead of aliasing both fixtures.
const HH1 = "001CRMDEMO00001";
const HH2 = "001CRMDEMO00002";
const HLD1 = "hld_cdup00000000000000000001";
const HLD2 = "hld_cdup00000000000000000002";
const CID1 = "con_cdup00000000000000000001";
const CID2 = "con_cdup00000000000000000002";
const CONTACT1 = "003CRMDEMO00001AAA";
const CONTACT2 = "003CRMDEMO00002AAA";
const CONTACT_CONFLICT = "003CRMDEMO00003AAA";
const MAP1 = "crm-dup-map-household-1";
const MAP2 = "crm-dup-map-household-2";
const CMAP1 = "crm-dup-map-contact-1";
const CMAP2 = "crm-dup-map-contact-2";
const SHARED_ACCOUNT = "CRM-DUP-ACCOUNT-SAME";
const COMPANION_ACCOUNT = "CRM-DUP-ACCOUNT-COMPANION";
const MAIN_ACCOUNT = "CRM-DUP-ACCOUNT-MAIN";

function ownerClient(): PrismaClient {
  return new PrismaClient({
    datasourceUrl: process.env.AUDIT_TEST_CLEANUP_URL
      ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`,
  });
}

async function cleanup(db: PrismaClient): Promise<void> {
  const candidates = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM app.crm_duplicate_candidate
     WHERE left_identity_id IN (${HLD1}, ${HLD2}, ${CID1}, ${CID2})
        OR right_identity_id IN (${HLD1}, ${HLD2}, ${CID1}, ${CID2})`;
  const ids = candidates.map((row) => row.id);
  if (ids.length > 0) {
    await db.$executeRaw(Prisma.sql`
      DELETE FROM app.crm_duplicate_candidate_event
       WHERE candidate_id IN (${Prisma.join(ids)})`);
    await db.$executeRaw(Prisma.sql`
      DELETE FROM app.crm_duplicate_candidate
       WHERE id IN (${Prisma.join(ids)})`);
    await db.$executeRaw(Prisma.sql`
      DELETE FROM audit.row_change
       WHERE table_name = 'crm_duplicate_candidate'
         AND row_pk IN (${Prisma.join(ids)})`);
  }
  await db.$executeRaw`
    DELETE FROM audit."AuditLog"
     WHERE "entityType" = 'crm_duplicate_candidate'
       AND "actorEmail" = ${OPS.email}`;
  await db.$executeRaw`
    DELETE FROM mirror.account_holder
     WHERE custodian_account_id IN (${SHARED_ACCOUNT}, ${COMPANION_ACCOUNT}, ${MAIN_ACCOUNT})`;
  await db.$executeRaw`
    DELETE FROM mirror.account
     WHERE custodian_account_id IN (${SHARED_ACCOUNT}, ${COMPANION_ACCOUNT}, ${MAIN_ACCOUNT})`;
  await db.$executeRaw`
    DELETE FROM mirror.client
     WHERE sf_id IN (${CONTACT1}, ${CONTACT2}, ${CONTACT_CONFLICT})`;
  await db.$executeRaw`
    DELETE FROM mirror.household WHERE sf_id IN (${HH1}, ${HH2})`;
  await db.$executeRaw`
    DELETE FROM app.crm_source_mapping
     WHERE id IN (${MAP1}, ${MAP2}, ${CMAP1}, ${CMAP2})
        OR source_key IN (${HH1}, ${HH2}, ${CONTACT1}, ${CONTACT2}, ${CONTACT_CONFLICT})`;
  await db.$executeRaw`
    DELETE FROM app.crm_identity WHERE id IN (${HLD1}, ${HLD2}, ${CID1}, ${CID2})`;
}

async function seed(db: PrismaClient): Promise<void> {
  // Registry rows land first so a concurrent identity-reconciliation test
  // cannot observe mirror fixtures before their exact mappings exist.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO app.crm_identity
        (id, identity_type, lifecycle_state, first_seen_at, created_at, updated_at)
      VALUES
        (${HLD1}, 'HOUSEHOLD', 'ACTIVE', now(), now(), now()),
        (${HLD2}, 'HOUSEHOLD', 'ACTIVE', now(), now(), now()),
        (${CID1}, 'CONTACT', 'ACTIVE', now(), now(), now()),
        (${CID2}, 'CONTACT', 'ACTIVE', now(), now(), now())`;
    await tx.$executeRaw`
      INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key,
         mapping_state, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES
        (${MAP1}, ${HLD1}, 'CRM', 'household', ${HH1}, 'ACTIVE', now(), now(), now(), now()),
        (${MAP2}, ${HLD2}, 'CRM', 'household', ${HH2}, 'ACTIVE', now(), now(), now(), now()),
        (${CMAP1}, ${CID1}, 'CRM', 'contact', ${CONTACT1}, 'ACTIVE', now(), now(), now(), now()),
        (${CMAP2}, ${CID2}, 'CRM', 'contact', ${CONTACT2}, 'ACTIVE', now(), now(), now(), now())`;
    await tx.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, status, lead_advisor_email, synced_at)
      VALUES
        (${HH1}, 'Synthetic Duplicate Left', 'Client', 'advisor@example.test', now()),
        (${HH2}, 'Synthetic Duplicate Right', 'Client', 'advisor@example.test', now())`;
    await tx.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, email, lead_advisor_email,
         cedar_ridge_user_id, synced_at)
      VALUES
        (${CONTACT1}, ${HH1}, 'Synthetic', 'Left', 'shared@example.test',
         'advisor@example.test', 'CRM-DUP-SHARED-USER', now()),
        (${CONTACT2}, ${HH2}, 'Synthetic', 'Right', 'shared@example.test',
         'advisor@example.test', 'CRM-DUP-SHARED-USER', now())`;
    await tx.$executeRaw`
      INSERT INTO mirror.account
        (custodian_account_id, custodian, account_type, status, synced_at)
      VALUES
        (${SHARED_ACCOUNT}, 'APEX', 'BROKERAGE', 'OPEN', now()),
        (${COMPANION_ACCOUNT}, 'APEX', 'BROKERAGE', 'OPEN', now()),
        (${MAIN_ACCOUNT}, 'APEX', 'BROKERAGE', 'OPEN', now())`;
    await tx.$executeRaw`
      INSERT INTO mirror.account_holder (custodian_account_id, cedar_ridge_user_id, synced_at)
      VALUES
        (${SHARED_ACCOUNT}, 'CRM-DUP-SHARED-USER', now()),
        (${COMPANION_ACCOUNT}, 'CRM-DUP-LEFT-ONLY', now()),
        (${MAIN_ACCOUNT}, 'CRM-DUP-RIGHT-ONLY', now())`;
  });
}

async function reconcile(db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE identity_reconciler`;
    await tx.$queryRaw`SELECT * FROM app.reconcile_crm_duplicate_candidates()`;
  });
}

async function reconcileContacts(db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE identity_reconciler`;
    await tx.$queryRaw`SELECT * FROM app.reconcile_crm_contact_duplicate_candidates()`;
  });
}

gated("CRM duplicate candidate review", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = ownerClient();
  });
  beforeEach(async () => {
    process.env.CRM_IDENTITY_READS = "1";
    await cleanup(owner);
    await seed(owner);
  });
  afterEach(() => {
    delete process.env.CRM_IDENTITY_READS;
  });
  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
  });

  it("uses a non-login, non-superuser, FORCE-RLS-bound function owner", async () => {
    const [functionOwner] = await owner.$queryRaw<Array<{
      owner_name: string;
    }>>`
      SELECT pg_get_userbyid(procedure.proowner) AS owner_name
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'app'
         AND procedure.proname = 'reconcile_crm_duplicate_candidates'`;
    expect(functionOwner?.owner_name).toMatch(/^[a-z_][a-z0-9_]*$/);
    const originalOwner = `"${functionOwner.owner_name}"`;
    const testOwner = "crm_duplicate_nonbypass_test_owner";

    await owner.$executeRawUnsafe(`
      CREATE ROLE ${testOwner}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS`);
    try {
      // Membership supplies the same object privileges and owner-targeted RLS
      // policies as production while SET FALSE prevents becoming the owner
      // role. SECURITY DEFINER therefore really runs as the non-bypass role.
      await owner.$executeRawUnsafe(
        `GRANT ${originalOwner} TO ${testOwner} WITH INHERIT TRUE, SET FALSE`,
      );
      await owner.$executeRawUnsafe(
        `ALTER FUNCTION app.reconcile_crm_duplicate_candidates() OWNER TO ${testOwner}`,
      );
      await owner.$executeRawUnsafe(
        `ALTER FUNCTION app.review_crm_duplicate_candidate(text, integer, text, timestamptz) OWNER TO ${testOwner}`,
      );
      await owner.$executeRawUnsafe(
        `ALTER FUNCTION app.review_crm_duplicate_candidate_v2(text, integer, text, timestamptz, text, text) OWNER TO ${testOwner}`,
      );

      const [role] = await owner.$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>>`
        SELECT rolsuper, rolbypassrls, rolcanlogin
          FROM pg_roles WHERE rolname = ${testOwner}`;
      expect(role).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: false,
      });

      // Exercise the weak household path while the function is owned by the
      // same kind of non-bypass role used in Cloud SQL. The original fixture's
      // shared Cedar Ridge ID only touches mirror.client, so it could not catch a
      // missing FORCE-RLS policy on mirror.household.
      await owner.$executeRaw`
        UPDATE mirror.household
           SET name = 'Synthetic Nonbypass Weak Match', stage = 'Client'
         WHERE sf_id IN (${HH1}, ${HH2})`;
      await owner.$executeRaw`
        UPDATE mirror.client
           SET cedar_ridge_user_id = CASE sf_id
                 WHEN ${CONTACT1} THEN 'CRM-DUP-NONBYPASS-LEFT'
                 ELSE 'CRM-DUP-NONBYPASS-RIGHT' END,
               email = CASE sf_id
                 WHEN ${CONTACT1} THEN 'nonbypass-left@example.test'
                 ELSE 'nonbypass-right@example.test' END
         WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CONTACT2}`;

      await reconcile(owner);
      const [counts] = await owner.$queryRaw<Array<{
        candidates: bigint;
        events: bigint;
        weak_households: bigint;
      }>>`
        SELECT
          (SELECT count(*)::bigint FROM app.crm_duplicate_candidate) AS candidates,
          (SELECT count(*)::bigint FROM app.crm_duplicate_candidate_event) AS events,
          (SELECT count(*)::bigint
             FROM app.crm_duplicate_candidate
            WHERE entity_type = 'HOUSEHOLD'
              AND evidence_codes @> ARRAY[
                'EXACT_NORMALIZED_HOUSEHOLD_NAME',
                'SAME_ADVISOR_AND_STAGE'
              ]::text[]) AS weak_households`;
      expect(counts).toEqual({ candidates: 1n, events: 1n, weak_households: 1n });
    } finally {
      await owner.$executeRawUnsafe(
        `ALTER FUNCTION app.reconcile_crm_duplicate_candidates() OWNER TO ${originalOwner}`,
      );
      await owner.$executeRawUnsafe(
        `ALTER FUNCTION app.review_crm_duplicate_candidate(text, integer, text, timestamptz) OWNER TO ${originalOwner}`,
      );
      await owner.$executeRawUnsafe(
        `ALTER FUNCTION app.review_crm_duplicate_candidate_v2(text, integer, text, timestamptz, text, text) OWNER TO ${originalOwner}`,
      );
      await owner.$executeRawUnsafe(`REVOKE ${originalOwner} FROM ${testOwner}`);
      await owner.$executeRawUnsafe(`DROP ROLE ${testOwner}`);
    }
  });

  it("opens only controlled household and exact-account candidates", async () => {
    await reconcile(owner);
    const result = await listCrmDuplicateCandidates(OPS, "potential");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.entityType).sort()).toEqual(["ACCOUNT", "HOUSEHOLD"]);
    expect(result.rows.find((row) => row.entityType === "HOUSEHOLD")?.evidenceCodes)
      .toContain("SHARED_CEDAR_RIDGE_USER_ID");
    expect(result.rows.find((row) => row.entityType === "ACCOUNT")?.evidenceCodes)
      .toEqual(["EXACT_CUSTODIAN_IDENTITY"]);

    const accountRows = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
        FROM app.crm_duplicate_candidate
       WHERE entity_type = 'ACCOUNT'`;
    // COMPANION_ACCOUNT and MAIN_ACCOUNT are distinct IDs and cannot produce a
    // candidate even though both are open Brokerage accounts.
    expect(Number(accountRows[0].n)).toBe(1);
  });

  it("keeps an Operations-submitted pair active across detector sweeps", async () => {
    await owner.$executeRaw`
      UPDATE mirror.client
         SET cedar_ridge_user_id = CASE sf_id
               WHEN ${CONTACT1} THEN 'CRM-DUP-MANUAL-LEFT'
               ELSE 'CRM-DUP-MANUAL-RIGHT' END,
             email = CASE sf_id
               WHEN ${CONTACT1} THEN 'manual-left@example.test'
               ELSE 'manual-right@example.test' END
       WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;

    const flagged = await flagCrmDuplicateCandidate(OPS, {
      leftCrmId: HH1,
      rightCrmId: HH2,
    });
    expect(flagged.status).toBe("created");
    if (!("candidateId" in flagged)) return;

    const beforeSweep = await getCrmDuplicateCandidateDetail(OPS, flagged.candidateId);
    expect(beforeSweep.ok && beforeSweep.detail).toMatchObject({
      operatorFlagged: true,
      sourceActive: true,
      evidenceCodes: ["OPERATOR_SUBMITTED"],
      status: "NEW",
    });

    await reconcile(owner);
    const afterSweep = await getCrmDuplicateCandidateDetail(OPS, flagged.candidateId);
    expect(afterSweep.ok && afterSweep.detail).toMatchObject({
      operatorFlagged: true,
      sourceActive: true,
      status: "NEW",
    });
    const [event] = await owner.$queryRaw<Array<{
      action: string;
      detail: Prisma.JsonValue;
    }>>`
      SELECT action, detail
        FROM app.crm_duplicate_candidate_event
       WHERE candidate_id = ${flagged.candidateId}
       ORDER BY at DESC, id DESC
       LIMIT 1`;
    expect(event).toEqual({
      action: "OPERATOR_FLAGGED",
      detail: { entityType: "HOUSEHOLD", origin: "CRM_EXPLORER" },
    });
  });

  it("keeps an Operations-submitted same-household contact pair active across detector sweeps", async () => {
    await owner.$executeRaw`
      UPDATE mirror.client
         SET household_id = ${HH1},
             first_name = CASE sf_id WHEN ${CONTACT1} THEN 'Will' ELSE 'William' END,
             last_name = 'Ewing',
             cedar_ridge_user_id = CASE sf_id
               WHEN ${CONTACT1} THEN 'CRM-DUP-CONTACT-LEFT'
               ELSE 'CRM-DUP-CONTACT-RIGHT' END
       WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;

    const flagged = await flagCrmContactDuplicateCandidate(OPS, {
      leftCrmId: CONTACT1,
      rightCrmId: CONTACT2,
    });
    expect(flagged.status).toBe("created");
    if (!("candidateId" in flagged)) return;

    const beforeSweep = await getCrmDuplicateCandidateDetail(OPS, flagged.candidateId);
    expect(beforeSweep.ok && beforeSweep.detail).toMatchObject({
      entityType: "CONTACT",
      operatorFlagged: true,
      sourceActive: true,
      evidenceCodes: ["OPERATOR_SUBMITTED", "SAME_CANONICAL_HOUSEHOLD"],
      hardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
      status: "NEW",
    });

    // The exact-name detector does not match Will/William. The controlled
    // Operations flag must therefore survive its ordinary inactivation pass.
    await reconcileContacts(owner);
    const afterSweep = await getCrmDuplicateCandidateDetail(OPS, flagged.candidateId);
    expect(afterSweep.ok && afterSweep.detail).toMatchObject({
      entityType: "CONTACT",
      operatorFlagged: true,
      sourceActive: true,
      status: "NEW",
    });
    const [event] = await owner.$queryRaw<Array<{
      action: string;
      detail: Prisma.JsonValue;
    }>>`
      SELECT action, detail
        FROM app.crm_duplicate_candidate_event
       WHERE candidate_id = ${flagged.candidateId}
       ORDER BY at DESC, id DESC
       LIMIT 1`;
    expect(event).toEqual({
      action: "OPERATOR_FLAGGED",
      detail: { entityType: "CONTACT", origin: "CRM_EXPLORER" },
    });

    if (!afterSweep.ok || !afterSweep.detail) return;
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: flagged.candidateId,
      expectedReviewVersion: afterSweep.detail.reviewVersion,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SAME_PERSON_SOURCE_DUPLICATE",
      canonicalIdentityId: afterSweep.detail.leftIdentityId,
      acceptContactIdentityConflict: true,
    })).resolves.toBe("updated");
    const confirmed = await getCrmDuplicateCandidateDetail(OPS, flagged.candidateId);
    expect(confirmed.ok && confirmed.detail).toMatchObject({
      status: "READY_FOR_FOLLOW_UP",
      canonicalIdentityId: afterSweep.detail.leftIdentityId,
      acceptedHardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
    });

    await reconcileContacts(owner);
    const afterConfirmedSweep = await getCrmDuplicateCandidateDetail(OPS, flagged.candidateId);
    expect(afterConfirmedSweep.ok && afterConfirmedSweep.detail).toMatchObject({
      status: "READY_FOR_FOLLOW_UP",
      operatorFlagged: true,
      sourceActive: true,
      canonicalIdentityId: afterSweep.detail.leftIdentityId,
      acceptedHardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
    });
  });

  it("rejects a manual contact comparison across canonical households", async () => {
    await expect(flagCrmContactDuplicateCandidate(OPS, {
      leftCrmId: CONTACT1,
      rightCrmId: CONTACT2,
    })).resolves.toEqual({ status: "different_household" });
  });

  it("does not let non-Operations roles submit a duplicate pair", async () => {
    await expect(flagCrmDuplicateCandidate(
      { role: "ADVISOR", email: "advisor@example.test" },
      { leftCrmId: HH1, rightCrmId: HH2 },
    )).resolves.toEqual({ status: "forbidden" });
  });

  it("suppresses populated name-only pairs without corroborating identity evidence", async () => {
    await owner.$executeRaw`
      UPDATE mirror.household
         SET name = 'Synthetic Exact Name Match', stage = 'Client'
       WHERE sf_id IN (${HH1}, ${HH2})`;
    await owner.$executeRaw`
      UPDATE mirror.client
         SET cedar_ridge_user_id = CASE sf_id
               WHEN ${CONTACT1} THEN 'CRM-DUP-WEAK-LEFT'
               ELSE 'CRM-DUP-WEAK-RIGHT' END,
             email = CASE sf_id
               WHEN ${CONTACT1} THEN 'weak-left@example.test'
               ELSE 'weak-right@example.test' END
       WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;

    await reconcile(owner);
    const result = await listCrmDuplicateCandidates(OPS, "potential");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(0);
  });

  it("adds controlled empty-shell evidence without selecting a survivor", async () => {
    await owner.$executeRaw`
      UPDATE mirror.household
         SET name = 'Synthetic Empty Shell Match', stage = 'Client'
       WHERE sf_id IN (${HH1}, ${HH2})`;
    await owner.$executeRaw`
      UPDATE mirror.client
         SET cedar_ridge_user_id = 'CRM-DUP-POPULATED-ONLY',
             email = 'populated-only@example.test'
       WHERE sf_id = ${CONTACT1}`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CONTACT2}`;

    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{
      evidence_codes: string[];
      canonical_identity_id: string | null;
      status: string;
    }>>`
      SELECT evidence_codes, canonical_identity_id, status::text
        FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    expect(candidate.evidence_codes).toContain("EMPTY_SHELL_WITH_POPULATED_MATCH");
    expect(candidate.canonical_identity_id).toBeNull();
    expect(candidate.status).toBe("NEW");
  });

  it("loads account candidate detail as app_rw, including the safe account ending", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app.crm_duplicate_candidate
       WHERE entity_type = 'ACCOUNT'`;
    const result = await getCrmDuplicateCandidateDetail(OPS, candidate.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail?.entityType).toBe("ACCOUNT");
    expect(result.detail?.accountEnding).toBe("SAME");
  });

  it("keeps raw PII unavailable to the machine role and rolls preview writes back", async () => {
    await expect(owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE identity_reconciler`;
      return tx.$queryRaw`SELECT cedar_ridge_user_id FROM mirror.client LIMIT 1`;
    })).rejects.toThrow(/permission denied/i);
    await expect(owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE identity_reconciler`;
      return tx.$queryRaw`SELECT custodian_account_id FROM mirror.account_holder LIMIT 1`;
    })).rejects.toThrow(/permission denied/i);

    const preview = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE identity_reconciler`;
      return tx.$queryRaw<Array<{
        signals_seen: bigint;
        candidates_opened: bigint;
      }>>`SELECT * FROM app.preview_crm_duplicate_candidates()`;
    });
    expect(Number(preview[0].signals_seen)).toBe(2);
    expect(Number(preview[0].candidates_opened)).toBe(2);
    const [persisted] = await owner.$queryRaw<Array<{ candidates: bigint; events: bigint }>>`
      SELECT
        (SELECT count(*)::bigint FROM app.crm_duplicate_candidate) AS candidates,
        (SELECT count(*)::bigint FROM app.crm_duplicate_candidate_event) AS events`;
    expect(persisted).toEqual({ candidates: 0n, events: 0n });
  });

  it("preserves Not duplicate across detector refreshes and writes both audit layers", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{
      id: string;
      review_version: number;
    }>>`
      SELECT id, review_version FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    expect(candidate).toBeDefined();
    const result = await updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "NOT_DUPLICATE",
      snoozedUntil: null,
      decisionReason: "DISTINCT_PEOPLE_OR_HOUSEHOLDS",
      canonicalIdentityId: null,
    });
    expect(result).toBe("updated");
    await reconcile(owner);

    const [saved] = await owner.$queryRaw<Array<{ status: string; source_active: boolean }>>`
      SELECT status, source_active FROM app.crm_duplicate_candidate WHERE id = ${candidate.id}`;
    expect(saved).toEqual({ status: "NOT_DUPLICATE", source_active: true });
    const [audit] = await owner.$queryRaw<Array<{
      events: bigint;
      business: bigint;
      raw: bigint;
      reviewed_by: string | null;
      event_actor: string | null;
      event_role: string | null;
    }>>`
      SELECT
        (SELECT count(*)::bigint FROM app.crm_duplicate_candidate_event
          WHERE candidate_id = ${candidate.id} AND action = 'NOT_DUPLICATE') AS events,
        (SELECT count(*)::bigint FROM audit."AuditLog"
          WHERE "entityId" = ${candidate.id}
            AND "action" = 'crm.duplicate.not_duplicate') AS business,
        (SELECT count(*)::bigint FROM audit.row_change
          WHERE row_pk = ${candidate.id}
            AND table_name = 'crm_duplicate_candidate') AS raw,
        (SELECT reviewed_by FROM app.crm_duplicate_candidate
          WHERE id = ${candidate.id}) AS reviewed_by,
        (SELECT actor_email FROM app.crm_duplicate_candidate_event
          WHERE candidate_id = ${candidate.id} AND action = 'NOT_DUPLICATE') AS event_actor,
        (SELECT actor_role FROM app.crm_duplicate_candidate_event
          WHERE candidate_id = ${candidate.id} AND action = 'NOT_DUPLICATE') AS event_role`;
    expect(Number(audit.events)).toBe(1);
    expect(Number(audit.business)).toBe(1);
    expect(Number(audit.raw)).toBeGreaterThanOrEqual(2);
    expect(audit.reviewed_by).toBe(OPS.email);
    expect(audit.event_actor).toBe(OPS.email);
    expect(audit.event_role).toBe(OPS.role);
  });

  it("records a controlled canonical recommendation without changing either CRM identity", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string; review_version: number }>>`
      SELECT id, review_version FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SHARED_IDENTIFIER_CONFIRMED",
      canonicalIdentityId: HLD1,
    })).resolves.toBe("updated");

    const [saved] = await owner.$queryRaw<Array<{
      status: string;
      decision_reason: string | null;
      canonical_identity_id: string | null;
      left_state: string;
      right_state: string;
      canonical_side: string | null;
    }>>`
      SELECT candidate.status::text AS status, candidate.decision_reason,
             candidate.canonical_identity_id,
             left_identity.lifecycle_state AS left_state,
             right_identity.lifecycle_state AS right_state,
             event.detail->>'canonicalSide' AS canonical_side
        FROM app.crm_duplicate_candidate candidate
        JOIN app.crm_identity left_identity ON left_identity.id = candidate.left_identity_id
        JOIN app.crm_identity right_identity ON right_identity.id = candidate.right_identity_id
        JOIN app.crm_duplicate_candidate_event event
          ON event.candidate_id = candidate.id AND event.action = 'READY_FOR_FOLLOW_UP'
       WHERE candidate.id = ${candidate.id}`;
    expect(saved).toEqual({
      status: "READY_FOR_FOLLOW_UP",
      decision_reason: "SHARED_IDENTIFIER_CONFIRMED",
      canonical_identity_id: HLD1,
      left_state: "ACTIVE",
      right_state: "ACTIVE",
      canonical_side: "LEFT",
    });

    await expect(resolveCrmRouteKey(OPS, "HOUSEHOLD", HH2)).resolves.toBe(HH1);
    await expect(resolveCrmDuplicateCanonicalIdentity(OPS, HLD2)).resolves.toBe(HLD1);
    const households = await listHouseholds(OPS);
    const canonicalHousehold = households.find((household) => household.sf_id === HH1);
    expect(canonicalHousehold).toMatchObject({ member_count: 2 });
    expect(households.some((household) => household.sf_id === HH2)).toBe(false);
    const clients = await listClients(OPS);
    expect(clients.find((client) => client.sf_id === CONTACT2)).toMatchObject({
      household_id: HH1,
      household_name: "Synthetic Duplicate Left",
    });
    await expect(crmCanonicalHouseholdSourceKeys(OPS, HH2)).resolves.toEqual([HH1, HH2]);
    const detail = await getHousehold(OPS, HH2);
    expect(detail).toMatchObject({
      sf_id: HH1,
      canonicalSourceCount: 2,
    });
    expect(detail?.members.map((member) => member.sf_id).sort()).toEqual(
      [CONTACT1, CONTACT2].sort(),
    );

    const potential = await listCrmDuplicateCandidates(OPS, "potential");
    expect(potential.ok).toBe(true);
    if (potential.ok) {
      expect(potential.rows.some((row) => row.id === candidate.id)).toBe(false);
    }
    const confirmed = await listCrmDuplicateCandidates(OPS, "confirmed");
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.rows.some((row) => row.id === candidate.id)).toBe(true);
    }
  });

  it("confirms a contact duplicate with the controlled same-person reason", async () => {
    await owner.$executeRaw`
      UPDATE mirror.client
         SET household_id = ${HH1},
             first_name = 'Synthetic',
             last_name = 'Same Person',
             cedar_ridge_user_id = 'CRM-DUP-SAME-PERSON'
       WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;
    await reconcileContacts(owner);

    const [candidate] = await owner.$queryRaw<Array<{
      id: string;
      review_version: number;
      left_identity_id: string;
      right_identity_id: string;
    }>>`
      SELECT id, review_version, left_identity_id, right_identity_id
        FROM app.crm_duplicate_candidate
       WHERE entity_type = 'CONTACT'
         AND left_identity_id IN (${CID1}, ${CID2})
         AND right_identity_id IN (${CID1}, ${CID2})`;
    expect(candidate).toMatchObject({
      left_identity_id: CID1,
      right_identity_id: CID2,
    });

    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SAME_PERSON_SOURCE_DUPLICATE",
      canonicalIdentityId: CID1,
    })).resolves.toBe("updated");

    const [saved] = await owner.$queryRaw<Array<{
      status: string;
      decision_reason: string | null;
      canonical_identity_id: string | null;
      left_state: string;
      right_state: string;
    }>>`
      SELECT candidate.status::text AS status, candidate.decision_reason,
             candidate.canonical_identity_id,
             left_identity.lifecycle_state AS left_state,
             right_identity.lifecycle_state AS right_state
        FROM app.crm_duplicate_candidate candidate
        JOIN app.crm_identity left_identity ON left_identity.id = candidate.left_identity_id
        JOIN app.crm_identity right_identity ON right_identity.id = candidate.right_identity_id
       WHERE candidate.id = ${candidate.id}`;
    expect(saved).toEqual({
      status: "READY_FOR_FOLLOW_UP",
      decision_reason: "SAME_PERSON_SOURCE_DUPLICATE",
      canonical_identity_id: CID1,
      left_state: "ACTIVE",
      right_state: "ACTIVE",
    });

    await expect(resolveCrmRouteKey(OPS, "CONTACT", CONTACT2)).resolves.toBe(CONTACT1);
    await expect(resolveCrmDuplicateCanonicalIdentity(OPS, CID2)).resolves.toBe(CID1);
    const confirmedContacts = await listCrmDuplicateCandidates(OPS, "confirmed", "CONTACT");
    expect(confirmedContacts.ok).toBe(true);
    if (confirmedContacts.ok) {
      expect(confirmedContacts.rows).toHaveLength(1);
      expect(confirmedContacts.rows[0]?.entityType).toBe("CONTACT");
    }
    const confirmedHouseholds = await listCrmDuplicateCandidates(OPS, "confirmed", "HOUSEHOLD");
    expect(confirmedHouseholds.ok).toBe(true);
    if (confirmedHouseholds.ok) expect(confirmedHouseholds.rows).toHaveLength(0);
    const clients = await listClients(OPS);
    expect(clients.some((client) => client.sf_id === CONTACT1)).toBe(true);
    expect(clients.some((client) => client.sf_id === CONTACT2)).toBe(false);
  });

  it("requires and audits the bounded contact identity-conflict acknowledgement", async () => {
    await owner.$executeRaw`
      UPDATE mirror.client
         SET household_id = ${HH1},
             first_name = 'Synthetic',
             last_name = 'Identity Conflict',
             cedar_ridge_user_id = CASE sf_id
               WHEN ${CONTACT1} THEN 'CRM-DUP-CONFLICT-LEFT'
               ELSE 'CRM-DUP-CONFLICT-RIGHT' END
       WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;
    await reconcileContacts(owner);

    const [candidate] = await owner.$queryRaw<Array<{
      id: string;
      review_version: number;
      hard_conflict_codes: string[];
    }>>`
      SELECT id, review_version, hard_conflict_codes
        FROM app.crm_duplicate_candidate
       WHERE entity_type = 'CONTACT'
         AND left_identity_id IN (${CID1}, ${CID2})
         AND right_identity_id IN (${CID1}, ${CID2})`;
    expect(candidate.hard_conflict_codes).toEqual(["CONFLICTING_CONTACT_IDENTITY"]);

    const decision = {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP" as const,
      snoozedUntil: null,
      decisionReason: "SAME_PERSON_SOURCE_DUPLICATE" as const,
      canonicalIdentityId: CID1,
    };
    await expect(updateCrmDuplicateReview(OPS, decision)).resolves.toBe("invalid");
    await expect(updateCrmDuplicateReview(OPS, {
      ...decision,
      acceptContactIdentityConflict: true,
    })).resolves.toBe("updated");

    const [saved] = await owner.$queryRaw<Array<{
      status: string;
      accepted_hard_conflict_codes: string[];
      conflict_override_by: string | null;
      conflict_override_at: Date | null;
      event_codes: string[];
      business_codes: string[];
    }>>`
      SELECT candidate.status::text AS status,
             candidate.accepted_hard_conflict_codes,
             candidate.conflict_override_by,
             candidate.conflict_override_at,
             ARRAY(
               SELECT jsonb_array_elements_text(event.detail->'acceptedHardConflictCodes')
                 FROM app.crm_duplicate_candidate_event event
                WHERE event.candidate_id = candidate.id
                  AND event.action = 'READY_FOR_FOLLOW_UP'
             ) AS event_codes,
             ARRAY(
               SELECT jsonb_array_elements_text(
                 coalesce(audit."detail", '{}')::jsonb->'acceptedHardConflictCodes'
               )
                 FROM audit."AuditLog" audit
                WHERE audit."entityId" = candidate.id
                  AND audit."action" = 'crm.duplicate.ready_for_follow_up'
             ) AS business_codes
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = ${candidate.id}`;
    expect(saved).toMatchObject({
      status: "READY_FOR_FOLLOW_UP",
      accepted_hard_conflict_codes: ["CONFLICTING_CONTACT_IDENTITY"],
      conflict_override_by: OPS.email,
      event_codes: ["CONFLICTING_CONTACT_IDENTITY"],
      business_codes: ["CONFLICTING_CONTACT_IDENTITY"],
    });
    expect(saved.conflict_override_at).toBeInstanceOf(Date);

    await reconcileContacts(owner);
    const [preserved] = await owner.$queryRaw<Array<{
      status: string;
      accepted_hard_conflict_codes: string[];
      invalidations: bigint;
    }>>`
      SELECT candidate.status::text AS status,
             candidate.accepted_hard_conflict_codes,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'INVALIDATED_BY_CONFLICT') AS invalidations
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = ${candidate.id}`;
    expect(preserved).toEqual({
      status: "READY_FOR_FOLLOW_UP",
      accepted_hard_conflict_codes: ["CONFLICTING_CONTACT_IDENTITY"],
      invalidations: 0n,
    });
  });

  it("removes the overlay when accepted contact evidence later becomes incomplete", async () => {
    await owner.$executeRaw`
      UPDATE mirror.client
         SET household_id = ${HH1},
             first_name = 'Synthetic',
             last_name = 'Identity Conflict',
             cedar_ridge_user_id = CASE sf_id
               WHEN ${CONTACT1} THEN 'CRM-DUP-CONFLICT-LEFT'
               ELSE 'CRM-DUP-CONFLICT-RIGHT' END
       WHERE sf_id IN (${CONTACT1}, ${CONTACT2})`;
    await reconcileContacts(owner);
    const [candidate] = await owner.$queryRaw<Array<{
      id: string;
      review_version: number;
    }>>`
      SELECT id, review_version
        FROM app.crm_duplicate_candidate
       WHERE entity_type = 'CONTACT'
         AND left_identity_id IN (${CID1}, ${CID2})
         AND right_identity_id IN (${CID1}, ${CID2})`;
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SAME_PERSON_SOURCE_DUPLICATE",
      canonicalIdentityId: CID1,
      acceptContactIdentityConflict: true,
    })).resolves.toBe("updated");

    await owner.$executeRaw`
      UPDATE mirror.client SET cedar_ridge_user_id = NULL WHERE sf_id = ${CONTACT2}`;
    await reconcileContacts(owner);

    const [invalidated] = await owner.$queryRaw<Array<{
      status: string;
      source_active: boolean;
      canonical_identity_id: string | null;
      accepted_hard_conflict_codes: string[];
      invalidations: bigint;
    }>>`
      SELECT candidate.status::text AS status, candidate.source_active,
             candidate.canonical_identity_id,
             candidate.accepted_hard_conflict_codes,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'INVALIDATED_BY_CONFLICT') AS invalidations
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = ${candidate.id}`;
    expect(invalidated).toEqual({
      status: "NEW",
      source_active: false,
      canonical_identity_id: null,
      accepted_hard_conflict_codes: [],
      invalidations: 1n,
    });
    await expect(resolveCrmRouteKey(OPS, "CONTACT", CONTACT2)).resolves.toBe(CONTACT2);
  });

  it("reopens a confirmed household and removes the AOA canonicalization", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string; review_version: number }>>`
      SELECT id, review_version FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SHARED_IDENTIFIER_CONFIRMED",
      canonicalIdentityId: HLD1,
    })).resolves.toBe("updated");
    const [confirmed] = await owner.$queryRaw<Array<{ review_version: number }>>`
      SELECT review_version FROM app.crm_duplicate_candidate WHERE id = ${candidate.id}`;

    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: confirmed.review_version,
      decision: "NEW",
      snoozedUntil: null,
      decisionReason: null,
      canonicalIdentityId: null,
    })).resolves.toBe("updated");

    const [saved] = await owner.$queryRaw<Array<{
      status: string;
      decision_reason: string | null;
      canonical_identity_id: string | null;
      reopened_events: bigint;
      business_events: bigint;
    }>>`
      SELECT candidate.status::text AS status, candidate.decision_reason,
             candidate.canonical_identity_id,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'REOPENED') AS reopened_events,
             (SELECT count(*)::bigint
                FROM audit."AuditLog" audit
               WHERE audit."entityId" = candidate.id
                 AND audit."action" = 'crm.duplicate.reopen') AS business_events
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = ${candidate.id}`;
    expect(saved).toEqual({
      status: "NEW",
      decision_reason: null,
      canonical_identity_id: null,
      reopened_events: 1n,
      business_events: 1n,
    });
    await expect(resolveCrmRouteKey(OPS, "HOUSEHOLD", HH2)).resolves.toBe(HH2);
    await expect(resolveCrmDuplicateCanonicalIdentity(OPS, HLD2)).resolves.toBe(HLD2);
    await expect(crmCanonicalHouseholdSourceKeys(OPS, HH2)).resolves.toEqual([HH2]);
    const households = await listHouseholds(OPS);
    expect(households.some((household) => household.sf_id === HH1)).toBe(true);
    expect(households.some((household) => household.sf_id === HH2)).toBe(true);
  });

  it("uses comparable structured outcomes for a shadow recommendation", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{
      id: string;
      evidence_codes: string[];
    }>>`
      SELECT id, evidence_codes FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    for (let index = 1; index <= 3; index += 1) {
      const suffix = index.toString(16).padStart(24, "0");
      const key = index.toString(16).repeat(64);
      await owner.$executeRaw(Prisma.sql`
        INSERT INTO app.crm_duplicate_candidate (
          id, detector_key, entity_type, left_identity_id, right_identity_id,
          evidence_codes, hard_conflict_codes, source_active, status,
          decision_reason, updated_at
        ) VALUES (
          ${`dup_c${suffix}`}, ${key}, 'HOUSEHOLD', ${HLD1}, ${HLD2},
          ${candidate.evidence_codes}, ARRAY[]::text[], false, 'NOT_DUPLICATE',
          'DISTINCT_PEOPLE_OR_HOUSEHOLDS', now()
        )
      `);
    }

    const result = await getCrmDuplicateCandidateDetail(OPS, candidate.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail?.learning).toMatchObject({
      recommendation: "KEEP_SEPARATE",
      confidence: "HIGH",
      similarReviewed: 3,
      similarConfirmed: 0,
      similarRejected: 3,
    });
  });

  it("does not audit last-seen-only refreshes", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app.crm_duplicate_candidate WHERE entity_type = 'HOUSEHOLD'`;
    const before = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM audit.row_change
       WHERE table_name = 'crm_duplicate_candidate' AND row_pk = ${candidate.id}`;
    await reconcile(owner);
    const after = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM audit.row_change
       WHERE table_name = 'crm_duplicate_candidate' AND row_pk = ${candidate.id}`;
    expect(after[0].n).toBe(before[0].n);
  });

  it("invalidates a stale review and atomically blocks READY when conflicts arrive", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string; review_version: number }>>`
      SELECT id, review_version FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    await owner.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, email, lead_advisor_email,
         cedar_ridge_user_id, synced_at)
      VALUES (${CONTACT_CONFLICT}, ${HH2}, 'Synthetic', 'Conflict', 'shared@example.test',
        'advisor@example.test', 'CRM-DUP-DIFFERENT-USER', now())`;
    await reconcile(owner);

    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SHARED_IDENTIFIER_CONFIRMED",
      canonicalIdentityId: HLD1,
    })).resolves.toBe("conflict");
    const [refreshed] = await owner.$queryRaw<Array<{
      review_version: number;
      hard_conflict_codes: string[];
    }>>`
      SELECT review_version, hard_conflict_codes
        FROM app.crm_duplicate_candidate WHERE id = ${candidate.id}`;
    expect(refreshed.review_version).toBe(candidate.review_version + 1);
    expect(refreshed.hard_conflict_codes).toContain("CONFLICTING_MEMBER_IDENTITY");
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: refreshed.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SHARED_IDENTIFIER_CONFIRMED",
      canonicalIdentityId: HLD1,
    })).resolves.toBe("invalid");
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: refreshed.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SHARED_IDENTIFIER_CONFIRMED",
      canonicalIdentityId: HLD1,
      acceptContactIdentityConflict: true,
    })).resolves.toBe("invalid");
  });

  it("demotes READY and appends a machine invalidation when a later detector run finds a conflict", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string; review_version: number }>>`
      SELECT id, review_version FROM app.crm_duplicate_candidate
       WHERE entity_type = 'HOUSEHOLD'`;
    await expect(updateCrmDuplicateReview(OPS, {
      candidateId: candidate.id,
      expectedReviewVersion: candidate.review_version,
      decision: "READY_FOR_FOLLOW_UP",
      snoozedUntil: null,
      decisionReason: "SHARED_IDENTIFIER_CONFIRMED",
      canonicalIdentityId: HLD1,
    })).resolves.toBe("updated");

    await owner.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, email, lead_advisor_email,
         cedar_ridge_user_id, synced_at)
      VALUES (${CONTACT_CONFLICT}, ${HH2}, 'Synthetic', 'Conflict', 'shared@example.test',
        'advisor@example.test', 'CRM-DUP-DIFFERENT-USER', now())`;
    await reconcile(owner);

    const [saved] = await owner.$queryRaw<Array<{
      status: string;
      review_version: number;
      hard_conflict_codes: string[];
      ready_events: bigint;
      invalidation_events: bigint;
      invalidation_from: string | null;
      invalidation_to: string | null;
    }>>`
      SELECT candidate.status::text AS status,
             candidate.review_version,
             candidate.hard_conflict_codes,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'READY_FOR_FOLLOW_UP') AS ready_events,
             (SELECT count(*)::bigint
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'INVALIDATED_BY_CONFLICT') AS invalidation_events,
             (SELECT event.from_status::text
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'INVALIDATED_BY_CONFLICT'
               ORDER BY event.id DESC LIMIT 1) AS invalidation_from,
             (SELECT event.to_status::text
                FROM app.crm_duplicate_candidate_event event
               WHERE event.candidate_id = candidate.id
                 AND event.action = 'INVALIDATED_BY_CONFLICT'
               ORDER BY event.id DESC LIMIT 1) AS invalidation_to
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = ${candidate.id}`;
    expect(saved.status).toBe("NEW");
    expect(saved.review_version).toBe(candidate.review_version + 2);
    expect(saved.hard_conflict_codes).toContain("CONFLICTING_MEMBER_IDENTITY");
    expect(saved.ready_events).toBe(1n);
    expect(saved.invalidation_events).toBe(1n);
    expect(saved.invalidation_from).toBe("READY_FOR_FOLLOW_UP");
    expect(saved.invalidation_to).toBe("NEW");

    await expect(owner.$executeRaw`
      UPDATE app.crm_duplicate_candidate
         SET status = 'READY_FOR_FOLLOW_UP'
       WHERE id = ${candidate.id}`).rejects.toThrow(
      /crm_duplicate_candidate_ready_without_conflicts/i,
    );
  });

  it("previews parent, identity, and duplicate reconciliation in one exact rollback state", async () => {
    await owner.$executeRaw`
      DELETE FROM app.crm_source_mapping
       WHERE id IN (${MAP1}, ${MAP2})`;
    await owner.$executeRaw`
      DELETE FROM app.crm_identity WHERE id IN (${HLD1}, ${HLD2})`;
    const [before] = await owner.$queryRaw<Array<{ identities: bigint }>>`
      SELECT count(*)::bigint AS identities FROM app.crm_identity`;

    const [preview] = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE identity_reconciler`;
      return tx.$queryRaw<Array<{
        identities_created: bigint;
        mappings_created: bigint;
        duplicate_signals_seen: bigint;
        duplicate_candidates_would_open: bigint;
      }>>`
        SELECT * FROM app.preview_crm_identity_duplicate_reconciliation(
          '00000000-0000-4000-8000-000000000099'
        )`;
    });
    expect(Number(preview.identities_created)).toBeGreaterThanOrEqual(2);
    expect(Number(preview.mappings_created)).toBeGreaterThanOrEqual(2);
    expect(Number(preview.duplicate_signals_seen)).toBeGreaterThanOrEqual(1);
    expect(Number(preview.duplicate_candidates_would_open)).toBeGreaterThanOrEqual(1);

    const [persisted] = await owner.$queryRaw<Array<{
      identities: bigint;
      mappings: bigint;
      candidates: bigint;
      events: bigint;
    }>>`
      SELECT
        (SELECT count(*)::bigint FROM app.crm_identity) AS identities,
        (SELECT count(*)::bigint FROM app.crm_source_mapping
          WHERE source_system = 'CRM'
            AND source_namespace = 'household'
            AND source_key IN (${HH1}, ${HH2})) AS mappings,
        (SELECT count(*)::bigint FROM app.crm_duplicate_candidate) AS candidates,
        (SELECT count(*)::bigint FROM app.crm_duplicate_candidate_event) AS events`;
    expect(persisted).toEqual({
      identities: before.identities,
      mappings: 0n,
      candidates: 0n,
      events: 0n,
    });
  });

  it("denies app_rw direct reviewer and event forgery", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app.crm_duplicate_candidate LIMIT 1`;
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`
      UPDATE app.crm_duplicate_candidate
         SET reviewed_by = 'forged@example.test'
       WHERE id = ${candidate.id}`)).rejects.toThrow(/permission denied/i);
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`
      INSERT INTO app.crm_duplicate_candidate_event
        (candidate_id, action, actor_email, actor_role, from_status, to_status)
      VALUES (${candidate.id}, 'NOT_DUPLICATE', 'forged@example.test', 'ADMIN',
        'NEW', 'NOT_DUPLICATE')`)).rejects.toThrow(/permission denied/i);
  });

  it("fails closed for non-operations roles before any workflow write", async () => {
    await reconcile(owner);
    const [candidate] = await owner.$queryRaw<Array<{ id: string; review_version: number }>>`
      SELECT id, review_version FROM app.crm_duplicate_candidate LIMIT 1`;
    await expect(updateCrmDuplicateReview(
      { role: "ADVISOR", email: "advisor@example.test" },
      {
        candidateId: candidate.id,
        expectedReviewVersion: candidate.review_version,
        decision: "NOT_DUPLICATE",
        snoozedUntil: null,
        decisionReason: "DISTINCT_PEOPLE_OR_HOUSEHOLDS",
        canonicalIdentityId: null,
      },
    )).resolves.toBe("forbidden");
  });
});
