/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * Proves the whole of B10's write path against a real database and real transactions:
 *  - `subscribePush` creates the row and writes ONE `PUSH_SUBSCRIBED` carrying a **hash** of the
 *    endpoint and never the endpoint itself (§3.3 rule 2);
 *  - a re-subscribe with the same keys touches `lastSeenAt` and writes **no** audit row, because
 *    nothing transitioned;
 *  - a re-key writes one more `PUSH_SUBSCRIBED`, on the same single row (endpoint is unique);
 *  - an endpoint that belonged to somebody else moves, with a paired `PUSH_UNSUBSCRIBED`;
 *  - the service worker's `replaces` retires the rotated endpoint in the same transaction;
 *  - `unsubscribePush` DELETES (this is one of the two tables CONTRACT §1.4 allows that for) and
 *    writes the paired row; a second call is a no-op with no audit row; someone else's endpoint is
 *    `NOT_FOUND`, not a deletion and not an existence oracle;
 *  - an endpoint that is not one of the browser push services — an internal address, a metadata IP, a
 *    look-alike host — is `VALIDATION` and leaves no row for a later send to fetch;
 *  - the whole surface is `NOT_FOUND` while the VAPID keys are unset — which is what every
 *    environment on this branch is.
 *
 * Every assertion is scoped to rows this run created (`RUN`), because the test database is permanent
 * and files run concurrently.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_push_ops_${RUN}`;
const CS_ID = `it_push_cs_${RUN}`;
const ENDPOINT = `https://fcm.googleapis.com/fcm/send/it-push-${RUN}-a`;
const ENDPOINT_B = `https://fcm.googleapis.com/fcm/send/it-push-${RUN}-b`;
const P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const P256DH_2 = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const AUTH_2 = "DGv6ra1nlYgDCS1FRnbzlw";

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
  pushEnabled: true,
}));
hoisted.viewer = {
  id: OPS_ID,
  email: `push.ops.${RUN}@wm-helpdesk.local`,
  name: "Otto Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.31",
  userAgent: `it-push/${RUN} (Macintosh)`,
  requestId: `it-push-${RUN}`,
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
 * The env module is mocked so the FEATURE GATE can be flipped inside one file. Nothing else about it
 * matters here: the actions read only `isWebPushEnabled`, and no key is ever used to send anything.
 */
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, isWebPushEnabled: () => hoisted.pushEnabled };
});

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const actions = TEST_URL ? await import("@/server/push.actions") : null;

function mods() {
  if (!dbModule || !actions) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...actions };
}

/** Incremented in `beforeEach` so each test's audit rows are scoped to it alone. */
let testIndex = 0;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Audit rows this run wrote, oldest first. Scoped by requestId — never the whole table. */
async function auditRows() {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, entityId: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

async function pushRows() {
  const { prisma } = mods();
  return prisma.pushSubscription.findMany({
    where: { endpoint: { in: [ENDPOINT, ENDPOINT_B] } },
    orderBy: { endpoint: "asc" },
  });
}

async function asViewer<T>(id: string, email: string, fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer;
  hoisted.viewer = { ...hoisted.viewer, id, email };
  try {
    return await fn();
  } finally {
    hoisted.viewer = before;
  }
}

describe.skipIf(!TEST_URL)("push subscriptions (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const u of [
      { id: OPS_ID, email: hoisted.viewer.email, name: "Otto Ops", groups: ["ops_team" as const] },
      { id: CS_ID, email: `push.cs.${RUN}@wm-helpdesk.local`, name: "Cass Service", groups: ["client_services" as const] },
    ]) {
      await prisma.user.upsert({
        where: { id: u.id },
        update: { groups: u.groups, isActive: true },
        create: { id: u.id, email: u.email, name: u.name, groups: u.groups, isActive: true, emailVerified: new Date() },
      });
    }
  });

  beforeEach(async () => {
    const { prisma } = mods();
    hoisted.pushEnabled = true;
    // A requestId PER TEST: `auditRows()` scopes on it, and the ledger is append-only, so a shared
    // id would make every assertion read the rows of the tests before it.
    testIndex += 1;
    hoisted.ctx = { ...hoisted.ctx, requestId: `it-push-${RUN}-${testIndex}` };
    // This run's own endpoints only — the table is shared and permanent.
    await prisma.pushSubscription.deleteMany({ where: { endpoint: { in: [ENDPOINT, ENDPOINT_B] } } });
  });

  it("creates the row and audits a HASH of the endpoint, never the endpoint", async () => {
    const { subscribePush } = mods();
    const result = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await pushRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.data.id);
    expect(rows[0].userId).toBe(OPS_ID);
    expect(rows[0].p256dh).toBe(P256DH);
    expect(rows[0].auth).toBe(AUTH);
    expect(rows[0].lastSeenAt).not.toBeNull();
    expect(rows[0].userAgent).toContain("it-push");

    const subscribed = (await auditRows()).filter((r) => r.action === "PUSH_SUBSCRIBED");
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0].entityType).toBe("PUSH_SUBSCRIPTION");
    expect(subscribed[0].entityId).toBe(result.data.id);
    expect(subscribed[0].fieldChanged).toBe("endpoint");
    expect(subscribed[0].oldValue).toBeNull();
    expect(subscribed[0].newValue).toBe(sha256Hex(ENDPOINT));
    // The capability itself is nowhere in the row — not in a value, not in the metadata.
    expect(JSON.stringify(subscribed[0])).not.toContain(ENDPOINT);
    expect(JSON.stringify(subscribed[0])).not.toContain(`it-push-${RUN}-a`);
    expect((subscribed[0].metadata as { service?: string }).service).toBe("fcm.googleapis.com");
  });

  it("is idempotent: the same subscription again touches lastSeenAt and writes NO audit row", async () => {
    const { subscribePush, prisma } = mods();
    const first = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(first.ok).toBe(true);
    const before = (await auditRows()).length;
    const firstSeen = (await pushRows())[0].lastSeenAt;

    const again = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(again.ok).toBe(true);
    if (!again.ok || !first.ok) return;
    expect(again.data.id).toBe(first.data.id);

    expect((await auditRows()).length).toBe(before);
    expect(await prisma.pushSubscription.count({ where: { endpoint: ENDPOINT } })).toBe(1);
    const after = (await pushRows())[0].lastSeenAt;
    expect(after!.getTime()).toBeGreaterThanOrEqual(firstSeen!.getTime());
  });

  it("records a re-key as a transition, on the same single row", async () => {
    const { subscribePush } = mods();
    await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    const rekeyed = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH_2, auth: AUTH_2 } });
    expect(rekeyed.ok).toBe(true);

    const rows = await pushRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe(P256DH_2);

    const subscribed = (await auditRows()).filter((r) => r.action === "PUSH_SUBSCRIBED");
    expect(subscribed).toHaveLength(2);
    expect((subscribed[1].metadata as { rekeyed?: boolean }).rekeyed).toBe(true);
  });

  it("moves an endpoint that belonged to someone else, and says so in the ledger", async () => {
    const { subscribePush } = mods();
    await asViewer(CS_ID, `push.cs.${RUN}@wm-helpdesk.local`, async () => {
      await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    });
    const moved = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(moved.ok).toBe(true);

    const rows = await pushRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(OPS_ID);

    const rowsForRun = await auditRows();
    const released = rowsForRun.filter(
      (r) => r.action === "PUSH_UNSUBSCRIBED" && (r.metadata as { reason?: string }).reason === "REASSIGNED",
    );
    expect(released).toHaveLength(1);
    expect((released[0].metadata as { previousUserId?: string }).previousUserId).toBe(CS_ID);
    // And the new owner's own row, in the same transaction.
    expect(rowsForRun.filter((r) => r.action === "PUSH_SUBSCRIBED")).toHaveLength(2);
  });

  it("retires the endpoint the service worker says it replaces, in the same transaction", async () => {
    const { subscribePush } = mods();
    const old = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(old.ok).toBe(true);

    const rotated = await subscribePush({
      endpoint: ENDPOINT_B,
      keys: { p256dh: P256DH, auth: AUTH },
      replaces: ENDPOINT,
    });
    expect(rotated.ok).toBe(true);

    const rows = await pushRows();
    expect(rows.map((r) => r.endpoint)).toEqual([ENDPOINT_B]);

    const retired = (await auditRows()).filter(
      (r) => r.action === "PUSH_UNSUBSCRIBED" && (r.metadata as { reason?: string }).reason === "ROTATED",
    );
    expect(retired).toHaveLength(1);
    expect(retired[0].newValue).toBe(sha256Hex(ENDPOINT));
  });

  it("ignores a `replaces` that belongs to somebody else", async () => {
    const { subscribePush } = mods();
    await asViewer(CS_ID, `push.cs.${RUN}@wm-helpdesk.local`, async () => {
      await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    });
    await subscribePush({ endpoint: ENDPOINT_B, keys: { p256dh: P256DH, auth: AUTH }, replaces: ENDPOINT });

    const rows = await pushRows();
    expect(rows.map((r) => r.endpoint)).toEqual([ENDPOINT, ENDPOINT_B]);
    expect(
      (await auditRows()).filter(
        (r) => r.action === "PUSH_UNSUBSCRIBED" && (r.metadata as { reason?: string }).reason === "ROTATED",
      ),
    ).toHaveLength(0);
  });

  it("deletes on unsubscribe and writes the paired row; a second call changes nothing", async () => {
    const { subscribePush, unsubscribePush } = mods();
    const created = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const removed = await unsubscribePush({ endpoint: ENDPOINT });
    expect(removed.ok && removed.data.deleted).toBe(true);
    expect(await pushRows()).toHaveLength(0);

    const paired = (await auditRows()).filter(
      (r) => r.action === "PUSH_UNSUBSCRIBED" && (r.metadata as { reason?: string }).reason === "USER",
    );
    expect(paired).toHaveLength(1);
    expect(paired[0].entityId).toBe(created.data.id);
    expect(paired[0].newValue).toBe(sha256Hex(ENDPOINT));

    const before = (await auditRows()).length;
    const again = await unsubscribePush({ endpoint: ENDPOINT });
    expect(again.ok && again.data.deleted).toBe(false);
    expect((await auditRows()).length).toBe(before);
  });

  it("answers NOT_FOUND for somebody else's endpoint, and leaves it alone", async () => {
    const { subscribePush, unsubscribePush } = mods();
    await asViewer(CS_ID, `push.cs.${RUN}@wm-helpdesk.local`, async () => {
      await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    });
    const refused = await unsubscribePush({ endpoint: ENDPOINT });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("NOT_FOUND");
    expect(await pushRows()).toHaveLength(1);
  });

  it("validates the subscription's shape before anything is written", async () => {
    const { subscribePush } = mods();
    for (const bad of [
      { endpoint: "http://fcm.googleapis.com/fcm/send/x", keys: { p256dh: P256DH, auth: AUTH } },
      { endpoint: "not a url", keys: { p256dh: P256DH, auth: AUTH } },
      { endpoint: ENDPOINT, keys: { p256dh: "short", auth: AUTH } },
      { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: "AAAA" } },
    ]) {
      const result = await subscribePush(bad);
      expect(result.ok, JSON.stringify(bad.endpoint)).toBe(false);
      if (!result.ok) expect(result.code).toBe("VALIDATION");
    }
    expect(await pushRows()).toHaveLength(0);
  });

  /**
   * The SSRF guard, at the layer that writes. `/api/push/subscribe` is the second place in the app
   * where a person supplies a URL the server later fetches, and — unlike `/admin/webhooks` — every
   * signed-in member of staff reaches it. A refused endpoint must leave NO row behind for a later send
   * to pick up, which is what this proves against a real transaction.
   */
  it("refuses an endpoint that is not a browser push service, and persists nothing", async () => {
    const { subscribePush, prisma } = mods();
    const hostile = [
      `https://10.0.0.5:8443/it-push-${RUN}-ssrf`,
      `https://169.254.169.254/computeMetadata/v1/it-push-${RUN}`,
      `https://localhost/it-push-${RUN}`,
      `https://attacker.example.com/it-push-${RUN}`,
      `https://fcm.googleapis.com.attacker.example.net/fcm/send/it-push-${RUN}`,
    ];
    const before = (await auditRows()).length;
    for (const endpoint of hostile) {
      const result = await subscribePush({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });
      expect(result.ok, endpoint).toBe(false);
      if (!result.ok) expect(result.code, endpoint).toBe("VALIDATION");
    }
    expect(await prisma.pushSubscription.count({ where: { endpoint: { in: hostile } } })).toBe(0);
    expect((await auditRows()).length).toBe(before);
  });

  it("is NOT_FOUND, and writes nothing, while the VAPID keys are unset", async () => {
    const { subscribePush } = mods();
    hoisted.pushEnabled = false;
    const before = (await auditRows()).length;
    const result = await subscribePush({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_FOUND");
    expect(await pushRows()).toHaveLength(0);
    expect((await auditRows()).length).toBe(before);
  });
});
