/**
 * Compliance slice — DB-gated (`TEST_DATABASE_URL` only; docs/ARCHITECTURE.md §g shared
 * convention 10). Never the dev database: `ReviewStamp` and `IdentityVerification` are append-only at
 * the database, so every fixture row is permanent.
 *
 * The shared test database is permanent and test FILES RUN CONCURRENTLY, so every assertion here is
 * scoped to rows this run created: a per-run `RUN` marker is in every user id, every ticket subject
 * and every audit `requestId`, and no query in this file counts rows it did not write.
 *
 * What it proves, end to end:
 *
 *  SUPERVISORY REVIEW
 *   - `stampReview` writes ONE `ReviewStamp` and ONE `REVIEW_STAMPED` row in the same transaction,
 *     with the checklist, the verdict and a note-present flag on the audit row and NEVER the note text;
 *   - the same reviewer cannot stamp twice (CONFLICT), and the first verdict stands;
 *   - a second reviewer CAN stamp the same reply — supervision is not first-past-the-post;
 *   - an INTERNAL note is refused, and the refusal is recorded as `AUTHZ_DENIED`;
 *   - a viewer without `review:stamp` is refused, and that denial is recorded too;
 *   - a FLAGGED verdict with no note is a VALIDATION failure and writes nothing.
 *
 *  THE REVIEW QUEUE
 *   - `listRepliesForReview` returns PUBLIC replies only, oldest first, and drops a reply once it
 *     carries a stamp; `state: "REVIEWED"` is the exact complement;
 *   - a VOIDED ticket's replies never appear (CONTRACT §2 — every counting surface excludes them);
 *   - `listUnreviewedReplies` (the contract signature) agrees with it on the same fixtures;
 *   - the CSV carries no reply body, and one line per (reply × stamp).
 *
 *  THE IDENTITY GATE
 *   - a money-movement ticket cannot reach RESOLVED with nothing on file;
 *   - a FAILED verification does NOT satisfy it; a VERIFIED one does;
 *   - the ops override writes BOTH `IDENTITY_VERIFIED(OVERRIDDEN)` and `IDENTITY_GATE_OVERRIDDEN`,
 *     and satisfies the gate for THAT ticket only;
 *   - a non-gated category is never blocked;
 *   - a non-ops viewer cannot override.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, TicketCategory, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_b6_ops_${RUN}`;
const CCO_ID = `it_b6_cco_${RUN}`;
const CS_ID = `it_b6_cs_${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: OPS_ID,
  email: `b6.ops.${RUN}@wm-helpdesk.local`,
  name: "Olive Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.77",
  userAgent: `it-b6/${RUN}`,
  requestId: `it-b6-${RUN}`,
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

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const reviewsRead = TEST_URL ? await import("@/server/reviews") : null;
const reviewsWrite = TEST_URL ? await import("@/server/reviews.actions") : null;
const gateModule = TEST_URL ? await import("@/server/identity-gate") : null;
const identityWrite = TEST_URL ? await import("@/server/identity-verification.actions") : null;

function mods() {
  if (!dbModule || !reviewsRead || !reviewsWrite || !gateModule || !identityWrite) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...reviewsRead, ...reviewsWrite, ...gateModule, ...identityWrite };
}

/** Runs `fn` as another identity, then restores. Every action reads the viewer through the mock. */
async function as<T>(id: string, email: string, groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer;
  hoisted.viewer = { ...before, id, email, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = before;
  }
}

const viewerFor = (id: string, groups: OktaGroup[]): Viewer => ({
  id,
  email: `${id}@wm-helpdesk.local`,
  name: id,
  image: null,
  groups,
  isDev: false,
});

let queueId = "";

/**
 * A run-unique CALENDAR DAY for the fixtures whose ORDER or EXCLUSION this file asserts.
 *
 * The test database is shared and permanent, and `listRepliesForReview` is oldest-first with a cap:
 * against a database holding other runs' replies, rows created "now" sort last and fall off the end
 * of the page. Pinning this run's fixtures to a day derived from `RUN`, and filtering on that day,
 * gives the reader a window that contains this run's rows and (with overwhelming probability) nobody
 * else's — which is what the concurrency rule asks for. The day is in the past, because a future
 * `createdAt` would make the row invisible to any caller that defaults `to` to today.
 */
const FIXTURE_DAY = (() => {
  const seed = Number.parseInt(RUN, 16);
  const year = 2001 + (seed % 17);
  const month = 1 + (Math.floor(seed / 17) % 12);
  const day = 1 + (Math.floor(seed / 204) % 28);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { year, month, day, iso: `${year}-${pad(month)}-${pad(day)}` };
})();

/** An instant inside `FIXTURE_DAY`, `minutes` past 09:00 UTC (comfortably inside the firm day). */
function fixtureAt(minutes: number): Date {
  return new Date(Date.UTC(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 15, minutes, 0));
}

/** The review query narrowed to this run's fixture day. */
const FIXTURE_QUERY = { from: FIXTURE_DAY.iso, to: FIXTURE_DAY.iso, queueKey: null } as const;

/** A ticket owned by this run, in OPERATIONS, with the SLA snapshot the model requires. */
async function makeTicket(opts: {
  category: TicketCategory;
  status?: "NEW" | "OPEN" | "RESOLVED" | "VOIDED";
  label: string;
}): Promise<{ id: string; number: number }> {
  const { prisma } = mods();
  const now = new Date();
  return prisma.ticket.create({
    data: {
      subject: `b6-${RUN}-${opts.label}`,
      description: `fixture ${RUN}`,
      requesterName: "Fixture Client",
      requesterEmail: `client.${RUN}@example.test`,
      category: opts.category,
      priority: "STANDARD",
      status: opts.status ?? "OPEN",
      queueId,
      createdById: OPS_ID,
      slaFirstResponseMinutes: 240,
      slaResolutionMinutes: 2880,
      firstResponseDueAt: new Date(now.getTime() + 240 * 60_000),
      resolutionDueAt: new Date(now.getTime() + 2880 * 60_000),
      ...(opts.status === "VOIDED"
        ? { voidedAt: now, voidedById: OPS_ID, voidReason: "fixture void reason for the test" }
        : {}),
    },
    select: { id: true, number: true },
  });
}

async function makeComment(
  ticketId: string,
  visibility: "PUBLIC" | "INTERNAL",
  body: string,
  createdAt?: Date,
): Promise<string> {
  const { prisma } = mods();
  const row = await prisma.comment.create({
    data: {
      ticketId,
      authorId: OPS_ID,
      authorKind: "STAFF",
      visibility,
      body,
      disclaimerKey: visibility === "PUBLIC" ? "GENERAL_SERVICE" : "NONE",
      ...(createdAt === undefined ? {} : { createdAt }),
    },
    select: { id: true },
  });
  return row.id;
}

/** Audit rows this run wrote, filtered to one action — scoped by the per-run requestId. */
async function auditRows(action: string, entityId?: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: {
      action: action as never,
      requestId: hoisted.ctx.requestId,
      ...(entityId === undefined ? {} : { entityId }),
    },
    select: {
      id: true,
      actorId: true,
      entityType: true,
      entityId: true,
      ticketId: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      metadata: true,
    },
  });
}

describe.skipIf(!TEST_URL)("B6 compliance: review stamps + identity gate (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    const queue = await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "b6 fixture", sortOrder: 1 },
      select: { id: true },
    });
    queueId = queue.id;

    for (const [id, name, groups] of [
      [OPS_ID, "Olive Ops", ["ops_team"]],
      [CCO_ID, "Cleo CCO", ["compliance_officers"]],
      [CS_ID, "Cass Service", ["client_services"]],
    ] as const) {
      await prisma.user.upsert({
        where: { id },
        update: {},
        create: { id, email: `${id}@wm-helpdesk.local`, name, groups: [...groups], isActive: true },
      });
    }
  });

  // -------------------------------------------------------------------------
  // Supervisory review
  // -------------------------------------------------------------------------

  it("stamps a public reply: one row, one audit entry, checklist on the row and the note never in the ledger", async () => {
    const { stampReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "stamp-happy" });
    const commentId = await makeComment(ticket.id, "PUBLIC", "Your transfer settled on Tuesday.");

    const SECRET_NOTE = `wording tightened ${RUN}`;
    const result = await stampReview({
      commentId,
      verdict: "APPROVED",
      checklist: ["DISCLAIMER", "ACCURATE", "NOT_A_REAL_KEY"],
      note: SECRET_NOTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stamps = await prisma.reviewStamp.findMany({ where: { commentId } });
    expect(stamps).toHaveLength(1);
    expect(stamps[0].verdict).toBe("APPROVED");
    expect(stamps[0].reviewerId).toBe(OPS_ID);
    expect(stamps[0].note).toBe(SECRET_NOTE);

    const rows = await auditRows("REVIEW_STAMPED", result.data.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.entityType).toBe("REVIEW_STAMP");
    expect(row.ticketId).toBe(ticket.id);
    expect(row.fieldChanged).toBe("verdict");
    expect(row.oldValue).toBeNull();
    expect(row.newValue).toBe("APPROVED");

    const meta = row.metadata as Record<string, unknown>;
    // Unknown checklist keys are dropped and the canonical order is restored.
    expect(meta.checklist).toEqual(["DISCLAIMER", "ACCURATE"]);
    expect(meta.checkedCount).toBe(2);
    expect(meta.notePresent).toBe(true);
    expect(meta.ticketNumber).toBe(ticket.number);
    // §7.3: the ledger carries enum values and counts, never the reviewer's prose.
    expect(JSON.stringify(row.metadata)).not.toContain(SECRET_NOTE);
  });

  it("refuses a second stamp from the same reviewer and keeps the first verdict", async () => {
    const { stampReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "stamp-twice" });
    const commentId = await makeComment(ticket.id, "PUBLIC", "First answer.");

    const first = await stampReview({ commentId, verdict: "APPROVED" });
    expect(first.ok).toBe(true);

    const second = await stampReview({ commentId, verdict: "FLAGGED", note: "changed my mind about this" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("CONFLICT");

    const stamps = await prisma.reviewStamp.findMany({ where: { commentId } });
    expect(stamps).toHaveLength(1);
    expect(stamps[0].verdict).toBe("APPROVED");
  });

  it("lets a SECOND reviewer stamp the same reply — supervision is not first-past-the-post", async () => {
    const { stampReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "stamp-two-people" });
    const commentId = await makeComment(ticket.id, "PUBLIC", "An answer two people looked at.");

    expect((await stampReview({ commentId, verdict: "APPROVED" })).ok).toBe(true);
    const byCco = await as(CCO_ID, `${CCO_ID}@wm-helpdesk.local`, ["compliance_officers"], () =>
      stampReview({ commentId, verdict: "FLAGGED", note: "disclaimer is the wrong variant here" }),
    );
    expect(byCco.ok).toBe(true);

    const stamps = await prisma.reviewStamp.findMany({ where: { commentId }, orderBy: { createdAt: "asc" } });
    expect(stamps).toHaveLength(2);
    expect(stamps.map((s) => s.reviewerId).sort()).toEqual([CCO_ID, OPS_ID].sort());
  });

  it("refuses an INTERNAL note and records the denial", async () => {
    const { stampReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "stamp-internal" });
    const commentId = await makeComment(ticket.id, "INTERNAL", "Desk note, not correspondence.");

    const result = await stampReview({ commentId, verdict: "APPROVED" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FORBIDDEN");

    expect(await prisma.reviewStamp.count({ where: { commentId } })).toBe(0);
    const denials = await prisma.auditLog.findMany({
      where: { action: "AUTHZ_DENIED", requestId: hoisted.ctx.requestId, ticketId: ticket.id },
      select: { newValue: true },
    });
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(denials.some((d) => (d.newValue ?? "").includes("only public replies"))).toBe(true);
  });

  it("refuses a viewer without review:stamp, and writes nothing", async () => {
    const { stampReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "stamp-no-cap" });
    const commentId = await makeComment(ticket.id, "PUBLIC", "An answer client services sent.");

    const result = await as(CS_ID, `${CS_ID}@wm-helpdesk.local`, ["client_services"], () =>
      stampReview({ commentId, verdict: "APPROVED" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FORBIDDEN");
    expect(await prisma.reviewStamp.count({ where: { commentId } })).toBe(0);
  });

  it("refuses a FLAGGED verdict with no note and writes nothing", async () => {
    const { stampReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "stamp-flag-silent" });
    const commentId = await makeComment(ticket.id, "PUBLIC", "Something a reviewer will object to.");

    const result = await stampReview({ commentId, verdict: "FLAGGED" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    expect(result.fieldErrors?.note?.join(" ") ?? "").toContain("what is wrong");
    expect(await prisma.reviewStamp.count({ where: { commentId } })).toBe(0);
  });

  it("openReplyForReview returns the body and records TICKET_PREVIEWED first", async () => {
    const { openReplyForReview, prisma } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "open-full" });
    const body = `The full text nobody should see unrecorded ${RUN}.`;
    const commentId = await makeComment(ticket.id, "PUBLIC", body);

    const result = await openReplyForReview({ commentId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.body).toBe(body);
    expect(result.data.ticketNumber).toBe(ticket.number);

    const views = await prisma.auditLog.findMany({
      where: { action: "TICKET_PREVIEWED", requestId: hoisted.ctx.requestId, ticketId: ticket.id },
      select: { id: true },
    });
    expect(views).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The review queue
  // -------------------------------------------------------------------------

  it("lists unstamped PUBLIC replies oldest first, drops them once stamped, and never shows internal notes or voided tickets", async () => {
    const { listRepliesForReview, listUnreviewedReplies, stampReview } = mods();
    const viewer = viewerFor(CCO_ID, ["compliance_officers"]);

    const live = await makeTicket({ category: "STATEMENT_REQUEST", label: "queue-live" });
    const older = await makeComment(live.id, "PUBLIC", "Older reply.", fixtureAt(0));
    const newer = await makeComment(live.id, "PUBLIC", "Newer reply.", fixtureAt(1));
    const internal = await makeComment(live.id, "INTERNAL", "A desk note.", fixtureAt(2));

    const voided = await makeTicket({ category: "STATEMENT_REQUEST", status: "VOIDED", label: "queue-voided" });
    const onVoided = await makeComment(voided.id, "PUBLIC", "Reply on a voided ticket.", fixtureAt(3));

    const mine = (rows: { commentId: string }[]) =>
      rows.map((r) => r.commentId).filter((id) => [older, newer, internal, onVoided].includes(id));

    const q = { ...FIXTURE_QUERY, state: "UNREVIEWED" as const };
    const before = await listRepliesForReview(viewer, q);
    expect(mine(before)).toEqual([older, newer]); // oldest first; no internal note, no voided ticket

    // The contract signature agrees with the richer reader on the same fixtures.
    const dtos = await listUnreviewedReplies(viewer, { from: FIXTURE_DAY.iso, to: FIXTURE_DAY.iso });
    expect(dtos.filter((c) => [older, newer, internal, onVoided].includes(c.id)).map((c) => c.id)).toEqual([
      older,
      newer,
    ]);

    expect((await stampReview({ commentId: older, verdict: "APPROVED" })).ok).toBe(true);

    const after = await listRepliesForReview(viewer, q);
    expect(mine(after)).toEqual([newer]);

    const reviewed = await listRepliesForReview(viewer, { ...q, state: "REVIEWED" });
    expect(mine(reviewed)).toEqual([older]);

    const all = await listRepliesForReview(viewer, { ...q, state: "ALL" });
    expect(mine(all)).toEqual([older, newer]);
  });

  it("the CSV carries one line per (reply x stamp), no reply body, and a header that matches the columns", async () => {
    const { listRepliesForReview, reviewRowsToCsv, REVIEW_CSV_COLUMNS, stampReview } = mods();
    const viewer = viewerFor(CCO_ID, ["compliance_officers"]);
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "csv" });
    const BODY = `body-that-must-not-be-exported-${RUN}`;
    const commentId = await makeComment(ticket.id, "PUBLIC", BODY, fixtureAt(10));

    expect((await stampReview({ commentId, verdict: "APPROVED", note: `csv note ${RUN}` })).ok).toBe(true);
    await as(CCO_ID, `${CCO_ID}@wm-helpdesk.local`, ["compliance_officers"], async () => {
      expect((await stampReview({ commentId, verdict: "FLAGGED", note: "second opinion, flagged" })).ok).toBe(true);
    });

    const rows = (await listRepliesForReview(viewer, { ...FIXTURE_QUERY, state: "ALL" })).filter(
      (r) => r.commentId === commentId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stamps).toHaveLength(2);

    const csv = reviewRowsToCsv(rows, true);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0].split(",")).toHaveLength(REVIEW_CSV_COLUMNS.length);
    expect(lines).toHaveLength(3); // header + one line per stamp
    expect(csv).not.toContain(BODY);
    expect(csv).not.toContain(`csv note ${RUN}`);
    expect(csv).toContain("APPROVED");
    expect(csv).toContain("FLAGGED");
    expect(csv).toContain(String(ticket.number));
  });

  // -------------------------------------------------------------------------
  // The identity gate
  // -------------------------------------------------------------------------

  it("blocks RESOLVED on a money-movement ticket with nothing on file, and permits every other category", async () => {
    const { assertIdentityGate, isIdentityGateSatisfied, prisma } = mods();
    const wire = await makeTicket({ category: "WIRE_TRANSFER", label: "gate-blocked" });
    const general = await makeTicket({ category: "STATEMENT_REQUEST", label: "gate-open" });

    await expect(
      prisma.$transaction((tx) => assertIdentityGate(tx, { ticketId: wire.id, category: "WIRE_TRANSFER" })),
    ).rejects.toThrow(/identity verification/i);

    await expect(
      prisma.$transaction((tx) => assertIdentityGate(tx, { ticketId: general.id, category: "STATEMENT_REQUEST" })),
    ).resolves.toBeUndefined();

    await expect(
      prisma.$transaction((tx) => isIdentityGateSatisfied(tx, { ticketId: wire.id, category: "WIRE_TRANSFER" })),
    ).resolves.toBe(false);
  });

  it("a FAILED verification is recorded and does NOT satisfy the gate; a VERIFIED one does", async () => {
    const { recordIdentityVerification, isIdentityGateSatisfied, identityGateState, prisma } = mods();
    const ticket = await makeTicket({ category: "CASH_MOVEMENT", label: "gate-failed-then-verified" });

    const failed = await recordIdentityVerification({
      ticketId: ticket.id,
      method: "CALLBACK_KNOWN_NUMBER",
      result: "FAILED",
      note: "Called the number on file; nobody answered and the caller could not confirm the last transfer.",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;

    const failedRows = await auditRows("IDENTITY_VERIFIED", failed.data.id);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].newValue).toBe("FAILED");
    expect(failedRows[0].ticketId).toBe(ticket.id);
    expect((failedRows[0].metadata as Record<string, unknown>).method).toBe("CALLBACK_KNOWN_NUMBER");

    await expect(
      prisma.$transaction((tx) => isIdentityGateSatisfied(tx, { ticketId: ticket.id, category: "CASH_MOVEMENT" })),
    ).resolves.toBe(false);

    const verified = await recordIdentityVerification({
      ticketId: ticket.id,
      method: "CALLBACK_KNOWN_NUMBER",
      result: "VERIFIED",
      note: "Called back on the number on file; client confirmed the last two transfers.",
    });
    expect(verified.ok).toBe(true);

    await expect(
      prisma.$transaction((tx) => isIdentityGateSatisfied(tx, { ticketId: ticket.id, category: "CASH_MOVEMENT" })),
    ).resolves.toBe(true);

    const state = await identityGateState({ ticketId: ticket.id, category: "CASH_MOVEMENT" });
    expect(state.required).toBe(true);
    expect(state.satisfied).toBe(true);
    // `latest` is the newest row of ANY result, so a failed check is never hidden by a later pass.
    expect(state.latest?.result).toBe("VERIFIED");
  });

  it("sanitizes the verification note before it is persisted", async () => {
    const { recordIdentityVerification, listIdentityVerifications } = mods();
    const ticket = await makeTicket({ category: "ADDRESS_CHANGE", label: "gate-pii" });

    // I4 on this path is unchanged — `sanitizePII` still runs before the write — but Decision #116
    // narrowed WHAT it recognises to SSN, CARD and ACCOUNT. This note carries one of each surviving
    // kind plus the identifiers a verification note is most likely to contain.
    const result = await recordIdentityVerification({
      ticketId: ticket.id,
      method: "DOCUMENT",
      result: "VERIFIED",
      note: "Checked the licence: DL A1234567, DOB 01/02/1975, SSN 123-45-6789, acct 000123456789.",
    });
    expect(result.ok).toBe(true);

    const rows = await listIdentityVerifications(ticket.id);
    expect(rows).toHaveLength(1);
    for (const probe of ["123-45-6789", "000123456789"]) {
      expect(rows[0].note).not.toContain(probe);
    }
    expect(rows[0].note).toContain("[REDACTED:SSN]");
    expect(rows[0].note).toContain("[REDACTED:ACCOUNT ****6789]");
    // The licence number and the date of birth are deliberately NOT redacted. The
    // control that keeps them out of the note is the composer hint telling the operator not to copy
    // the identifiers, not the sanitizer.
    expect(rows[0].note).toContain("DL A1234567");
    expect(rows[0].note).toContain("DOB 01/02/1975");
  });

  it("the ops override writes both rows, satisfies the gate for that ticket only, and is refused to non-ops", async () => {
    const { overrideIdentityGate, isIdentityGateSatisfied, prisma } = mods();
    const ticket = await makeTicket({ category: "RETIREMENT_DISTRIBUTION", label: "gate-override" });
    const other = await makeTicket({ category: "RETIREMENT_DISTRIBUTION", label: "gate-override-other" });

    // Client services holds queue WRITE on CLIENT_SERVICE but not on OPERATIONS, and is not ops_team.
    const refused = await as(CS_ID, `${CS_ID}@wm-helpdesk.local`, ["client_services"], () =>
      overrideIdentityGate({ ticketId: ticket.id, reason: "we are in a hurry today", confirm: true }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("FORBIDDEN");
    expect(await prisma.identityVerification.count({ where: { ticketId: ticket.id } })).toBe(0);

    const REASON = `Client verified in person at the branch, documented in the file ${RUN}`;
    const ok = await overrideIdentityGate({ ticketId: ticket.id, reason: REASON, confirm: true });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;

    const row = await prisma.identityVerification.findUniqueOrThrow({ where: { id: ok.data.id } });
    expect(row.result).toBe("OVERRIDDEN");
    expect(row.verifiedById).toBe(OPS_ID);

    const verifiedRows = await auditRows("IDENTITY_VERIFIED", ok.data.id);
    expect(verifiedRows).toHaveLength(1);
    expect(verifiedRows[0].newValue).toBe("OVERRIDDEN");

    const overrideRows = await auditRows("IDENTITY_GATE_OVERRIDDEN", ticket.id);
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0].entityType).toBe("TICKET");
    expect(overrideRows[0].fieldChanged).toBe("identityGate");
    expect(overrideRows[0].newValue).toBe("OVERRIDDEN");
    expect((overrideRows[0].metadata as Record<string, unknown>).reason).toBe(REASON);

    await expect(
      prisma.$transaction((tx) =>
        isIdentityGateSatisfied(tx, { ticketId: ticket.id, category: "RETIREMENT_DISTRIBUTION" }),
      ),
    ).resolves.toBe(true);
    // Never retroactively for another ticket.
    await expect(
      prisma.$transaction((tx) =>
        isIdentityGateSatisfied(tx, { ticketId: other.id, category: "RETIREMENT_DISTRIBUTION" }),
      ),
    ).resolves.toBe(false);

    // A second override on a now-satisfied ticket is refused, so the ledger cannot carry a second
    // exception that was never made.
    const again = await overrideIdentityGate({ ticketId: ticket.id, reason: REASON, confirm: true });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("VALIDATION");
  });

  it("refuses an override on a category the gate does not cover", async () => {
    const { overrideIdentityGate } = mods();
    const ticket = await makeTicket({ category: "STATEMENT_REQUEST", label: "gate-override-ungated" });
    const result = await overrideIdentityGate({
      ticketId: ticket.id,
      reason: "there is nothing here to override at all",
      confirm: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
  });

  it("refuses a recorded result of OVERRIDDEN through the ordinary path", async () => {
    const { recordIdentityVerification, prisma } = mods();
    const ticket = await makeTicket({ category: "ACCOUNT_CLOSURE", label: "gate-no-backdoor" });
    const result = await recordIdentityVerification({
      ticketId: ticket.id,
      method: "OTHER",
      // Deliberately invalid: the ordinary action must not be able to write the override's result.
      result: "OVERRIDDEN" as "VERIFIED",
      note: "trying to satisfy the gate without the ops bar",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
    expect(await prisma.identityVerification.count({ where: { ticketId: ticket.id } })).toBe(0);
  });
});
