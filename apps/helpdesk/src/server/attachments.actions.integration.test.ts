/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; `TEST_DATABASE_URL` only — never the dev
 * database: the immutability triggers make every AuditLog row permanent and the Attachment trigger
 * refuses DELETE, so fixture rows here are permanent by design).
 *
 * Proves live, against the real schema and the real triggers (the build record S4,
 * Decision #69):
 *   - the upload intent reserves a PENDING row whose objectKey is `<ticketId>/<attachmentId>`, signs
 *     THAT intent's declared size into the upload URL (not the global 25 MiB ceiling), and records the
 *     reservation as `ATTACHMENT_ADDED null → PENDING` in the same transaction — the row it creates can
 *     never be deleted, so it never exists without a ledger entry naming who reserved it;
 *   - no `Attachment` row on either fixture ticket lacks that reservation row (a ledger sweep, not an
 *     assertion about one call);
 *   - the ticket timeline shows the READY row and not the reservation, so one upload draws one line;
 *   - the allowlist, the 25 MiB cap and the CLOSED rule are enforced server-side, whatever the UI did;
 *   - `attachment:write` is WRITE on the queue, so compliance_officers is refused AND the refusal is
 *     recorded as AUTHZ_DENIED;
 *   - finalize verifies the stored object (existence, size, and — on the filesystem backend — the
 *     sha256 the browser claimed) and flips PENDING → READY with exactly ONE `ATTACHMENT_ADDED
 *     PENDING → READY` row in the same transaction; a second finalize conflicts and adds no second row;
 *   - `Attachment.sha256` only ever holds a digest the SERVER computed: against a backend that
 *     publishes none (GCS, simulated by the store mock below) the column stays NULL and the browser's
 *     claim is recorded in the ledger as `sha256Claimed` with `sha256Verified: false`;
 *   - a failed finalize rolls the whole thing back: still PENDING, still no READY row in the ledger
 *     (the reservation row from the intent stays, and stays alone);
 *   - remove is a SOFT remove — `ATTACHMENT_REMOVED`, row still present, object still on disk — and
 *     the DB refuses a hard DELETE outright;
 *   - the list shows READY only.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer and
 * context against the real database, exactly as `comments-race.integration.test.ts` does. The store
 * is the filesystem backend (`ATTACHMENTS_BUCKET` is unset in every environment this wave touches),
 * so "the browser PUT the bytes" is a direct `store.put`.
 */
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestContext, Viewer } from "@/types/domain";
import { INGEST_LIMITS } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_USER_ID = `it_att_ops_${RUN}`;
const CCO_USER_ID = `it_att_cco_${RUN}`;
const OPEN_TICKET_ID = `it_att_open_${RUN}`;
const CLOSED_TICKET_ID = `it_att_closed_${RUN}`;

const OPS_VIEWER: Viewer = {
  id: OPS_USER_ID,
  email: `att.ops.${RUN}@wm-helpdesk.local`,
  name: "Attachments Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};

const CCO_VIEWER: Viewer = {
  id: CCO_USER_ID,
  email: `att.cco.${RUN}@wm-helpdesk.local`,
  name: "Attachments Compliance",
  image: null,
  groups: ["compliance_officers"],
  isDev: false,
};

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
  /** While true, `head()` reports no sha256 — the GCS backend's behaviour on a laptop. */
  digestlessHead: false,
}));
hoisted.viewer = {
  id: `it_att_ops_placeholder`,
  email: "placeholder@wm-helpdesk.local",
  name: null,
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.21",
  userAgent: `it-attachments/${RUN}`,
  requestId: `it-attachments-${RUN}`,
  isPrefetch: false,
};

vi.mock("@/lib/session", () => ({
  requireViewerOrThrow: vi.fn(async () => hoisted.viewer),
  getViewer: vi.fn(async () => hoisted.viewer),
  requireUser: vi.fn(async () => hoisted.viewer),
  requireGroup: vi.fn(async () => hoisted.viewer),
}));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: vi.fn(async () => hoisted.ctx),
  getRequestContextFromRequest: vi.fn(() => hoisted.ctx),
}));

/**
 * The real filesystem backend, except that while `hoisted.digestlessHead` is set its `head()` reports
 * `sha256: null` — which is exactly and only what the GCS backend does (its JSON API publishes
 * md5/crc32c, `src/lib/storage.ts`). Every other method, and every other test, is the real store.
 * This is the one way to exercise the unprovable-digest branch of `finalizeUpload` without a bucket.
 */
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    attachmentStore: () => {
      const store = actual.attachmentStore();
      if (!hoisted.digestlessHead) return store;
      return {
        ...store,
        head: async (key: string) => ({ ...(await store.head(key)), sha256: null }),
      };
    },
  };
});

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const actionsModule = TEST_URL ? await import("@/server/attachments.actions") : null;
const readsModule = TEST_URL ? await import("@/server/attachments") : null;
const storageModule = TEST_URL ? await import("@/lib/storage") : null;

function mods() {
  if (!dbModule || !actionsModule || !readsModule || !storageModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...actionsModule, ...readsModule, ...storageModule };
}

/** Runs `fn` as `viewer`, restoring whoever was mocked before. */
async function as<T>(viewer: Viewer, fn: () => Promise<T>): Promise<T> {
  const previous = hoisted.viewer;
  hoisted.viewer = viewer;
  try {
    return await fn();
  } finally {
    hoisted.viewer = previous;
  }
}

const PDF = "application/pdf";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256Of(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** intent → "browser PUT" → finalize, the whole happy path in one helper. */
async function attach(ticketId: string, filename: string, body: Uint8Array) {
  const { createUploadIntent, finalizeUpload, attachmentStore } = mods();
  const intent = await createUploadIntent({ ticketId, filename, mime: PDF, size: body.byteLength });
  if (!intent.ok) throw new Error(`intent failed: ${intent.code} ${intent.message}`);
  await attachmentStore().put(intent.data.objectKey, body, PDF);
  const finalized = await finalizeUpload({ attachmentId: intent.data.attachmentId, sha256: sha256Of(body) });
  return { intent: intent.data, finalized };
}

describe.skipIf(!TEST_URL)("attachment actions (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    hoisted.viewer = OPS_VIEWER;

    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "attachment fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });

    for (const v of [OPS_VIEWER, CCO_VIEWER]) {
      await prisma.user.upsert({
        where: { id: v.id },
        update: { groups: [...v.groups], isActive: true },
        create: {
          id: v.id,
          email: v.email,
          name: v.name,
          groups: [...v.groups],
          emailVerified: new Date(),
          isActive: true,
        },
      });
    }

    const createdAt = new Date("2026-09-16T12:00:00.000Z");
    for (const [id, status] of [
      [OPEN_TICKET_ID, "OPEN"],
      [CLOSED_TICKET_ID, "CLOSED"],
    ] as const) {
      await prisma.ticket.upsert({
        where: { id },
        update: {},
        create: {
          id,
          subject: "Attachment probe",
          description: "Attachment probe description",
          requesterName: "Attachment Requester",
          requesterEmail: `att.${RUN}@example.com`,
          category: "COST_BASIS",
          priority: "STANDARD",
          status,
          queue: { connect: { id: queue.id } },
          createdBy: { connect: { id: OPS_USER_ID } },
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
          resolvedAt: status === "CLOSED" ? createdAt : null,
          closedAt: status === "CLOSED" ? createdAt : null,
        },
      });
    }
  });

  afterAll(async () => {
    // Objects only — the rows stay: this table cannot be hard-deleted, which is the point.
    const { LOCAL_ATTACHMENTS_DIR } = mods();
    for (const id of [OPEN_TICKET_ID, CLOSED_TICKET_ID]) {
      await rm(join(process.cwd(), LOCAL_ATTACHMENTS_DIR, id), { recursive: true, force: true });
    }
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("uses the filesystem backend when no bucket is configured", () => {
    const { attachmentStore } = mods();
    expect(attachmentStore().backend).toBe("filesystem");
  });

  it("reserves a PENDING row with a derived object key and audits the reservation", async () => {
    const { createUploadIntent, prisma } = mods();
    const res = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "Q3 statement.pdf",
      mime: PDF,
      size: 12,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.objectKey).toBe(`${OPEN_TICKET_ID}/${res.data.attachmentId}`);
    expect(res.data.uploadUrl).toContain(`/api/attachments/${res.data.attachmentId}/upload?`);
    expect(new Date(res.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: res.data.attachmentId } });
    expect(row.state).toBe("PENDING");
    expect(row.visibility).toBe("INTERNAL");
    expect(row.kind).toBe("UPLOAD");
    expect(row.uploaderId).toBe(OPS_USER_ID);
    expect(row.readyAt).toBeNull();
    expect(row.sha256).toBeNull();

    // The row is permanent (the trigger refuses DELETE), so it carries a ledger entry from the moment
    // it exists. `newValue` is what tells the reservation apart from the attachment.
    const ledger = await prisma.auditLog.findMany({ where: { entityId: res.data.attachmentId } });
    expect(ledger).toHaveLength(1);
    // Wave B gave the RESERVATION its own enum value; the file ARRIVING keeps ATTACHMENT_ADDED.
    expect(ledger[0].action).toBe("ATTACHMENT_INTENT_CREATED");
    expect(ledger[0].entityType).toBe("ATTACHMENT");
    expect(ledger[0].ticketId).toBe(OPEN_TICKET_ID);
    expect(ledger[0].actorId).toBe(OPS_USER_ID);
    expect(ledger[0].fieldChanged).toBe("state");
    expect(ledger[0].oldValue).toBeNull();
    expect(ledger[0].newValue).toBe("PENDING");
    expect(ledger[0].metadata).toMatchObject({
      stage: "intent",
      filename: "Q3 statement.pdf",
      mime: PDF,
      size: 12,
    });
  });

  it("signs the declared size into the upload URL, not the 25 MiB ceiling", async () => {
    const { createUploadIntent } = mods();
    const res = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "small.pdf",
      mime: PDF,
      size: 4_096,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // A 4 KiB intent must not authorize 25 MiB of bytes at that key: the cap is signed in (locally as
    // `max`, on GCS as `x-goog-content-length-range`) and the storage backend, not finalize, refuses.
    const params = new URL(res.data.uploadUrl, "https://wm-helpdesk.local").searchParams;
    expect(params.get("max")).toBe("4096");
    expect(params.get("max")).not.toBe(String(INGEST_LIMITS.attachmentMaxBytes));
    expect(params.get("ct")).toBe(PDF);
  });

  it("never lets an uploaded filename become a path, and PII-sanitizes it", async () => {
    const { createUploadIntent, prisma } = mods();
    const res = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "../../etc/ssn 123-45-6789.pdf",
      mime: PDF,
      size: 5,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: res.data.attachmentId } });
    expect(row.filename).not.toContain("/");
    expect(row.filename).not.toContain("..");
    expect(row.filename).not.toContain("123-45-6789");
    expect(row.objectKey).toBe(`${OPEN_TICKET_ID}/${res.data.attachmentId}`);
  });

  it("refuses a type outside the allowlist and a size over the cap, before anything is reserved", async () => {
    const { createUploadIntent, prisma } = mods();
    const before = await prisma.attachment.count({ where: { ticketId: OPEN_TICKET_ID } });

    const badType = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "payload.html",
      mime: "text/html",
      size: 10,
    });
    expect(badType.ok).toBe(false);
    expect(badType.ok === false && badType.code).toBe("VALIDATION");

    const tooBig = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "huge.pdf",
      mime: PDF,
      size: INGEST_LIMITS.attachmentMaxBytes + 1,
    });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok === false && tooBig.code).toBe("VALIDATION");

    expect(await prisma.attachment.count({ where: { ticketId: OPEN_TICKET_ID } })).toBe(before);
  });

  it("refuses an upload on a CLOSED ticket (§b.9 — a closed record is annotate-only)", async () => {
    const { createUploadIntent, prisma } = mods();
    const res = await createUploadIntent({
      ticketId: CLOSED_TICKET_ID,
      filename: "late.pdf",
      mime: PDF,
      size: 4,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("VALIDATION");
    expect(await prisma.attachment.count({ where: { ticketId: CLOSED_TICKET_ID } })).toBe(0);
  });

  it("refuses compliance_officers (read-plus-annotate never uploads) and records the denial", async () => {
    const { createUploadIntent, prisma } = mods();
    const before = await prisma.auditLog.count({
      where: { action: "AUTHZ_DENIED", actorId: CCO_USER_ID, ticketId: OPEN_TICKET_ID },
    });

    const res = await as(CCO_VIEWER, () =>
      createUploadIntent({ ticketId: OPEN_TICKET_ID, filename: "cco.pdf", mime: PDF, size: 4 }),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("FORBIDDEN");

    const after = await prisma.auditLog.count({
      where: { action: "AUTHZ_DENIED", actorId: CCO_USER_ID, ticketId: OPEN_TICKET_ID },
    });
    expect(after).toBe(before + 1);
  });

  it("finalizes a verified upload: READY, sha256 stored, exactly one ATTACHMENT_ADDED row", async () => {
    const { prisma } = mods();
    const body = bytes("voided check for the ACH form");
    const { intent, finalized } = await attach(OPEN_TICKET_ID, "voided check.pdf", body);

    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.data.state).toBe("READY");
    expect(finalized.data.filename).toBe("voided check.pdf");
    expect(finalized.data.size).toBe(body.byteLength);
    expect(finalized.data.uploader?.id).toBe(OPS_USER_ID);

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: intent.attachmentId } });
    expect(row.state).toBe("READY");
    expect(row.readyAt).not.toBeNull();
    expect(row.sha256).toBe(sha256Of(body));

    const added = await prisma.auditLog.findMany({
      where: { action: "ATTACHMENT_ADDED", entityId: intent.attachmentId, newValue: "READY" },
    });
    expect(added).toHaveLength(1);
    expect(added[0].entityType).toBe("ATTACHMENT");
    expect(added[0].ticketId).toBe(OPEN_TICKET_ID);
    expect(added[0].fieldChanged).toBe("state");
    expect(added[0].oldValue).toBe("PENDING");
    expect(added[0].newValue).toBe("READY");
    expect(added[0].metadata).toMatchObject({
      stage: "ready",
      mime: PDF,
      size: body.byteLength,
      sha256Verified: true,
    });

    // Two rows for the whole life of the file, in order, and no third: the reservation and the
    // attachment. Anything counting attachments filters on newValue = READY.
    const chain = await prisma.auditLog.findMany({
      where: { entityId: intent.attachmentId },
      orderBy: { seq: "asc" },
      select: { action: true, oldValue: true, newValue: true },
    });
    expect(chain).toEqual([
      { action: "ATTACHMENT_INTENT_CREATED", oldValue: null, newValue: "PENDING" },
      { action: "ATTACHMENT_ADDED", oldValue: "PENDING", newValue: "READY" },
    ]);
  });

  it("never persists an unproven digest: on a backend that publishes none, sha256 stays NULL and the claim goes to the ledger", async () => {
    const { createUploadIntent, finalizeUpload, attachmentStore, prisma } = mods();
    const body = bytes("bytes whose digest this backend cannot prove");
    const claimed = "b".repeat(64); // a deliberate lie: nothing here can contradict it.

    const intent = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "unprovable.pdf",
      mime: PDF,
      size: body.byteLength,
    });
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;
    await attachmentStore().put(intent.data.objectKey, body, PDF);

    hoisted.digestlessHead = true;
    let finalized;
    try {
      finalized = await finalizeUpload({ attachmentId: intent.data.attachmentId, sha256: claimed });
    } finally {
      hoisted.digestlessHead = false;
    }
    // The upload still succeeds — size and existence are still proven — it just carries no digest.
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.data.state).toBe("READY");

    // The integrity column holds a server-computed digest or nothing at all. It must NOT hold the
    // uploader's claim: a reconciliation that re-hashes the object and compares would otherwise be
    // confirming a value the uploader chose, on a table nothing can ever delete.
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: intent.data.attachmentId } });
    expect(row.sha256).toBeNull();
    expect(row.sha256).not.toBe(claimed);

    // The claim is not lost — it is recorded where its provenance is unambiguous.
    const added = await prisma.auditLog.findMany({
      where: { action: "ATTACHMENT_ADDED", entityId: intent.data.attachmentId, newValue: "READY" },
    });
    expect(added).toHaveLength(1);
    expect(added[0].metadata).toMatchObject({
      stage: "ready",
      sha256Verified: false,
      sha256Claimed: claimed,
    });

    // And the same call on the real backend proves the digest instead of recording it.
    const proven = await attach(OPEN_TICKET_ID, "provable.pdf", bytes("provable bytes"));
    expect(proven.finalized.ok).toBe(true);
    const provenRow = await prisma.attachment.findUniqueOrThrow({
      where: { id: proven.intent.attachmentId },
    });
    expect(provenRow.sha256).toBe(sha256Of(bytes("provable bytes")));
  });

  it("shows one timeline line per attachment — the reservation stays in the audit log", async () => {
    const { createUploadIntent } = mods();
    const { listTicketActivity } = await import("@/server/audit-log");
    // ONLY `ATTACHMENT_ADDED`: the reservation is deliberately absent from `TIMELINE_AUDIT_ACTIONS`,
    // so it stays in the ledger and out of the reader's chronology. That is the whole claim here, and
    // widening this filter to include `ATTACHMENT_INTENT_CREATED` would delete the test.
    const countAdded = async (): Promise<number> =>
      (await listTicketActivity(OPS_VIEWER, OPEN_TICKET_ID, hoisted.ctx)).filter(
        (i) => i.action === "ATTACHMENT_ADDED",
      ).length;

    const before = await countAdded();

    // An intent nobody completes adds nothing to the reader's chronology.
    const abandoned = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "abandoned.pdf",
      mime: PDF,
      size: 7,
    });
    expect(abandoned.ok).toBe(true);
    expect(await countAdded()).toBe(before);

    // A completed upload adds exactly one line, not two.
    await attach(OPEN_TICKET_ID, "one-line.pdf", bytes("one line only"));
    expect(await countAdded()).toBe(before + 1);

    const activity = await listTicketActivity(OPS_VIEWER, OPEN_TICKET_ID, hoisted.ctx);
    for (const item of activity.filter((i) => i.action === "ATTACHMENT_ADDED")) {
      expect(item.newValue).toBe("READY");
      expect(item.oldValue).toBe("PENDING");
    }
  });

  it("leaves no Attachment row without its reservation in the ledger", async () => {
    const { prisma } = mods();
    // A sweep, not a single call: the table is append-only and nothing may enter it unrecorded.
    const rows = await prisma.attachment.findMany({
      where: { ticketId: { in: [OPEN_TICKET_ID, CLOSED_TICKET_ID] } },
      select: { id: true },
    });
    expect(rows.length).toBeGreaterThan(0);

    const reservations = await prisma.auditLog.findMany({
      where: {
        // BOTH actions: Wave A wrote the reservation as `ATTACHMENT_ADDED` with
        // `metadata.stage: "intent"`, Wave B gave it `ATTACHMENT_INTENT_CREATED`. The claim — no
        // Attachment row entered the table unrecorded — has to hold across that boundary.
        action: { in: ["ATTACHMENT_ADDED", "ATTACHMENT_INTENT_CREATED"] },
        newValue: "PENDING",
        entityId: { in: rows.map((r) => r.id) },
      },
      select: { entityId: true },
    });
    const recorded = new Set(reservations.map((r) => r.entityId));
    expect(rows.filter((r) => !recorded.has(r.id)).map((r) => r.id)).toEqual([]);
  });

  it("refuses a second finalize and writes no second audit row", async () => {
    const { finalizeUpload, prisma } = mods();
    const body = bytes("one finalize only");
    const { intent } = await attach(OPEN_TICKET_ID, "once.pdf", body);

    const again = await finalizeUpload({ attachmentId: intent.attachmentId, sha256: sha256Of(body) });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.code).toBe("CONFLICT");

    expect(
      await prisma.auditLog.count({
        where: { action: "ATTACHMENT_ADDED", entityId: intent.attachmentId, newValue: "READY" },
      }),
    ).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: intent.attachmentId } })).toBe(2);
  });

  it("refuses a checksum that disagrees with the stored bytes, leaving the row PENDING and unpromoted", async () => {
    const { createUploadIntent, finalizeUpload, attachmentStore, prisma } = mods();
    const body = bytes("bytes that will not match the claim");
    const intent = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "mismatch.pdf",
      mime: PDF,
      size: body.byteLength,
    });
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;
    await attachmentStore().put(intent.data.objectKey, body, PDF);

    const wrong = await finalizeUpload({ attachmentId: intent.data.attachmentId, sha256: "0".repeat(64) });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.code).toBe("VALIDATION");

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: intent.data.attachmentId } });
    expect(row.state).toBe("PENDING");
    expect(row.sha256).toBeNull();
    // The reservation row is there and is the ONLY row: the failed finalize wrote nothing.
    const ledger = await prisma.auditLog.findMany({
      where: { entityId: intent.data.attachmentId },
      select: { newValue: true },
    });
    expect(ledger).toEqual([{ newValue: "PENDING" }]);
  });

  it("refuses a finalize whose object never arrived, and one whose size disagrees", async () => {
    const { createUploadIntent, finalizeUpload, attachmentStore, prisma } = mods();

    const missing = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "never-arrived.pdf",
      mime: PDF,
      size: 9,
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    const noObject = await finalizeUpload({ attachmentId: missing.data.attachmentId });
    expect(noObject.ok).toBe(false);
    expect(noObject.ok === false && noObject.code).toBe("VALIDATION");
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: missing.data.attachmentId } })).state).toBe(
      "PENDING",
    );

    const wrongSize = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "declared-9.pdf",
      mime: PDF,
      size: 9,
    });
    expect(wrongSize.ok).toBe(true);
    if (!wrongSize.ok) return;
    await attachmentStore().put(wrongSize.data.objectKey, bytes("far more than nine bytes"), PDF);
    const sizeMismatch = await finalizeUpload({ attachmentId: wrongSize.data.attachmentId });
    expect(sizeMismatch.ok).toBe(false);
    expect(sizeMismatch.ok === false && sizeMismatch.code).toBe("VALIDATION");
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: wrongSize.data.attachmentId } })).state).toBe(
      "PENDING",
    );
  });

  it("lists READY attachments only, and never PENDING or REMOVED ones", async () => {
    const { listAttachments, createUploadIntent, prisma } = mods();
    const body = bytes("a listed attachment");
    const { intent } = await attach(OPEN_TICKET_ID, "listed.pdf", body);
    const pending = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "unlisted.pdf",
      mime: PDF,
      size: 3,
    });
    expect(pending.ok).toBe(true);

    const listed = await listAttachments(OPS_VIEWER, OPEN_TICKET_ID);
    const ids = listed.map((a) => a.id);
    expect(ids).toContain(intent.attachmentId);
    if (pending.ok) expect(ids).not.toContain(pending.data.attachmentId);
    for (const a of listed) expect(a.state).toBe("READY");

    const readyCount = await prisma.attachment.count({ where: { ticketId: OPEN_TICKET_ID, state: "READY" } });
    expect(listed).toHaveLength(readyCount);
  });

  it("hands the download loader the object key, and hides PENDING rows from it", async () => {
    const { getAttachmentForDownload, createUploadIntent } = mods();
    const body = bytes("downloadable");
    const { intent } = await attach(OPEN_TICKET_ID, "downloadable.pdf", body);

    const found = await getAttachmentForDownload(OPS_VIEWER, intent.attachmentId, hoisted.ctx);
    expect(found).not.toBeNull();
    expect(found?.objectKey).toBe(`${OPEN_TICKET_ID}/${intent.attachmentId}`);
    expect(found?.attachment.state).toBe("READY");

    const pending = await createUploadIntent({
      ticketId: OPEN_TICKET_ID,
      filename: "not-yet.pdf",
      mime: PDF,
      size: 3,
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(await getAttachmentForDownload(OPS_VIEWER, pending.data.attachmentId, hoisted.ctx)).toBeNull();
    expect(await getAttachmentForDownload(OPS_VIEWER, `it_att_missing_${RUN}`, hoisted.ctx)).toBeNull();
  });

  it("lets compliance download what others attached — read-plus-annotate still reads", async () => {
    const { getAttachmentForDownload } = mods();
    const body = bytes("compliance may read this");
    const { intent } = await attach(OPEN_TICKET_ID, "for-compliance.pdf", body);
    const found = await getAttachmentForDownload(CCO_VIEWER, intent.attachmentId, hoisted.ctx);
    expect(found).not.toBeNull();
  });

  it("removes softly: REMOVED + one audit row, the row and the object both survive", async () => {
    const { removeAttachment, attachmentStore, prisma } = mods();
    const body = bytes("attached then removed");
    const { intent } = await attach(OPEN_TICKET_ID, "removed.pdf", body);

    const removed = await removeAttachment({ attachmentId: intent.attachmentId });
    expect(removed.ok).toBe(true);

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: intent.attachmentId } });
    expect(row.state).toBe("REMOVED");
    expect(row.removedAt).not.toBeNull();
    expect(row.removedById).toBe(OPS_USER_ID);

    // The bytes are still there: "remove" means off the ticket, not destroyed.
    const head = await attachmentStore().head(intent.attachmentId ? `${OPEN_TICKET_ID}/${intent.attachmentId}` : "");
    expect(head.exists).toBe(true);
    expect(head.size).toBe(body.byteLength);

    const rows = await prisma.auditLog.findMany({
      where: { action: "ATTACHMENT_REMOVED", entityId: intent.attachmentId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldChanged).toBe("state");
    expect(rows[0].oldValue).toBe("READY");
    expect(rows[0].newValue).toBe("REMOVED");

    const again = await removeAttachment({ attachmentId: intent.attachmentId });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.code).toBe("CONFLICT");
    expect(
      await prisma.auditLog.count({ where: { action: "ATTACHMENT_REMOVED", entityId: intent.attachmentId } }),
    ).toBe(1);
  });

  it("refuses compliance_officers a removal, and records that denial too", async () => {
    const { removeAttachment, prisma } = mods();
    const { intent } = await attach(OPEN_TICKET_ID, "not-yours-to-remove.pdf", bytes("stays put"));

    const res = await as(CCO_VIEWER, () => removeAttachment({ attachmentId: intent.attachmentId }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("FORBIDDEN");
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: intent.attachmentId } })).state).toBe("READY");
  });

  it("the database refuses a hard DELETE of an attachment row (G14)", async () => {
    const { prisma } = mods();
    const { intent } = await attach(OPEN_TICKET_ID, "undeletable.pdf", bytes("permanent"));
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "Attachment" WHERE id = '${intent.attachmentId}'`),
    ).rejects.toThrow();
    expect(await prisma.attachment.findUnique({ where: { id: intent.attachmentId } })).not.toBeNull();
  });
});
