import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({
  auth: async () => ({
    user: { role: "OPERATIONS", email: "asset-map-review-synthetic@example.test" },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
import { confirmAccountOwners } from "@/app/(authenticated)/asset-mapping-review/actions";
import {
  listAccountReviewQueue,
  listKnownAccounts,
  resolveAccountForReview,
} from "@/lib/data/asset-map-review";
import { prisma } from "@/lib/db";
import { withUserScope, type Identity } from "@/lib/rls";

const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ASSET-REVIEW-";
const id = (suffix: string) => `${PREFIX}${suffix}`;
const OPS: Identity = {
  role: "OPERATIONS",
  email: "asset-map-review-synthetic@example.test",
};
const CUSTODIAN = "Synthetic Review Custodian";
const NUMBERS = {
  pendingA: "SYNTHETIC-BOUNDARY-11001234",
  pendingB: "SYNTHETIC-BOUNDARY-99001234",
  known: "SYNTHETIC-BOUNDARY-22005678",
  historicalPending: "SYNTHETIC-BOUNDARY-33004567",
  historicalKnown: "SYNTHETIC-BOUNDARY-44008901",
  unresolved: "SYNTHETIC-BOUNDARY-55002345",
  rollback: "SYNTHETIC-BOUNDARY-66003456",
};

function resolve(accountId: string, identity: Identity = OPS) {
  return withUserScope(identity, (tx) => resolveAccountForReview(tx, accountId));
}

function fixtureFolders<T extends { sourceFolderId: string }>(folders: T[]) {
  return folders.filter((folder) => folder.sourceFolderId.startsWith(PREFIX));
}

function expectMaskedPayload(value: unknown) {
  const payload = JSON.stringify(value);
  for (const number of Object.values(NUMBERS)) expect(payload).not.toContain(number);
  expect(payload).not.toContain("SYNTHETIC-BOUNDARY-");
  expect(payload).not.toMatch(/"(?:accountNumber|account_number)":/);
}

gated("Asset-map review browser boundary with actual PostgreSQL/RLS", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    const pattern = `${PREFIX}%`;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_account_link WHERE source_folder_id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_link WHERE source_folder_id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE ${pattern}`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityId" LIKE ${pattern}`;
  }

  beforeAll(async () => {
    const cleanupUrl = process.env.INGEST_TEST_CLEANUP_URL;
    const appUrl = process.env.DATABASE_URL;
    const ingestUrl = process.env.INGEST_DATABASE_URL;
    if (!cleanupUrl || !appUrl || !ingestUrl) {
      throw new Error("Explicit synthetic database URLs are required");
    }
    const target = new URL(cleanupUrl);
    for (const value of [cleanupUrl, appUrl, ingestUrl]) {
      const url = new URL(value);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.host !== target.host ||
        url.pathname !== target.pathname ||
        ["host", "hostaddr", "service", "servicefile"].some((key) =>
          url.searchParams.has(key),
        )
      ) {
        throw new Error("Review integration tests require one loopback synthetic database");
      }
    }
    if (new URL(appUrl).username !== "app_rw") {
      throw new Error("Review RLS reads must run as app_rw");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await cleanup();

    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${id("crm-household")}, 'Synthetic Review Household', ${OPS.email!}),
             (${id("other-household")}, 'Synthetic Other Household', ${OPS.email!})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, lead_advisor_email, cedar_ridge_user_id)
      VALUES (${id("client")}, ${id("crm-household")}, 'Synthetic', 'Reviewer',
              ${OPS.email!}, ${id("person")}),
             (${id("second-client")}, ${id("crm-household")}, 'Synthetic', 'Partner',
              ${OPS.email!}, ${id("second-person")}),
             (${id("outside-client")}, ${id("other-household")}, 'Synthetic', 'Outsider',
              ${OPS.email!}, ${id("outside-person")})`;

    for (const [household, folder, processed, superseded] of [
      ["current", "resolved-folder", "2026-09-20", null],
      // Both rows are unsuperseded; latest-per-folder selection must still reject the old ID.
      ["older", "resolved-folder", "2026-09-01", null],
      ["superseded", "resolved-folder", "2026-09-23", id("current")],
      ["unresolved", "unresolved-folder", "2026-09-20", null],
      ["no-folder", null, "2026-09-20", null],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO mirror.acat_asset_map_household
          (id, source_folder_id, client_name, processed_at, superseded_by)
        VALUES (${id(household)}, ${folder === null ? null : id(folder)},
                'Synthetic Reviewer', ${new Date(processed)}, ${superseded})`;
    }

    for (const [account, household, number, custodian] of [
      ["pending-a", "current", NUMBERS.pendingA, CUSTODIAN],
      ["pending-b", "current", NUMBERS.pendingB, CUSTODIAN],
      ["known", "current", NUMBERS.known, CUSTODIAN],
      ["rollback-account", "current", NUMBERS.rollback, CUSTODIAN],
      ["older-account", "older", NUMBERS.pendingA, CUSTODIAN],
      ["superseded-account", "superseded", NUMBERS.pendingA, CUSTODIAN],
      ["unresolved-account", "unresolved", NUMBERS.unresolved, CUSTODIAN],
      ["missing-custodian", "current", NUMBERS.pendingA, null],
      ["empty-custodian", "current", NUMBERS.pendingA, ""],
      ["missing-number", "current", null, CUSTODIAN],
      ["empty-number", "current", "", CUSTODIAN],
      ["missing-folder", "no-folder", NUMBERS.pendingA, CUSTODIAN],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO mirror.acat_asset_map_account
          (id, household_id, custodian, account_number, account_holder, total_value)
        VALUES (${id(account)}, ${id(household)}, ${custodian}, ${number},
                'Synthetic Reviewer', 1250.75)`;
    }

    await owner.$executeRaw`
      INSERT INTO mirror.acat_asset_map_link
        (source_folder_id, household_sf_id, match_status)
      VALUES (${id("resolved-folder")}, ${id("crm-household")}, 'CONFIRMED'),
             (${id("unresolved-folder")}, NULL, 'NEEDS_REVIEW')`;
    for (const [number, status] of [
      [NUMBERS.pendingA, "NEEDS_REVIEW"],
      [NUMBERS.pendingB, "NEEDS_REVIEW"],
      [NUMBERS.historicalPending, "NEEDS_REVIEW"],
      [NUMBERS.known, "AUTO_LINKED"],
      [NUMBERS.historicalKnown, "CONFIRMED"],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO mirror.acat_asset_map_account_link
          (source_folder_id, custodian, account_number, client_sf_id, cedar_ridge_user_id,
           ownership_role, is_entity, match_status)
        VALUES (${id("resolved-folder")}, ${CUSTODIAN}, ${number}, ${id("client")},
                ${id("person")}, 'PRIMARY', false, ${status})`;
    }
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
    }
  });

  it("keeps colliding last-four rows distinct and resolves their full keys only on the server", async () => {
    const folders = fixtureFolders(await listAccountReviewQueue(OPS));
    const folder = folders.find((row) => row.sourceFolderId === id("resolved-folder"));
    expect(folder?.folderResolved).toBe(true);
    const collisions = folder!.accounts.filter((row) => row.accountNumberMasked === "••••1234");
    expect(collisions.map((row) => row.accountId).sort()).toEqual([id("pending-a"), id("pending-b")]);
    expect(collisions.every((row) => row.totalValue === 1250.75)).toBe(true);
    expect(collisions.every((row) => row.candidates.some((candidate) => candidate.clientSfId === id("client")))).toBe(true);
    expectMaskedPayload(folders);
    for (const [account, accountNumber] of [
      ["pending-a", NUMBERS.pendingA], ["pending-b", NUMBERS.pendingB],
    ]) {
      expect(await resolve(id(account))).toEqual({
        sourceFolderId: id("resolved-folder"), custodian: CUSTODIAN, accountNumber,
      });
    }
  });

  it("returns an opaque current ID and masked value for the unresolved fold-in queue", async () => {
    const folders = fixtureFolders(await listAccountReviewQueue(OPS));
    const folder = folders.find((row) => row.sourceFolderId === id("unresolved-folder"));
    expect(folder).toMatchObject({ folderResolved: false, householdSfId: null });
    expect(folder?.accounts).toHaveLength(1);
    expect(folder?.accounts[0]).toMatchObject({
      accountId: id("unresolved-account"), accountNumberMasked: "••••2345", candidates: [],
    });
    expectMaskedPayload(folder);
    expect(await resolve(id("unresolved-account"))).toEqual({
      sourceFolderId: id("unresolved-folder"), custodian: CUSTODIAN, accountNumber: NUMBERS.unresolved,
    });
  });

  it("keeps historical queued and known accounts masked without inventing a writable current ID", async () => {
    const queue = fixtureFolders(await listAccountReviewQueue(OPS));
    const known = fixtureFolders(await listKnownAccounts(OPS));
    expect(queue.find((row) => row.sourceFolderId === id("resolved-folder"))?.accounts)
      .toContainEqual(expect.objectContaining({
        accountId: null, accountNumberMasked: "••••4567", totalValue: null,
      }));
    expect(known).toHaveLength(1);
    expect(known[0].accounts).toHaveLength(2);
    expect(known[0].accounts).toContainEqual(expect.objectContaining({
      accountId: id("known"), accountNumberMasked: "••••5678", status: "AUTO_LINKED",
      owners: [{ clientSfId: id("client"), name: "Synthetic Reviewer", cedarRidgeUserId: id("person") }],
    }));
    expect(known[0].accounts).toContainEqual(expect.objectContaining({
      accountId: null, accountNumberMasked: "••••8901", status: "CONFIRMED", totalValue: null,
    }));
    expectMaskedPayload({ queue, known });
    expect(await resolve(id("known"))).toMatchObject({ accountNumber: NUMBERS.known });
    expect(await resolve(NUMBERS.historicalKnown)).toBeNull();
  });

  it("rejects malformed, missing, superseded and older same-folder IDs and incomplete durable keys", async () => {
    for (const accountId of [
      "", "   ", "x".repeat(257), id("absent"), NUMBERS.pendingA,
      ...["older-account", "superseded-account", "missing-custodian", "empty-custodian",
        "missing-number", "empty-number", "missing-folder"].map(id),
    ]) {
      expect(await resolve(accountId), `Unexpected resolution for ${accountId}`).toBeNull();
    }
  });

  it("rejects a formerly listed ID when a newer same-folder run replaces it", async () => {
    const before = fixtureFolders(await listAccountReviewQueue(OPS));
    expect(before.flatMap((folder) => folder.accounts.map((account) => account.accountId)))
      .toContain(id("pending-a"));
    try {
      await owner!.$executeRaw`
        UPDATE mirror.acat_asset_map_household SET processed_at = '2026-09-24'::timestamptz
        WHERE id = ${id("older")}`;
      expect(await resolve(id("pending-a"))).toBeNull();
      expect(await resolve(id("older-account"))).toMatchObject({ accountNumber: NUMBERS.pendingA });
      const after = fixtureFolders(await listAccountReviewQueue(OPS));
      const currentIds = after.flatMap((folder) => folder.accounts.map((account) => account.accountId));
      expect(currentIds).not.toContain(id("pending-a"));
      expect(currentIds).toContain(id("older-account"));
      expectMaskedPayload(after);
    } finally {
      await owner!.$executeRaw`
        UPDATE mirror.acat_asset_map_household SET processed_at = '2026-09-01'::timestamptz
        WHERE id = ${id("older")}`;
    }
  });

  it("rolls back unresolved folder confirmation when a selected owner is outside that household", async () => {
    const before = await owner!.$queryRaw`
      SELECT * FROM mirror.acat_asset_map_link WHERE source_folder_id = ${id("unresolved-folder")}`;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await confirmAccountOwners(
        id("unresolved-account"), [id("client"), id("outside-client")], false, id("client"),
      )).toMatchObject({ ok: false });
      const after = await owner!.$queryRaw`
        SELECT * FROM mirror.acat_asset_map_link WHERE source_folder_id = ${id("unresolved-folder")}`;
      expect(after).toEqual(before);
      expect(await owner!.$queryRaw`
        SELECT * FROM mirror.acat_asset_map_account_link
        WHERE source_folder_id = ${id("unresolved-folder")}`).toEqual([]);
      expect(await owner!.$queryRaw`
        SELECT id FROM audit."AuditLog" WHERE "entityId" = ${id("unresolved-folder")}`).toEqual([]);
      expect(log).toHaveBeenCalledWith("[asset-map-review] confirm_account_failed");
    } finally {
      log.mockRestore();
    }
  });

  it("rolls back confirmed and rejected owner changes when a selected owner is already terminal", async () => {
    // The first selected owner can update, but the second is already REJECTED.
    // The store also soft-rejects an unselected queued owner before returning its
    // short count. The action must roll all of those actual writes back.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [person, client, status] of [
        ["person", "client", "NEEDS_REVIEW"],
        ["second-person", "second-client", "REJECTED"],
        ["outside-person", "outside-client", "AUTO_LINKED"],
      ]) {
        await owner!.$executeRaw`
          INSERT INTO mirror.acat_asset_map_account_link
            (source_folder_id, custodian, account_number, cedar_ridge_user_id, client_sf_id,
             ownership_role, is_entity, match_status)
          VALUES (${id("resolved-folder")}, ${CUSTODIAN}, ${NUMBERS.rollback},
                  ${id(person)}, ${id(client)}, 'PRIMARY', false, ${status})`;
      }
      const before = await owner!.$queryRaw`
        SELECT * FROM mirror.acat_asset_map_account_link
        WHERE source_folder_id = ${id("resolved-folder")} AND account_number = ${NUMBERS.rollback}
        ORDER BY cedar_ridge_user_id`;
      expect(await confirmAccountOwners(
        id("rollback-account"), [id("client"), id("second-client")], false,
      )).toMatchObject({ ok: false });
      const after = await owner!.$queryRaw`
        SELECT * FROM mirror.acat_asset_map_account_link
        WHERE source_folder_id = ${id("resolved-folder")} AND account_number = ${NUMBERS.rollback}
        ORDER BY cedar_ridge_user_id`;
      expect(after).toEqual(before);
      expect(await owner!.$queryRaw`
        SELECT id FROM audit."AuditLog" WHERE "entityId" = ${id("resolved-folder")}`).toEqual([]);
      expect(log).toHaveBeenCalledWith("[asset-map-review] confirm_account_failed");
    } finally {
      log.mockRestore();
      await owner!.$executeRaw`
        DELETE FROM mirror.acat_asset_map_account_link
        WHERE source_folder_id = ${id("resolved-folder")} AND account_number = ${NUMBERS.rollback}`;
    }
  });

  it.each(["ADMIN", "OPERATIONS"])("permits %s scoped listing and resolution", async (role) => {
    const identity = { ...OPS, role };
    expect(fixtureFolders(await listAccountReviewQueue(identity))).toHaveLength(2);
    expect(fixtureFolders(await listKnownAccounts(identity))).toHaveLength(1);
    expect(await resolve(id("pending-a"), identity)).not.toBeNull();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "UNKNOWN", null])(
    "RLS denies both queues and a guessed current ID for role %s",
    async (role) => {
      const identity = { ...OPS, role };
      expect(await listAccountReviewQueue(identity)).toEqual([]);
      expect(await listKnownAccounts(identity)).toEqual([]);
      expect(await resolve(id("pending-a"), identity)).toBeNull();
    },
  );
});
