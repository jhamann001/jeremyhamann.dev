// The demo Outbox on real PostgreSQL: the app login adds and reads messages, and can never change or remove one. Reads
// are under row security: admin and operations read every message, anyone else only the messages about a household or
// client their own row security shows them, and a read outside a user scope finds nothing. Runs only against a loopback
// database with the owner cleanup URL set (the database job's settings).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));
import { listOutbox, recordOutbox } from "@/lib/demo/outbox";

const RUN = process.env.DATABASE_URL && process.env.AUDIT_TEST_CLEANUP_URL ? describe : describe.skip;
const TAG = "S3 integration";
const ADVISOR = "s3-outbox-advisor@example.test";
const HOUSEHOLD = "001S3OUTBOXHH0001";
const CLIENT = "003S3OUTBOXCL0001";
const CLIENT_USER = "user-s3-outbox-client";

function loopback(raw: string, user: string): string {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== user) {
    throw new Error("loopback_demo_outbox_database_required");
  }
  return raw;
}

RUN("demo Outbox under the app login", () => {
  let app: PrismaClient;
  let owner: PrismaClient;

  beforeAll(() => {
    app = new PrismaClient({ datasourceUrl: loopback(process.env.DATABASE_URL!, "app_rw") });
    owner = new PrismaClient({ datasourceUrl: loopback(process.env.AUDIT_TEST_CLEANUP_URL!, "aoa") });
  });
  afterAll(async () => {
    if (owner) {
      await owner.$executeRaw`DELETE FROM demo.outbox_message WHERE title LIKE ${`${TAG}%`}`;
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${CLIENT}`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${HOUSEHOLD}`;
    }
    await Promise.all([app?.$disconnect(), owner?.$disconnect()]);
  });

  /** Reads the Outbox as `role`/`email`, the way withUserScope sets the session. */
  const readAs = (role: string, email: string) => app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true), set_config('app.user_email', ${email}, true)`;
    return (await listOutbox(tx as unknown as Prisma.TransactionClient, 200)).filter((m) => m.title.startsWith(TAG));
  });

  it("adds a message and reads it back, newest first", async () => {
    await recordOutbox(app, { channel: "Slack", destination: "#trade-requests", title: `${TAG} first`, detail: "", body: "a" });
    await recordOutbox(app, { channel: "Slack", destination: "#operations", title: `${TAG} second`, detail: "d", body: "b".repeat(9000) });
    const mine = await readAs("ADMIN", "admin@example.test");
    expect(mine.map((m) => m.title)).toEqual([`${TAG} second`, `${TAG} first`]);
    expect(mine[0]).toMatchObject({ channel: "Slack", destination: "#operations", detail: "d" });
    expect(mine[0].body).toHaveLength(8000);
    expect(new Date(mine[0].createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("can't change or remove a message", async () => {
    await expect(app.$executeRaw`UPDATE demo.outbox_message SET title = 'changed' WHERE title LIKE ${`${TAG}%`}`)
      .rejects.toThrow(/permission denied/);
    await expect(app.$executeRaw`DELETE FROM demo.outbox_message WHERE title LIKE ${`${TAG}%`}`)
      .rejects.toThrow(/permission denied/);
  });

  it("holds the column limits in the database too", async () => {
    await expect(app.$executeRaw`
      INSERT INTO demo.outbox_message (channel, destination, title, detail, body)
      VALUES ('Slack', '#x', ${"t".repeat(201)}, '', '')`).rejects.toThrow(/check constraint/);
  });

  it("shows each reader only the messages its row security can see", async () => {
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email) VALUES (${HOUSEHOLD}, 'S3 Outbox Household', ${ADVISOR})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email, cedar_ridge_user_id)
      VALUES (${CLIENT}, ${HOUSEHOLD}, 'S3', 'Client', ${ADVISOR}, ${CLIENT_USER})`;
    const add = (title: string, about?: Parameters<typeof recordOutbox>[1]["about"]) =>
      recordOutbox(app, { channel: "Slack", destination: "#x", title: `${TAG} ${title}`, detail: "", body: "", about });
    await add("about the household", { householdSfId: HOUSEHOLD });
    await add("about the client", { clientSfId: CLIENT });
    await add("about the client by user id", { cedarRidgeUserId: CLIENT_USER });
    await add("about another book", { householdSfId: "001S3OUTBOXOTHER1", clientSfId: "003S3OUTBOXOTHER1" });
    await add("about no one");
    const titles = (rows: Array<{ title: string }>) => rows.map((m) => m.title.slice(TAG.length + 1)).filter((t) => t.startsWith("about")).sort();

    const everything = ["about another book", "about no one", "about the client", "about the client by user id", "about the household"];
    expect(titles(await readAs("ADMIN", "admin@example.test"))).toEqual(everything);
    expect(titles(await readAs("OPERATIONS", "ops@example.test"))).toEqual(everything);
    expect(titles(await readAs("ADVISOR", ADVISOR))).toEqual(["about the client", "about the client by user id", "about the household"]);
    expect(titles(await readAs("ADVISOR", "someone-else@example.test"))).toEqual([]);
    expect(titles(await readAs("CLIENT_SERVICE", "cs@example.test"))).toEqual(["about the client", "about the client by user id", "about the household"]);
    expect(titles(await readAs("VIEWER", "viewer@example.test"))).toEqual([]);
    // Outside a user scope the app login reads nothing.
    expect((await listOutbox(app, 200)).filter((m) => m.title.startsWith(TAG))).toEqual([]);
  });
});
