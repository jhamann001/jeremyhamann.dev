/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make every row written here permanent).
 *
 * Proves the S9 macro-admin path against a real database and a real transaction:
 *  - `createMacro` writes the macro AND one `MACRO_CREATED` row carrying the body, in one transaction.
 *  - `updateMacro` writes ONE `MACRO_UPDATED` row per changed field, and the `body` row carries the
 *    OLD text as well as the new — the property the whole runtime-editing story rests on.
 *  - A save that changes nothing writes no row at all.
 *  - `setMacroActive` flips conditionally: the second identical call is a successful no-op with no
 *    second audit row, and a retired macro disappears from `listMacros` while staying in
 *    `listMacrosAdmin`.
 *  - `macro:admin` is held by ops_team and compliance_officers and by nobody else, and every refusal
 *    is in the ledger.
 *  - A duplicate key is a CONFLICT, not an overwrite.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer and
 * context against the real test database, exactly as `users.actions.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const ADMIN_ID = `it_macros_admin_${RUN}`;
const CCO_ID = `it_macros_cco_${RUN}`;
const KEY_NEW = `it-macro-new-${RUN}`;
const KEY_EDIT = `it-macro-edit-${RUN}`;
const KEY_RETIRE = `it-macro-retire-${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: ADMIN_ID,
  email: `macros.admin.${RUN}@wm-helpdesk.local`,
  name: "Olivia Admin",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.19",
  userAgent: `it-macros/${RUN}`,
  requestId: `it-macros-${RUN}`,
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
const actionsModule = TEST_URL ? await import("@/server/macros.actions") : null;
const readsModule = TEST_URL ? await import("@/server/macros") : null;
// Imported dynamically like the rest: a static import would be hoisted above the DATABASE_URL
// repoint above, and `@/lib/audit` pulls in the Prisma client at module load.
const auditModule = TEST_URL ? await import("@/lib/audit") : null;

function mods() {
  if (!dbModule || !actionsModule || !readsModule || !auditModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...actionsModule, ...readsModule, ...auditModule };
}

/** The `metadata` the macro actions attach to any audit row carrying wording. */
type BodyMeta = {
  bodyFull: { previous: string | null; current: string };
  bodyChars: { previous: number | null; current: number };
  bodyTruncatedInValue: boolean;
};

function bodyMeta(metadata: unknown): BodyMeta {
  return metadata as BodyMeta;
}

/**
 * A body of EXACTLY `length` characters that survives `macroBodySchema`'s `.trim()` unchanged, resolves
 * every placeholder, and carries no digit run the PII sanitizer would rewrite.
 */
function longBody(length: number, marker: string): string {
  const head = `Dear {{requester.firstName}}, regarding {{ticket.number}} — ${marker}.\n\n`;
  const filler = "Firm-approved disclosure wording that a client reads in full. ";
  let text = head;
  while (text.length < length) text += filler;
  // Last character is a full stop, so nothing is trimmed off either end.
  return `${text.slice(0, length - 1)}.`;
}

/** Runs `fn` with the viewer temporarily holding `groups`, then restores it. */
async function asGroups<T>(groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer.groups;
  hoisted.viewer = { ...hoisted.viewer, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = { ...hoisted.viewer, groups: before };
  }
}

async function auditFor(entityId: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, entityId },
    orderBy: { seq: "asc" },
    select: {
      seq: true,
      action: true,
      entityType: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      metadata: true,
      actorId: true,
      actorGroups: true,
    },
  });
}

describe.skipIf(!TEST_URL)("macro administration (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "macros fixture", sortOrder: 1 },
    });
    await prisma.queue.upsert({
      where: { key: "CLIENT_SERVICE" },
      update: {},
      create: { key: "CLIENT_SERVICE", name: "Client Service", description: "macros fixture", sortOrder: 2 },
    });

    const people: Array<{ id: string; email: string; name: string; groups: OktaGroup[] }> = [
      { id: ADMIN_ID, email: hoisted.viewer.email, name: "Olivia Admin", groups: ["ops_team"] },
      { id: CCO_ID, email: `macros.cco.${RUN}@wm-helpdesk.local`, name: "Cass CCO", groups: ["compliance_officers"] },
    ];
    for (const p of people) {
      await prisma.user.upsert({
        where: { id: p.id },
        update: { groups: p.groups, isActive: true, name: p.name },
        create: { id: p.id, email: p.email, name: p.name, groups: p.groups, emailVerified: new Date(), isActive: true },
      });
    }
  });

  it("refuses a caller without macro:admin and records every denial", async () => {
    const { createMacro, prisma } = mods();

    for (const groups of [["client_services"], ["advisors"], []] as OktaGroup[][]) {
      const denied = await asGroups(groups, () =>
        createMacro({
          key: `it-macro-denied-${RUN}`,
          title: "Should never exist",
          queueKey: null,
          body: "Denied body.",
          channel: "INTERNAL",
          disclaimerKey: "NONE",
          sortOrder: 0,
        }),
      );
      expect(denied.ok, groups.join("+") || "no groups").toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
    }

    expect(await prisma.macro.findUnique({ where: { key: `it-macro-denied-${RUN}` } })).toBeNull();

    const denials = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
      select: { newValue: true },
    });
    expect(denials.length).toBeGreaterThanOrEqual(3);
    expect(denials.some((d) => (d.newValue ?? "").includes("macro:admin create"))).toBe(true);
  });

  it("lets compliance_officers create a macro — the one mutation the CCO owns", async () => {
    const { createMacro, prisma } = mods();
    const result = await asGroups(["compliance_officers"], () =>
      createMacro({
        key: KEY_NEW,
        title: "Wire verification notice (it)",
        queueKey: "OPERATIONS",
        body: "Hello {{requester.firstName}}, about {{ticket.number}}. — {{agent.name}}, {{today}}",
        channel: "PUBLIC",
        disclaimerKey: "WIRE_VERIFICATION",
        sortOrder: 15,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await prisma.macro.findUniqueOrThrow({ where: { key: KEY_NEW } });
    expect(row.id).toBe(result.data.id);
    expect(row.isActive).toBe(true);
    expect(row.channel).toBe("PUBLIC");
    expect(row.disclaimerKey).toBe("WIRE_VERIFICATION");
    expect(row.sortOrder).toBe(15);
    expect(row.updatedById).toBe(ADMIN_ID);

    const audit = await auditFor(row.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("MACRO_CREATED");
    expect(audit[0].entityType).toBe("MACRO");
    expect(audit[0].fieldChanged).toBe("body");
    expect(audit[0].oldValue).toBeNull();
    expect(audit[0].newValue).toBe(row.body);
    expect(audit[0].actorId).toBe(ADMIN_ID);
    expect(audit[0].actorGroups).toEqual(["compliance_officers"]);
    expect(audit[0].metadata).toMatchObject({ key: KEY_NEW, channel: "PUBLIC", queueKey: "OPERATIONS" });
  });

  it("refuses a duplicate key with CONFLICT instead of overwriting the existing wording", async () => {
    const { createMacro, prisma } = mods();
    const before = await prisma.macro.findUniqueOrThrow({ where: { key: KEY_NEW } });

    const result = await createMacro({
      key: KEY_NEW,
      title: "Different title",
      queueKey: null,
      body: "Different body entirely.",
      channel: "INTERNAL",
      disclaimerKey: "NONE",
      sortOrder: 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONFLICT");

    const after = await prisma.macro.findUniqueOrThrow({ where: { key: KEY_NEW } });
    expect(after.body).toBe(before.body);
    expect(after.title).toBe(before.title);
  });

  it("refuses an incoherent channel / disclaimer pair and an unresolvable placeholder", async () => {
    const { createMacro } = mods();

    const noDisclaimer = await createMacro({
      key: `it-macro-bad-a-${RUN}`,
      title: "Public with no disclaimer",
      queueKey: null,
      body: "Hi {{requester.firstName}}.",
      channel: "PUBLIC",
      disclaimerKey: "NONE",
      sortOrder: 0,
    });
    expect(noDisclaimer.ok).toBe(false);
    if (!noDisclaimer.ok) expect(noDisclaimer.code).toBe("VALIDATION");

    const badPlaceholder = await createMacro({
      key: `it-macro-bad-b-${RUN}`,
      title: "Typo in a placeholder",
      queueKey: null,
      body: "Hi {{requester.emial}}.",
      channel: "INTERNAL",
      disclaimerKey: "NONE",
      sortOrder: 0,
    });
    expect(badPlaceholder.ok).toBe(false);
    if (!badPlaceholder.ok) {
      expect(badPlaceholder.code).toBe("VALIDATION");
      expect(badPlaceholder.fieldErrors?.body?.join(" ")).toContain("{{requester.emial}}");
    }
  });

  it("refuses a body carrying what looks like client account data", async () => {
    const { createMacro, prisma } = mods();
    const result = await createMacro({
      key: `it-macro-pii-${RUN}`,
      title: "Pasted a real value",
      queueKey: null,
      body: "Internal: the client's SSN is 123-45-6789, do not repeat it.",
      channel: "INTERNAL",
      disclaimerKey: "NONE",
      sortOrder: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("VALIDATION");
    expect(await prisma.macro.findUnique({ where: { key: `it-macro-pii-${RUN}` } })).toBeNull();
  });

  it("writes one MACRO_UPDATED row per changed field, with the old body preserved", async () => {
    const { createMacro, updateMacro, prisma } = mods();
    const created = await createMacro({
      key: KEY_EDIT,
      title: "Original title",
      queueKey: "OPERATIONS",
      body: "Original body for {{ticket.number}}.",
      channel: "INTERNAL",
      disclaimerKey: "NONE",
      sortOrder: 20,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    const before = await prisma.macro.findUniqueOrThrow({ where: { id } });

    const updated = await updateMacro({
      macroId: id,
      title: "Revised title",
      body: "Revised body for {{ticket.number}}, {{requester.firstName}}.",
      queueKey: "CLIENT_SERVICE",
      sortOrder: 25,
    });
    expect(updated.ok).toBe(true);

    const after = await prisma.macro.findUniqueOrThrow({ where: { id }, include: { queue: true } });
    expect(after.title).toBe("Revised title");
    expect(after.body).toContain("Revised body");
    expect(after.queue?.key).toBe("CLIENT_SERVICE");
    expect(after.sortOrder).toBe(25);
    expect(after.updatedById).toBe(ADMIN_ID);

    const rows = (await auditFor(id)).filter((r) => r.action === "MACRO_UPDATED");
    expect(rows.map((r) => r.fieldChanged).sort()).toEqual(["body", "queueKey", "sortOrder", "title"]);

    const bodyRow = rows.find((r) => r.fieldChanged === "body");
    expect(bodyRow?.oldValue).toBe(before.body);
    expect(bodyRow?.newValue).toBe(after.body);
    // Short bodies: the columns and the untruncated metadata copy agree, and the row says so.
    const shortMeta = bodyMeta(bodyRow?.metadata);
    expect(shortMeta.bodyFull.previous).toBe(before.body);
    expect(shortMeta.bodyFull.current).toBe(after.body);
    expect(shortMeta.bodyChars).toEqual({ previous: before.body.length, current: after.body.length });
    expect(shortMeta.bodyTruncatedInValue).toBe(false);
    expect(rows.find((r) => r.fieldChanged === "queueKey")?.oldValue).toBe("OPERATIONS");
    expect(rows.find((r) => r.fieldChanged === "sortOrder")?.newValue).toBe("25");
  });

  it("writes nothing when a save changes nothing", async () => {
    const { updateMacro, prisma } = mods();
    const macro = await prisma.macro.findUniqueOrThrow({ where: { key: KEY_EDIT } });
    const countBefore = (await auditFor(macro.id)).length;

    const result = await updateMacro({ macroId: macro.id, title: macro.title, body: macro.body });
    expect(result.ok).toBe(true);

    expect((await auditFor(macro.id)).length).toBe(countBefore);
  });

  it("refuses a channel flip that would leave the disclaimer incoherent", async () => {
    const { updateMacro, prisma } = mods();
    const macro = await prisma.macro.findUniqueOrThrow({ where: { key: KEY_EDIT } });
    // INTERNAL + NONE today; flipping only the channel would give PUBLIC + NONE.
    const result = await updateMacro({ macroId: macro.id, channel: "PUBLIC" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("VALIDATION");

    const after = await prisma.macro.findUniqueOrThrow({ where: { id: macro.id } });
    expect(after.channel).toBe("INTERNAL");
  });

  it("retires a macro out of the composer, keeps it in the admin list, and is idempotent", async () => {
    const { createMacro, setMacroActive, listMacros, listMacrosAdmin, prisma } = mods();
    const created = await createMacro({
      key: KEY_RETIRE,
      title: "Retire me (it)",
      queueKey: "OPERATIONS",
      body: "Body to retire, {{requester.firstName}}.",
      channel: "INTERNAL",
      disclaimerKey: "NONE",
      sortOrder: 30,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    const visibleBefore = await listMacros(hoisted.viewer, "OPERATIONS", hoisted.ctx);
    expect(visibleBefore.some((m) => m.id === id)).toBe(true);

    const retired = await setMacroActive({ macroId: id, isActive: false });
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(retired.data.isActive).toBe(false);

    const visibleAfter = await listMacros(hoisted.viewer, "OPERATIONS", hoisted.ctx);
    expect(visibleAfter.some((m) => m.id === id)).toBe(false);

    const admin = await listMacrosAdmin(hoisted.viewer, hoisted.ctx);
    const adminRow = admin.find((m) => m.id === id);
    expect(adminRow?.isActive).toBe(false);
    expect(adminRow?.updatedBy?.id).toBe(ADMIN_ID);

    const deactivations = (await auditFor(id)).filter((r) => r.action === "MACRO_DEACTIVATED");
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0].fieldChanged).toBe("isActive");
    expect(deactivations[0].oldValue).toBe("true");
    expect(deactivations[0].newValue).toBe("false");

    // Asking for the state it already holds is not an event.
    const again = await setMacroActive({ macroId: id, isActive: false });
    expect(again.ok).toBe(true);
    expect((await auditFor(id)).filter((r) => r.action === "MACRO_DEACTIVATED")).toHaveLength(1);

    const restored = await setMacroActive({ macroId: id, isActive: true });
    expect(restored.ok).toBe(true);
    const reactivations = (await auditFor(id)).filter((r) => r.action === "MACRO_REACTIVATED");
    expect(reactivations).toHaveLength(1);
    expect(reactivations[0].newValue).toBe("true");
    expect((await prisma.macro.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
  });

  /**
   * The control the whole slice rests on, at the size that actually breaks it. `oldValue`/`newValue`
   * are cut at `AUDIT_VALUE_MAX_CHARS` (4 000) while a body may be `MACRO_BODY_MAX` (20 000), so a
   * CCO-owned disclosure template would otherwise be recorded as its first ~3 987 characters and then
   * be gone: `Macro` has no version history, the seeder is create-if-missing, and `AuditLog` is
   * append-only. `metadata.bodyFull` is the untruncated copy.
   */
  it("keeps a 20 000-character body in the ledger byte-for-byte, on create and on edit", async () => {
    const { createMacro, updateMacro, prisma, MACRO_BODY_MAX, AUDIT_VALUE_MAX_CHARS } = mods();
    const key = `it-macro-long-${RUN}`;
    const original = longBody(MACRO_BODY_MAX, "original wording");
    const revised = longBody(MACRO_BODY_MAX, "revised wording");
    expect(original).toHaveLength(MACRO_BODY_MAX);
    expect(revised).toHaveLength(MACRO_BODY_MAX);
    expect(revised).not.toBe(original);
    expect(MACRO_BODY_MAX).toBeGreaterThan(AUDIT_VALUE_MAX_CHARS);

    const created = await createMacro({
      key,
      title: "Long disclosure template (it)",
      queueKey: null,
      body: original,
      channel: "INTERNAL",
      disclaimerKey: "NONE",
      sortOrder: 40,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    expect((await prisma.macro.findUniqueOrThrow({ where: { id } })).body).toBe(original);

    const createdRow = (await auditFor(id)).find((r) => r.action === "MACRO_CREATED");
    // The column is the human-readable summary: cut, and flagged as cut.
    expect(createdRow?.newValue).toHaveLength(AUDIT_VALUE_MAX_CHARS);
    expect(createdRow?.newValue?.endsWith("…[truncated]")).toBe(true);
    const createdMeta = bodyMeta(createdRow?.metadata);
    expect(createdMeta.bodyTruncatedInValue).toBe(true);
    expect(createdMeta.bodyFull.previous).toBeNull();
    expect(createdMeta.bodyChars).toEqual({ previous: null, current: MACRO_BODY_MAX });
    // The point of the whole exercise: byte-for-byte, out of the ledger.
    expect(createdMeta.bodyFull.current).toBe(original);

    const updated = await updateMacro({ macroId: id, body: revised });
    expect(updated.ok).toBe(true);
    expect((await prisma.macro.findUniqueOrThrow({ where: { id } })).body).toBe(revised);

    const bodyRows = (await auditFor(id)).filter((r) => r.action === "MACRO_UPDATED" && r.fieldChanged === "body");
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0].oldValue).toHaveLength(AUDIT_VALUE_MAX_CHARS);
    expect(bodyRows[0].newValue).toHaveLength(AUDIT_VALUE_MAX_CHARS);
    const updatedMeta = bodyMeta(bodyRows[0].metadata);
    expect(updatedMeta.bodyTruncatedInValue).toBe(true);
    expect(updatedMeta.bodyChars).toEqual({ previous: MACRO_BODY_MAX, current: MACRO_BODY_MAX });
    // The superseded wording — the only copy, now that `Macro.body` has been overwritten.
    expect(updatedMeta.bodyFull.previous).toBe(original);
    expect(updatedMeta.bodyFull.current).toBe(revised);
  });

  it("answers NOT_FOUND for a macro that does not exist, without writing anything", async () => {
    const { updateMacro, setMacroActive } = mods();
    const missing = `it_macro_missing_${RUN}`;

    const updated = await updateMacro({ macroId: missing, title: "x" });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.code).toBe("NOT_FOUND");

    const flipped = await setMacroActive({ macroId: missing, isActive: false });
    expect(flipped.ok).toBe(false);
    if (!flipped.ok) expect(flipped.code).toBe("NOT_FOUND");

    expect(await auditFor(missing)).toEqual([]);
  });

  it("refuses listMacrosAdmin to a viewer without macro:admin and records the denial", async () => {
    const { listMacrosAdmin, prisma } = mods();
    await expect(asGroups(["client_services"], () => listMacrosAdmin(hoisted.viewer, hoisted.ctx))).rejects.toThrow(
      /Forbidden/,
    );
    const denials = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
      select: { newValue: true },
    });
    expect(denials.some((d) => (d.newValue ?? "").includes("macro:admin list"))).toBe(true);
  });
});
