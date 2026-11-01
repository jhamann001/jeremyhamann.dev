/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * `pruneGoneSubscription` is the reason CONTRACT §1.4 lets `PushSubscription` be hard-deleted, so
 * what it does is worth proving against a real database rather than a mock: the row really is gone,
 * the `PUSH_UNSUBSCRIBED` row really is written in the SAME transaction, and it carries a hash of
 * the endpoint rather than the endpoint — which is a bearer capability (CONTRACT §3.3 rule 2).
 *
 * It is written by the SYSTEM actor because nobody asked for it: the 410 arrives during a dispatch
 * run, hours after the browser was uninstalled.
 *
 * Every assertion is scoped to the rows this run created, by subscription id and by endpoint.
 */
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_prune_ops_${RUN}`;
const ENDPOINT = `https://updates.push.services.mozilla.com/wpush/v2/it-prune-${RUN}`;
const P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const pruneModule = TEST_URL ? await import("@/lib/web-push/prune") : null;

function mods() {
  if (!dbModule || !pruneModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...pruneModule };
}

describe.skipIf(!TEST_URL)("pruneGoneSubscription (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { isActive: true },
      create: {
        id: USER_ID,
        email: `prune.ops.${RUN}@wm-helpdesk.local`,
        name: "Otto Ops",
        groups: ["ops_team"],
        isActive: true,
        emailVerified: new Date(),
      },
    });
    await prisma.pushSubscription.deleteMany({ where: { endpoint: ENDPOINT } });
  });

  it("deletes the row and records it under the SYSTEM actor, with a hash and not the URL", async () => {
    const { prisma, pruneGoneSubscription } = mods();
    const created = await prisma.pushSubscription.create({
      data: { userId: USER_ID, endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, userAgent: "it-prune" },
      select: { id: true },
    });

    await expect(pruneGoneSubscription(ENDPOINT)).resolves.toBe(true);
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: ENDPOINT } })).toBeNull();

    const rows = await prisma.auditLog.findMany({
      where: { entityType: "PUSH_SUBSCRIPTION", entityId: created.id },
      orderBy: { seq: "asc" },
      select: { action: true, actorEmail: true, actorId: true, fieldChanged: true, newValue: true, metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("PUSH_UNSUBSCRIBED");
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].actorEmail).toBe("system@wm-helpdesk.local");
    expect(rows[0].fieldChanged).toBe("endpoint");
    expect(rows[0].newValue).toBe(createHash("sha256").update(ENDPOINT, "utf8").digest("hex"));
    expect(JSON.stringify(rows[0])).not.toContain(`it-prune-${RUN}`);
    expect((rows[0].metadata as { reason?: string; service?: string }).reason).toBe("GONE");
    expect((rows[0].metadata as { service?: string }).service).toBe("updates.push.services.mozilla.com");
  });

  it("is a no-op, with no audit row, for an endpoint that is already gone", async () => {
    const { prisma, pruneGoneSubscription } = mods();
    const missing = `${ENDPOINT}-never-existed`;
    await expect(pruneGoneSubscription(missing)).resolves.toBe(false);
    // Scoped to this endpoint's own hash: the table is permanent and other files run concurrently.
    const hash = createHash("sha256").update(missing, "utf8").digest("hex");
    expect(await prisma.auditLog.count({ where: { action: "PUSH_UNSUBSCRIBED", newValue: hash } })).toBe(0);
  });
});
