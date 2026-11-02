// The demo seed's Trade Requests on real PostgreSQL, read and changed through AoA's own in-app backend under the app
// login: the queue, a request's detail, the bells, a trader's status change (audit, the advisor's bell, the Slack post
// in the Outbox), an advisor's new request, the household projection and the transfer's linked request.
// Opt-in: DEMO_SEED_TEST_OWNER_URL is the owner login of a freshly migrated loopback database, and DATABASE_URL the
// app login to the same one. It seeds that database, so point it at a throwaway copy.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

const OWNER_URL = process.env.DEMO_SEED_TEST_OWNER_URL;
const RUN = OWNER_URL && process.env.DATABASE_URL ? describe : describe.skip;

// The deploy's settings (demo mode, the flags), as the app runs with them; set for this suite only.
const DEMO_CONFIG = JSON.parse(readFileSync(new URL("../demo-config.json", import.meta.url), "utf8")) as Record<string, string>;
const savedEnv: Record<string, string | undefined> = {};

function loopback(raw: string, user: string): string {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== user) throw new Error("loopback_demo_seed_database_required");
  return raw;
}

type Actor = { aoaUserId: string; email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const ACTORS: Record<string, Actor> = {
  rachel: { aoaUserId: "", email: "rachel.moss@example.com", name: "Rachel Moss", role: "ADVISOR" },
  jordan: { aoaUserId: "", email: "jordan.reyes@example.com", name: "Jordan Reyes", role: "OPERATIONS" },
  ethan: { aoaUserId: "", email: "ethan.cole@example.com", name: "Ethan Cole", role: "OPERATIONS" },
  priya: { aoaUserId: "", email: "priya.nair@example.com", name: "Priya Nair", role: "ADMIN" },
};

RUN("demo seed: Trade Requests on the in-app backend", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let call: (op: string, method: string, path: string, actor: Actor, extra?: { body?: unknown; query?: Record<string, string> }) => Promise<{ ok: boolean; status?: number; data?: any }>;
  let okafor: string[];

  beforeAll(async () => {
    for (const [k, v] of Object.entries(DEMO_CONFIG)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    loopback(process.env.DATABASE_URL!, "app_rw");
    owner = new PrismaClient({ datasourceUrl: loopback(OWNER_URL!, "aoa") });
    ingest = new PrismaClient({ datasourceUrl: OWNER_URL!.replace("://aoa@", "://ingest_rw@") });
    const [{ held }] = await owner.$queryRaw<Array<{ held: bigint }>>`SELECT count(*) AS held FROM trade_request.users`;
    if (held > 0n) throw new Error("DEMO_SEED_TEST_OWNER_URL must be a freshly migrated database");

    const { loadUniverse, membersOf, storyTransferId, cedarRidgeUserId } = await import("@/lib/demo/seed/universe");
    const { createSeedContext } = await import("@/lib/demo/seed/context");
    const { seedPeople } = await import("@/lib/demo/seed/people");
    const { seedTradeRequests } = await import("@/lib/demo/seed/trade-requests");
    const universe = loadUniverse();
    const ctx = createSeedContext(universe, owner, ingest);
    await seedPeople(ctx);
    // The transfers part's story transfer this suite links to, until both run together.
    const okaforStory = universe.stories.transfers.find((t) => t.household === "okafor")!;
    await owner.$executeRaw`INSERT INTO app.transfer (id, source, client_first_name, client_last_name, value, updated_at)
      VALUES (${storyTransferId(okaforStory.id)}, 'APP', 'Kofi', 'Okafor', ${okaforStory.value}, now())`;
    await seedTradeRequests(ctx);
    okafor = membersOf(universe, "okafor").map((p) => cedarRidgeUserId(p.id));

    for (const actor of Object.values(ACTORS)) {
      actor.aoaUserId = (await owner.user.findUniqueOrThrow({ where: { email: actor.email } })).id;
    }
    const { loadNativeHandlers } = await import("@/lib/trade-requests/native");
    const { nativeHandlerFor } = await import("@/lib/trade-requests/native/registry");
    await loadNativeHandlers();
    call = async (op, method, path, actor, extra = {}) => {
      const handler = nativeHandlerFor(op as never);
      if (!handler) throw new Error(`no native handler: ${op}`);
      return (await handler({ operation: op as never, method: method as never, path: path as `/${string}`, defaultMessage: "failed", ...extra }, actor)) as never;
    };
  }, 120_000);

  afterAll(async () => {
    const { prisma } = await import("@/lib/db");
    await Promise.all([owner?.$disconnect(), ingest?.$disconnect(), prisma.$disconnect()]);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("serves from AoA: the queue lists the twenty shared requests and the three only it holds, newest first, with their counts", async () => {
    const { isAoaServed } = await import("@/lib/trade-requests/serving-state");
    expect(await isAoaServed()).toBe(true);
    const list = await call("listRequests", "GET", "/requests", ACTORS.jordan, { query: { limit: "50" } });
    expect(list.ok).toBe(true);
    expect(list.data.data.map((r: { id: string }) => r.id).slice(0, 3)).toEqual(["REQ-00001046", "REQ-00001045", "REQ-00001043"]);
    expect(list.data.data).toHaveLength(23);
    // The three older funding requests only this demo holds (seed/trade-requests-own.ts) come last.
    expect(list.data.data.map((r: { id: string }) => r.id).slice(-3).sort()).toEqual(["REQ-00000901", "REQ-00000902", "REQ-00000903"]);
    const counts = await call("requestCounts", "GET", "/requests/counts", ACTORS.rachel);
    expect(counts.data).toEqual({ total: 23, pendingReview: 3, needsInfo: 2, approved: 15 });
  });

  it("opens Okafor's rebalance with its accounts, allocation and history", async () => {
    const detail = await call("requestDetail", "GET", "/requests/REQ-00001045", ACTORS.rachel);
    const r = detail.data.data;
    expect([r.tradeType, r.status, r.clientNames, r.householdName, r.riskProfile]).toEqual([
      "Rebalance", "Pending Review", ["Kofi Okafor", "Ada Okafor"], "Okafor Household", 19,
    ]);
    expect(r.selectedAccounts).toEqual(["DEMO-142290"]);
    expect(r.auditLog.map((a: { action: string }) => a.action)).toEqual(["Created Request"]);
    const clients = await call("clientList", "GET", "/clients", ACTORS.rachel);
    // Every account's primary owner, and each second member with an account of their own (seed/own-accounts.ts).
    expect(clients.data.data).toHaveLength(58);
    const kofi = clients.data.data.find((c: { id: string }) => c.id === okafor[0]);
    expect(kofi.accounts.map((a: { accountNumber: string }) => a.accountNumber)).toEqual(["DEMO-142290"]);
    const exclusions = await call("accountExclusionsLookup", "POST", "/clients/account-exclusions/bulk", ACTORS.rachel, { body: { accountIds: [kofi.accounts[0].id] } });
    expect(exclusions.data.data[kofi.accounts[0].id].map((e: { ticker: string }) => e.ticker)).toEqual(["AAPL"]);
  });

  it("rings the bells: the traders' new-request notices and the advisors' status updates", async () => {
    const jordan = await call("notificationsList", "GET", "/notifications", ACTORS.jordan);
    expect(jordan.data.unreadCount).toBe(3);
    expect(jordan.data.data[0].message).toBe("New trade request REQ-00001046 submitted for Lucia Alvarez");
    const rachel = await call("notificationsList", "GET", "/notifications", ACTORS.rachel);
    expect(rachel.data.data.filter((n: { isRead: boolean }) => !n.isRead).map((n: { message: string }) => n.message))
      .toContain("Trade request REQ-00001041 status updated to: Pending Current Asset Liquidation");
    const priya = await call("notificationsList", "GET", "/notifications", ACTORS.priya);
    expect(priya.data).toEqual({ data: [], unreadCount: 0 });
  });

  it("lets a trader change a status, recorded with an audit row, the advisor's bell and the Slack post in the Outbox", async () => {
    const before = await call("requestDetail", "GET", "/requests/REQ-00001043", ACTORS.ethan);
    const [{ outbox }] = await owner.$queryRaw<Array<{ outbox: bigint }>>`SELECT count(*) AS outbox FROM demo.outbox_message`;
    const refused = await call("statusChange", "PUT", "/requests/REQ-00001045/status", ACTORS.rachel, {
      body: { status: "Approved", note: "", expectedUpdatedAt: before.data.data.updatedAt },
    });
    expect(refused.ok).toBe(false);
    const changed = await call("statusChange", "PUT", "/requests/REQ-00001045/status", ACTORS.ethan, {
      body: { status: "Approved", note: "Model rebalance approved.", expectedUpdatedAt: (await call("requestDetail", "GET", "/requests/REQ-00001045", ACTORS.ethan)).data.data.updatedAt },
    });
    expect(changed.ok).toBe(true);
    expect(changed.data.data.status).toBe("Approved");
    expect(changed.data.data.auditLog[0]).toMatchObject({ user: "Ethan Cole", action: "Status changed to Approved", channel: "aoa" });
    await vi.waitFor(async () => {
      const [{ bells }] = await owner.$queryRaw<Array<{ bells: bigint }>>`
        SELECT count(*) AS bells FROM trade_request.notifications n JOIN trade_request.users u ON u.id = n.user_id
         WHERE u.email = 'rachel.moss@example.com' AND n.request_id = 'REQ-00001045' AND n.body LIKE '%Approved%'`;
      expect(bells).toBe(1n);
      const [{ after }] = await owner.$queryRaw<Array<{ after: bigint }>>`SELECT count(*) AS after FROM demo.outbox_message`;
      expect(after).toBe(outbox + 1n);
    }, { timeout: 10_000 });
  });

  it("lets an advisor submit a new request that shows on the household", async () => {
    const created = await call("createRequest", "POST", "/requests", ACTORS.rachel, {
      body: {
        clientId: okafor[0], clientName: "Kofi Okafor", tradeType: "Raise Cash", tradeAmount: "15000",
        selectedAccounts: ["DEMO-142290"], priority: "Standard", raiseCashReason: "Client distribution",
        accountsData: [{ accountNumber: "DEMO-142290", accountType: "Joint", balance: 412880 }],
      },
    });
    expect(created.ok).toBe(true);
    const id = created.data.data.id;
    const { getAuthoritativeTradeRequestsForUsers, getTradeRequestsForUsers } = await import("@/lib/data/trade-requests");
    const onHousehold = (await getTradeRequestsForUsers(okafor)).map((r) => r.id);
    expect(onHousehold).toEqual(expect.arrayContaining([id, "REQ-00001045"]));
    expect(onHousehold).not.toContain("REQ-00001046");
    // The review queue reads the same projection and accepts only authoritative rows.
    const strict = await getAuthoritativeTradeRequestsForUsers(okafor);
    expect(strict.find((r) => r.id === "REQ-00001045")).toMatchObject({ householdId: 1002, householdName: "Okafor Household", status: "Approved" });
  });

  it("links Okafor's rebalance to the T-298 transfer's follow-up", async () => {
    const { withUserScope } = await import("@/lib/rls");
    const { readFollowUpRecords } = await import("@/lib/transfers/follow-up");
    const { storyTransferId } = await import("@/lib/demo/seed/universe");
    const records = await withUserScope({ role: "OPERATIONS", email: ACTORS.jordan.email }, (tx) => readFollowUpRecords(tx, storyTransferId("T-298")));
    expect(records.investmentRequestId).toBe("REQ-00001045");
  });

  it("keeps client service out of the workspace, as production does", async () => {
    const { canUseTradeRequestsWorkspace } = await import("@/lib/trade-requests/access");
    expect(canUseTradeRequestsWorkspace("CLIENT_SERVICE")).toBe(false);
    expect(["ADMIN", "OPERATIONS", "ADVISOR"].every(canUseTradeRequestsWorkspace)).toBe(true);
  });
});
