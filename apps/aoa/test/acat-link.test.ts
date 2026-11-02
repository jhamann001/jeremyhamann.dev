import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";
import {
  attachableTransfers,
  attachAcatToTransfer,
  buildLinkTransferInput,
  createLinkedTransfer,
  isUnmatchedProspect,
  normalizeAcatTransferId,
  splitProspectName,
  unlinkAcatFromTransfer,
  LINK_ERRORS,
  type AcatLinkKey,
  type LinkTarget,
} from "@/lib/data/acat-link";

// WO ticket (+ record-id linking) — the CI-provable core of the ACAT link /
// onboard write. Pure builders + decision predicates run in the node env; the
// seam writers are exercised with a FAKE transaction client (never a real DB —
// CI has no Postgres, the deal-stage-write.test.ts idiom); the co-located
// server actions' GATE is locked with mocked auth/rls (the
// audit-log-seam.test.ts mocked-scope idiom) — a non-permitted role gets
// `forbidden` and NO scope is ever opened.
//
// RECORD-ID LINKING: the tracker record PK (`recordId`, always present) is the
// PRIMARY link key; the raw `acatTransferId` UUID is normalized (D2) and stored
// only when real. The fake tx's findFirst dispatches on the where clause so the
// record-id (primary) and legacy-UUID (secondary) duplicate lookups are
// distinguishable.

const OPS: Identity = { role: "OPERATIONS", email: "ops@example.com" };

const clientTarget: LinkTarget = {
  kind: "client",
  clientSfId: "003CLIENT",
  firstName: "Ada",
  lastName: "Client",
  householdSfId: "001HH",
  householdName: "Client Household",
};
const householdTarget: LinkTarget = {
  kind: "household",
  householdSfId: "001HH",
  householdName: "Client Household",
  firstName: "Client",
  lastName: "Household",
};
const prospectTarget: LinkTarget = { kind: "prospect", name: "Dana Prospect" };

/** The common link key: a record id + a real tracker UUID. */
const key = (
  recordId: string,
  acatTransferId: string | null,
): AcatLinkKey => ({ recordId, acatTransferId });

// ---------------------------------------------------------------------------
// PURE
// ---------------------------------------------------------------------------

describe("splitProspectName", () => {
  it("splits on the last space", () => {
    expect(splitProspectName("Dana Prospect")).toEqual({
      first: "Dana",
      last: "Prospect",
    });
    expect(splitProspectName("Alexys Willie Watson")).toEqual({
      first: "Alexys Willie",
      last: "Watson",
    });
  });

  it("mirrors a single token so both halves are non-blank (validator passes)", () => {
    expect(splitProspectName("Cher")).toEqual({ first: "Cher", last: "Cher" });
  });

  it("trims surrounding whitespace", () => {
    expect(splitProspectName("  Dana   Prospect  ")).toEqual({
      first: "Dana",
      last: "Prospect",
    });
  });
});

describe("normalizeAcatTransferId (D2 — one rule, one place)", () => {
  it("passes a real tracker UUID through, trimmed", () => {
    expect(normalizeAcatTransferId("ACAT-1")).toBe("ACAT-1");
    expect(normalizeAcatTransferId("  ACT-abc123  ")).toBe("ACT-abc123");
  });

  it("canonicalizes UUID casing without changing opaque tracker identifiers", () => {
    expect(normalizeAcatTransferId("  ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456  "))
      .toBe("abcdef12-abcd-4abc-8abc-abcdef123456");
    expect(normalizeAcatTransferId("  ACT-AbCd123  ")).toBe("ACT-AbCd123");
  });

  it("normalizes placeholders and blanks to NULL", () => {
    for (const raw of ["", "   ", "N/A", "n/a", "Manual", "TBD", "none", "-"]) {
      expect(normalizeAcatTransferId(raw)).toBeNull();
    }
    expect(normalizeAcatTransferId(null)).toBeNull();
    expect(normalizeAcatTransferId(undefined)).toBeNull();
  });
});

describe("buildLinkTransferInput", () => {
  it("always pins source APP / stage IN_TRANSFER / owner OPERATIONS + sets BOTH link ids and value", () => {
    const input = buildLinkTransferInput(clientTarget, key("rec-1", "ACAT-1"), 250000);
    expect(input.source).toBe("APP");
    expect(input.stage).toBe("IN_TRANSFER");
    expect(input.owner_kind).toBe("OPERATIONS");
    expect(input.acat_record_id).toBe("rec-1");
    expect(input.acat_transfer_id).toBe("ACAT-1"); // real UUID passes through
    expect(input.value).toBe(250000);
  });

  it("normalizes a placeholder UUID to NULL while keeping the record id (D2)", () => {
    for (const raw of ["N/A", "", "Manual", "   "]) {
      const input = buildLinkTransferInput(clientTarget, key("rec-1", raw), 100);
      expect(input.acat_record_id).toBe("rec-1");
      expect(input.acat_transfer_id).toBeNull();
    }
    const nullRaw = buildLinkTransferInput(clientTarget, key("rec-1", null), 100);
    expect(nullRaw.acat_record_id).toBe("rec-1");
    expect(nullRaw.acat_transfer_id).toBeNull();
  });

  it("client target carries the client + household ids", () => {
    const input = buildLinkTransferInput(clientTarget, key("rec-1", "ACAT-1"), 100);
    expect(input.client_sf_id).toBe("003CLIENT");
    expect(input.household_sf_id).toBe("001HH");
    expect(input.client_first_name).toBe("Ada");
    expect(input.client_last_name).toBe("Client");
  });

  it("household target carries the household id, null client id", () => {
    const input = buildLinkTransferInput(householdTarget, key("rec-1", "ACAT-1"), 100);
    expect(input.client_sf_id).toBeNull();
    expect(input.household_sf_id).toBe("001HH");
    expect(input.household_name).toBe("Client Household");
  });

  it("prospect target has NULL client + household ids (the unmatched marker) and the split name", () => {
    const input = buildLinkTransferInput(prospectTarget, key("rec-1", "ACAT-1"), 100);
    expect(input.client_sf_id).toBeNull();
    expect(input.household_sf_id).toBeNull();
    expect(input.client_first_name).toBe("Dana");
    expect(input.client_last_name).toBe("Prospect");
  });
});

describe("isUnmatchedProspect", () => {
  it("true iff both client and household sf ids are null", () => {
    expect(
      isUnmatchedProspect(buildLinkTransferInput(prospectTarget, key("r", "A"), 1)),
    ).toBe(true);
    expect(
      isUnmatchedProspect(buildLinkTransferInput(clientTarget, key("r", "A"), 1)),
    ).toBe(false);
    expect(
      isUnmatchedProspect(buildLinkTransferInput(householdTarget, key("r", "A"), 1)),
    ).toBe(false);
  });
});

describe("attachableTransfers", () => {
  const rows = [
    { id: "t1", stage: "IN_TRANSFER", acat_transfer_id: null, acat_record_id: null, client_sf_id: "003CLIENT", household_sf_id: "001HH" },
    { id: "t2", stage: "FUNDED", acat_transfer_id: null, acat_record_id: null, client_sf_id: "003CLIENT", household_sf_id: "001HH" }, // FUNDED — dropped
    { id: "t3", stage: "DECISION", acat_transfer_id: "ACAT-9", acat_record_id: null, client_sf_id: "003CLIENT", household_sf_id: "001HH" }, // already linked (UUID) — dropped
    { id: "t4", stage: "DECISION", acat_transfer_id: null, acat_record_id: null, client_sf_id: "003OTHER", household_sf_id: "001OTHER" }, // other client — dropped
    { id: "t5", stage: "DECISION", acat_transfer_id: null, acat_record_id: "rec-9", client_sf_id: "003CLIENT", household_sf_id: "001HH" }, // already linked (record id) — dropped
  ];

  it("keeps only open, ACAT-less transfers matching the chosen client (record-id links excluded too)", () => {
    expect(attachableTransfers(rows, clientTarget).map((r) => r.id)).toEqual(["t1"]);
  });

  it("matches a household target on household_sf_id", () => {
    expect(attachableTransfers(rows, householdTarget).map((r) => r.id)).toEqual(["t1"]);
  });

  it("a prospect never matches an existing transfer", () => {
    expect(attachableTransfers(rows, prospectTarget)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SEAM (fake tx)
// ---------------------------------------------------------------------------

function fakeTx(opts?: {
  /** Row returned by the PRIMARY duplicate lookup (where.acat_record_id). */
  dupeByRecordId?: { id: string } | null;
  /** Row returned by the SECONDARY/legacy lookup (where.acat_transfer_id). */
  dupeByUuid?: { id: string } | null;
  current?: {
    id: string;
    acat_transfer_id: string | null;
    acat_record_id: string | null;
  } | null;
}) {
  // Dispatch on the where clause so the record-id (primary) and UUID
  // (secondary) duplicate lookups are separately controllable + observable.
  const findFirst = vi.fn(
    async (args: { where: Record<string, unknown> }) => {
      if ("acat_record_id" in args.where) return opts?.dupeByRecordId ?? null;
      if ("acat_transfer_id" in args.where) return opts?.dupeByUuid ?? null;
      return null;
    },
  );
  const findUnique = vi.fn(async (_args: unknown) => opts?.current ? { acat_link_version: 0, ...opts.current } : null);
  const create = vi.fn(async (_args: unknown) => ({ id: "new_transfer_1" }));
  const update = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const auditCreate = vi.fn(async (_args: unknown) => ({ id: "audit_1" }));
  const tx = {
    transfer: { findFirst, findUnique, create, updateMany: update },
    auditLog: { create: auditCreate },
  } as unknown as Prisma.TransactionClient;
  return { tx, findFirst, findUnique, create, update, auditCreate };
}

const NO_ACAT_CURRENT = {
  id: "t_existing",
  acat_link_version: 0,
  archived_at: null,
  acat_transfer_id: null,
  acat_record_id: null,
};

describe("createLinkedTransfer", () => {
  it("happy path: creates IN_TRANSFER with BOTH link ids + seeded tasks, audits transfer.create with both ids", async () => {
    const { tx, create, auditCreate } = fakeTx();
    const res = await createLinkedTransfer(
      tx,
      OPS,
      buildLinkTransferInput(clientTarget, key("rec-1", "ACAT-1"), 250000),
    );
    expect(res).toEqual({ ok: true, id: "new_transfer_1" });

    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.stage).toBe("IN_TRANSFER");
    expect(data.source).toBe("APP");
    expect(data.acat_record_id).toBe("rec-1");
    expect(data.acat_transfer_id).toBe("ACAT-1");
    expect(data.created_by).toBe("ops@example.com");
    // IN_TRANSFER default checklist is seeded (4 tasks).
    const tasks = (data.tasks as { create: unknown[] }).create;
    expect(tasks).toHaveLength(4);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(audit.action).toBe("transfer.create");
    const detail = JSON.parse(audit.detail as string);
    expect(detail.acat_record_id).toBe("rec-1");
    expect(detail.acat_transfer_id).toBe("ACAT-1");
    expect(detail.prospect).toBe(false);
  });

  it("UUID-less input writes the record id + NULL uuid, and runs NO uuid dupe check", async () => {
    const { tx, findFirst, create, auditCreate } = fakeTx();
    const res = await createLinkedTransfer(
      tx,
      OPS,
      buildLinkTransferInput(clientTarget, key("rec-na", "N/A"), 100),
    );
    expect(res).toEqual({ ok: true, id: "new_transfer_1" });

    // Exactly ONE findFirst — the record-id primary check; no uuid to check.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(
      (findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where,
    ).toEqual({ acat_record_id: "rec-na" });

    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.acat_record_id).toBe("rec-na");
    expect(data.acat_transfer_id).toBeNull();

    const detail = JSON.parse(
      (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data.detail as string,
    );
    expect(detail.acat_record_id).toBe("rec-na");
    expect(detail.acat_transfer_id).toBeNull();
  });

  it("prospect create audits prospect:true and null CRM ids", async () => {
    const { tx, create, auditCreate } = fakeTx();
    await createLinkedTransfer(
      tx,
      OPS,
      buildLinkTransferInput(prospectTarget, key("rec-2", "ACAT-2"), 500),
    );
    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.client_sf_id).toBeNull();
    expect(data.household_sf_id).toBeNull();
    const detail = JSON.parse(
      (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data.detail as string,
    );
    expect(detail.prospect).toBe(true);
  });

  it("duplicate guard: an ACAT already linked BY RECORD ID rejects with NO create/audit", async () => {
    const { tx, create, auditCreate } = fakeTx({ dupeByRecordId: { id: "t_dupe" } });
    const res = await createLinkedTransfer(
      tx,
      OPS,
      buildLinkTransferInput(clientTarget, key("rec-1", "ACAT-1"), 100),
    );
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(create).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("legacy UUID-only duplicate still rejects (record-id check clean) — no write", async () => {
    const { tx, create, auditCreate } = fakeTx({
      dupeByRecordId: null,
      dupeByUuid: { id: "t_legacy" },
    });
    const res = await createLinkedTransfer(
      tx,
      OPS,
      buildLinkTransferInput(clientTarget, key("rec-1", "ACAT-1"), 100),
    );
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(create).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("invalid input (value <= 0): validator error, NO write", async () => {
    const { tx, findFirst, create, auditCreate } = fakeTx();
    const res = await createLinkedTransfer(
      tx,
      OPS,
      buildLinkTransferInput(clientTarget, key("rec-1", "ACAT-1"), 0),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.field === "value")).toBe(true);
    expect(findFirst).not.toHaveBeenCalled(); // validation short-circuits first
    expect(create).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("attachAcatToTransfer", () => {
  it("happy path: sets BOTH link ids + updated_by only, audits transfer.update change-map with both entries", async () => {
    const { tx, update, auditCreate } = fakeTx({ current: NO_ACAT_CURRENT });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-7", "ACAT-7"));
    expect(res).toEqual({ ok: true });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "t_existing", acat_link_version: 0, archived_at: null, acat_record_id: null, acat_transfer_id: null },
    }));

    const data = (update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({
      acat_record_id: "rec-7",
      acat_transfer_id: "ACAT-7",
      updated_by: "ops@example.com",
      acat_auto_link_hold: true, acat_link_provenance: "MANUAL", acat_link_decision_id: null,
    });

    const audit = (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(audit.action).toBe("transfer.update");
    const detail = JSON.parse(audit.detail as string);
    expect(detail.changes.acat_record_id).toEqual({ from: null, to: "rec-7" });
    expect(detail.changes.acat_transfer_id).toEqual({ from: null, to: "ACAT-7" });
  });

  it("N/A uuid → record id set, acat_transfer_id null, change map omits the uuid entry", async () => {
    const { tx, update, auditCreate } = fakeTx({ current: NO_ACAT_CURRENT });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-na", "N/A"));
    expect(res).toEqual({ ok: true });

    const data = (update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({
      acat_record_id: "rec-na",
      acat_transfer_id: null,
      updated_by: "ops@example.com",
      acat_auto_link_hold: true, acat_link_provenance: "MANUAL", acat_link_decision_id: null,
    });

    const detail = JSON.parse(
      (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data.detail as string,
    );
    expect(detail.changes.acat_record_id).toEqual({ from: null, to: "rec-na" });
    expect("acat_transfer_id" in detail.changes).toBe(false); // no null→null noise
  });

  it("rejects a transfer that already has an ACAT by legacy UUID — no write", async () => {
    const { tx, update, auditCreate } = fakeTx({
      current: { id: "t_existing", acat_transfer_id: "ACAT-EXISTING", acat_record_id: null },
    });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-7", "ACAT-7"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_ALREADY_HAS_ACAT] });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a transfer that already has an ACAT by record id — no write", async () => {
    const { tx, update, auditCreate } = fakeTx({
      current: { id: "t_existing", acat_transfer_id: null, acat_record_id: "rec-existing" },
    });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-7", "ACAT-7"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_ALREADY_HAS_ACAT] });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects when the ACAT is already linked elsewhere by record id (primary) — no write", async () => {
    const { tx, update, auditCreate } = fakeTx({
      current: NO_ACAT_CURRENT,
      dupeByRecordId: { id: "t_other" },
    });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-7", "ACAT-7"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects when the ACAT is already linked elsewhere by legacy UUID (secondary) — no write", async () => {
    const { tx, update, auditCreate } = fakeTx({
      current: NO_ACAT_CURRENT,
      dupeByRecordId: null,
      dupeByUuid: { id: "t_other" },
    });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-7", "ACAT-7"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("idempotency: re-linking the same record id rejects, no second write", async () => {
    // The tracker record is already linked (its record id is on some transfer)
    // — submitting the same link again must NOT create/update anything.
    const { tx, update, auditCreate } = fakeTx({
      current: NO_ACAT_CURRENT,
      dupeByRecordId: { id: "t_already" },
    });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("rec-same", null));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a missing transfer — no write", async () => {
    const { tx, update, auditCreate } = fakeTx({ current: null });
    const res = await attachAcatToTransfer(tx, OPS, "nope", key("rec-7", "ACAT-7"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    { acat_record_id: "picker-winner", acat_transfer_id: null },
    { acat_record_id: null, acat_transfer_id: "legacy-winner" },
  ])("does not overwrite a concurrent attachment after a stale empty-link read (%j)", async (winner) => {
    const { tx, update, auditCreate } = fakeTx({ current: NO_ACAT_CURRENT });
    // The initial read predates the winner's commit. Model UPDATE's predicate
    // against the committed row, as PostgreSQL does after any row-lock wait.
    const persisted: Record<string, unknown> = { ...NO_ACAT_CURRENT, ...winner };
    update.mockImplementationOnce(async (args: unknown) => {
      const { where, data } = args as {
        where: Record<string, unknown>; data: Record<string, unknown>;
      };
      if (!Object.entries(where).every(([field, value]) => persisted[field] === value)) {
        return { count: 0 };
      }
      Object.assign(persisted, data);
      return { count: 1 };
    });

    expect(await attachAcatToTransfer(tx, OPS, "t_existing", key("stale-loser", "ACAT-loser")))
      .toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_ALREADY_HAS_ACAT] });
    expect(persisted).toEqual({ ...NO_ACAT_CURRENT, ...winner });
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("legacy UUID casing at the shared link seams", () => {
  const uuid = "abcdef12-abcd-4abc-8abc-abcdef123456";

  it.each(["create", "attach"] as const)("%s rejects an already stored uppercase UUID-only link", async (operation) => {
    const { tx, findFirst, create, update, auditCreate } = fakeTx({ current: NO_ACAT_CURRENT });
    const legacyUuid = uuid.toUpperCase();
    findFirst.mockImplementation(async ({ where }) => {
      const filter = where.acat_transfer_id;
      if (typeof filter === "string") return filter === legacyUuid ? { id: "legacy-transfer" } : null;
      if (filter && typeof filter === "object") {
        const { equals, mode } = filter as { equals: string; mode?: string };
        const matches = mode === "insensitive"
          ? equals.toLowerCase() === legacyUuid.toLowerCase()
          : equals === legacyUuid;
        return matches ? { id: "legacy-transfer" } : null;
      }
      return null;
    });

    const result = operation === "create"
      ? await createLinkedTransfer(tx, OPS, buildLinkTransferInput(clientTarget, key("new-record", uuid), 100))
      : await attachAcatToTransfer(tx, OPS, "t_existing", key("new-record", uuid));
    expect(result).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each(["create", "attach"] as const)("%s persists and audits canonical UUIDs", async (operation) => {
    const { tx, create, update, auditCreate } = fakeTx({ current: NO_ACAT_CURRENT });
    const upperKey = key("new-record", uuid.toUpperCase());
    const result = operation === "create"
      ? await createLinkedTransfer(tx, OPS, buildLinkTransferInput(clientTarget, upperKey, 100))
      : await attachAcatToTransfer(tx, OPS, "t_existing", upperKey);
    expect(result.ok).toBe(true);
    const write = operation === "create" ? create : update;
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ acat_transfer_id: uuid }),
    }));
    const audit = auditCreate.mock.calls[0][0] as { data: { detail: string } };
    expect(audit.data.detail).toContain(uuid);
    expect(audit.data.detail).not.toContain(uuid.toUpperCase());
  });
});

describe("blank acat_record_id guard (the required primary key)", () => {
  it("createLinkedTransfer rejects a blank record id before any read/write", async () => {
    const { tx, findFirst, create, auditCreate } = fakeTx();
    const input = {
      ...buildLinkTransferInput(clientTarget, key("x", "ACAT-1"), 100),
      acat_record_id: "  ",
    };
    const res = await createLinkedTransfer(tx, OPS, input);
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] });
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("attachAcatToTransfer rejects a blank record id before any read/write", async () => {
    const { tx, findUnique, update, auditCreate } = fakeTx({
      current: NO_ACAT_CURRENT,
    });
    const res = await attachAcatToTransfer(tx, OPS, "t_existing", key("", "ACAT-7"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] });
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("unlinkAcatFromTransfer", () => {
  const linked = {
    id: "t_existing",
    acat_link_version: 0,
    acat_record_id: "rec-7" as string | null,
    acat_transfer_id: "ACAT-7" as string | null,
    archived_at: null as Date | null,
    stage: "DECISION", value: 100, owner_kind: "OPERATIONS",
    funding_type: "ACAT_FULL", funding_plan_version: 2,
    asset_map_folder_id: "synthetic-map", next_step: "Review paperwork",
    updated_by: "original@example.test" as string | null,
  };

  function unlinkTx(
    initial: typeof linked | null = linked,
    beforeUpdate?: (row: typeof linked) => void,
  ) {
    const row = initial ? { ...initial } : null;
    const findUnique = vi.fn(async (_args: unknown) => row ? { ...row } : null);
    const updateMany = vi.fn(async ({ where, data }: {
      where: Record<string, unknown>; data: Partial<typeof linked>;
    }) => {
      if (!row) return { count: 0 };
      beforeUpdate?.(row);
      if (Object.entries(where).some(([field, value]) => row[field as keyof typeof row] !== value)) {
        return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    });
    const auditCreate = vi.fn(async (_args: unknown) => ({ id: "audit-unlink" }));
    const tx = { transfer: { findUnique, updateMany }, auditLog: { create: auditCreate } } as unknown as Prisma.TransactionClient;
    return { tx, row, findUnique, updateMany, auditCreate };
  }

  it("clears both IDs on only the intended transfer, preserves other fields and audits the actual change", async () => {
    const { tx, row, updateMany, auditCreate } = unlinkTx();
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7"))).toEqual({ ok: true });
    expect(row).toEqual({ ...linked, acat_record_id: null, acat_transfer_id: null, updated_by: OPS.email,
      acat_auto_link_hold: true, acat_link_provenance: "MANUAL", acat_link_decision_id: null });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: linked.id, acat_link_version: 0, archived_at: null, acat_record_id: "rec-7", acat_transfer_id: "ACAT-7" },
      data: { acat_record_id: null, acat_transfer_id: null, updated_by: OPS.email,
        acat_auto_link_hold: true, acat_link_provenance: "MANUAL", acat_link_decision_id: null },
    });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(audit).toMatchObject({ action: "transfer.update", entityType: "transfer", entityId: linked.id });
    expect(JSON.parse(audit.detail as string)).toMatchObject({ changes: {
      acat_record_id: { from: "rec-7", to: null },
      acat_transfer_id: { from: "ACAT-7", to: null },
    } });
  });

  it.each([null, "N/A", "different-uuid"])("uses a matching record ID regardless of drawer UUID %s", async (uuid) => {
    const { tx, row } = unlinkTx();
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", uuid))).toEqual({ ok: true });
    expect(row?.acat_record_id).toBeNull();
    expect(row?.acat_transfer_id).toBeNull();
  });

  it("rejects a different record ID even when the UUID matches", async () => {
    const { tx, row, updateMany, auditCreate } = unlinkTx();
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-stale", "ACAT-7")))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(row).toEqual(linked);
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    { acat_record_id: null, acat_transfer_id: "ACAT-7", changed: "acat_transfer_id" },
    { acat_record_id: "rec-7", acat_transfer_id: null, changed: "acat_record_id" },
  ])("supports single-column links and audits no null-to-null noise: $changed", async ({ changed, ...ids }) => {
    const { tx, auditCreate } = unlinkTx({ ...linked, ...ids });
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7"))).toEqual({ ok: true });
    const audit = (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(JSON.parse(audit.detail as string)).toMatchObject({ changes: {
      [changed]: { from: ids[changed as keyof typeof ids], to: null },
    } });
  });

  it.each([null, "N/A", "ACAT-other"])("rejects absent/placeholder/stale legacy UUID %s without a record match", async (uuid) => {
    const { tx, updateMany, auditCreate } = unlinkTx({ ...linked, acat_record_id: null });
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", uuid)))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  const legacyUuid = "abcdef12-abcd-4abc-8abc-abcdef123456";

  it.each([
    legacyUuid.toUpperCase(),
    "AbCdEf12-AbCd-4aBc-8AbC-aBcDeF123456",
  ])("unlinks a legacy UUID with stored casing %s while pinning and auditing its raw value", async (storedUuid) => {
    const { tx, row, updateMany, auditCreate } = unlinkTx({
      ...linked, acat_record_id: null, acat_transfer_id: storedUuid,
    });
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", legacyUuid)))
      .toEqual({ ok: true });
    expect(row?.acat_transfer_id).toBeNull();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: linked.id, acat_link_version: 0, archived_at: null, acat_record_id: null, acat_transfer_id: storedUuid },
      data: { acat_record_id: null, acat_transfer_id: null, updated_by: OPS.email,
        acat_auto_link_hold: true, acat_link_provenance: "MANUAL", acat_link_decision_id: null },
    });
    const audit = (auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(JSON.parse(audit.detail as string)).toMatchObject({ changes: {
      acat_transfer_id: { from: storedUuid, to: null },
    } });
  });

  it.each([
    { recordId: null, storedUuid: legacyUuid.toUpperCase(), expectedUuid: "abcdef12-abcd-4abc-8abc-abcdef123457" },
    { recordId: "rec-current", storedUuid: legacyUuid.toUpperCase(), expectedUuid: legacyUuid },
    { recordId: null, storedUuid: "ACAT-7", expectedUuid: "acat-7" },
  ])("keeps stale UUID, authoritative record ID and opaque-ID casing protections: %j", async ({ recordId, storedUuid, expectedUuid }) => {
    const saved = { ...linked, acat_record_id: recordId, acat_transfer_id: storedUuid };
    const { tx, row, updateMany, auditCreate } = unlinkTx(saved);
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", expectedUuid)))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(row).toEqual(saved);
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects even a casing-only concurrent legacy UUID change after the read", async () => {
    const saved = { ...linked, acat_record_id: null, acat_transfer_id: legacyUuid.toUpperCase() };
    const { tx, row, updateMany, auditCreate } = unlinkTx(saved, (current) => {
      current.acat_transfer_id = legacyUuid;
    });
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", legacyUuid)))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(row).toEqual({ ...saved, acat_transfer_id: legacyUuid });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing or invisible", current: null, error: LINK_ERRORS.TRANSFER_NOT_FOUND },
    { name: "archived", current: { ...linked, archived_at: new Date("2026-09-24") }, error: LINK_ERRORS.TRANSFER_ARCHIVED },
  ])("rejects $name transfers without writes or audits", async ({ current, error }) => {
    const { tx, updateMany, auditCreate } = unlinkTx(current);
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7")))
      .toEqual({ ok: false, errors: [error] });
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("treats a repeated unlink as success without a second write or audit", async () => {
    const { tx, row, updateMany, auditCreate } = unlinkTx();
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7")))
      .toEqual({ ok: true });
    const saved = { ...row };
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7")))
      .toEqual({ ok: true });
    expect(row).toEqual(saved);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects an archived already-cleared transfer instead of treating it as a retry", async () => {
    const { tx, updateMany, auditCreate } = unlinkTx({
      ...linked, acat_record_id: null, acat_transfer_id: null,
      archived_at: new Date("2026-09-24"),
    });
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7")))
      .toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_ARCHIVED] });
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "relink by record", change: { acat_record_id: "rec-new" } },
    { name: "relink by UUID", change: { acat_transfer_id: "ACAT-new" } },
    { name: "unlink", change: { acat_record_id: null, acat_transfer_id: null } },
    { name: "archive", change: { archived_at: new Date("2026-09-24") } },
  ])("rejects a concurrent $name between read and write without auditing or clearing the new state", async ({ change }) => {
    const { tx, row, updateMany, auditCreate } = unlinkTx(linked, (current) => Object.assign(current, change));
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7")))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(row).toEqual({ ...linked, ...change });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects missing identifiers before any database read", async () => {
    const { tx, findUnique, updateMany, auditCreate } = unlinkTx();
    expect(await unlinkAcatFromTransfer(tx, OPS, " ", key("rec-7", "ACAT-7")))
      .toEqual({ ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] });
    expect(await unlinkAcatFromTransfer(tx, OPS, linked.id, key(" ", "ACAT-7")))
      .toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] });
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("propagates audit failure so the caller's transaction cannot commit an unaudited unlink", async () => {
    const { tx, auditCreate } = unlinkTx();
    auditCreate.mockRejectedValueOnce(new Error("synthetic audit failure"));
    await expect(unlinkAcatFromTransfer(tx, OPS, linked.id, key("rec-7", "ACAT-7")))
      .rejects.toThrow("synthetic audit failure");
  });
});

// ---------------------------------------------------------------------------
// GATE (server actions — mocked auth + rls; the REAL canSeeUnlinkedAcats runs)
// ---------------------------------------------------------------------------

const { authSpy, scopeSpy, signalSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  scopeSpy: vi.fn(),
  signalSpy: vi.fn(() => true),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: signalSpy,
}));

import {
  attachAcatToExistingTransfer,
  linkAcatToNewTransfer,
  loadLinkTargets,
} from "@/app/(authenticated)/acat-tracking/actions";

const sessionFor = (role: string | undefined) => ({
  user: { email: "u@example.com", ...(role !== undefined ? { role } : {}) },
});

beforeEach(() => {
  authSpy.mockReset();
  scopeSpy.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("acat-tracking actions — gate", () => {
  it("forbids VIEWER / ADVISOR / CLIENT_SERVICE and the role-default path; opens NO scope", async () => {
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE", undefined]) {
      authSpy.mockResolvedValue(sessionFor(role));

      const link = await linkAcatToNewTransfer(prospectTarget, key("rec-1", "ACAT-1"), 100);
      expect(link).toEqual({ ok: false, errors: expect.any(Array) });

      const attach = await attachAcatToExistingTransfer("t1", key("rec-1", "ACAT-1"));
      expect(attach).toEqual({ ok: false, errors: expect.any(Array) });

      const targets = await loadLinkTargets();
      expect(targets).toEqual({ ok: false, reason: "forbidden" });
    }
    // No permitted role ever reached → withUserScope must never be called.
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("PASSES an ADMIN/OPERATIONS session through requireLinkRole into withUserScope + the seam create", async () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      authSpy.mockResolvedValue(sessionFor(role));
      const create = vi.fn(async (_a: unknown) => ({ id: "t_new" }));
      const findFirst = vi.fn(async (_a: unknown) => null);
      const auditCreate = vi.fn(async (_a: unknown) => ({ id: "a" }));
      // scopeSpy stands in for withUserScope: it must actually RUN the callback
      // (proving the action reaches the seam writer under a real role), handing
      // it a fake tx.
      scopeSpy.mockImplementation(
        async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            transfer: { findFirst, create, findUnique: vi.fn(), updateMany: vi.fn() },
            auditLog: { create: auditCreate },
          }),
      );

      const res = await linkAcatToNewTransfer(clientTarget, key("rec-new", "ACAT-NEW"), 1000);

      expect(scopeSpy).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1); // reached the seam create
      expect(auditCreate).toHaveBeenCalledTimes(1); // audited in the same tx
      expect(signalSpy).toHaveBeenCalledWith("acat_link");
      expect(res).toBeUndefined(); // success → redirect (mocked) → no error result
      scopeSpy.mockReset();
      signalSpy.mockClear();
    }
  });

  it("maps a P2002 unique-violation (lost duplicate-link race) to the friendly 'already linked' result — not the generic permission error", async () => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    scopeSpy.mockImplementation(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    });
    const res = await linkAcatToNewTransfer(clientTarget, key("rec-dup", "ACAT-DUP"), 1000);
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(signalSpy).not.toHaveBeenCalled();

    const attach = await attachAcatToExistingTransfer("t1", key("rec-dup", "ACAT-DUP"));
    expect(attach).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
  });

  it("BOTH link actions revalidate the tracking page AND the transfer board (chip freshness)", async () => {
    const { revalidatePath } = await import("next/cache");
    const revalidateSpy = vi.mocked(revalidatePath);
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    scopeSpy.mockImplementation(
      async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          transfer: {
            findFirst: vi.fn(async () => null),
            findUnique: vi.fn(async () => ({
              id: "t1",
              acat_link_version: 0,
              acat_transfer_id: null,
              acat_record_id: null,
            })),
            create: vi.fn(async () => ({ id: "t_new" })),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          auditLog: { create: vi.fn(async () => ({ id: "a" })) },
        }),
    );

    await linkAcatToNewTransfer(clientTarget, key("rec-a", "ACAT-A"), 1000);
    expect(revalidateSpy).toHaveBeenCalledWith("/acat-tracking");
    // The board keys ACAT chips by the just-stored link ids — without this a
    // cached /asset-transfer keeps rendering the pre-link board.
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer");

    revalidateSpy.mockClear();
    await attachAcatToExistingTransfer("t1", key("rec-b", "ACAT-B"));
    expect(revalidateSpy).toHaveBeenCalledWith("/acat-tracking");
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer");
  });
});
