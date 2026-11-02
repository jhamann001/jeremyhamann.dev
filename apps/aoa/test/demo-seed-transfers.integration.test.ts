// The demo seed's deals and asset-transfer workspace on real PostgreSQL, read through AoA's own readers under the
// app login as each persona: the transfers list in every lane, the work queue, Okafor's partial ACAT with its deal,
// tracker link, plan, paperwork, submission and history, Rossi's rejection, the deferral, the mailing report, the
// funnel, and the row security that admitted every write.
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

const PERSONAS = {
  jordan: { role: "OPERATIONS", email: "jordan.reyes@example.com" },
  helen: { role: "CLIENT_SERVICE", email: "helen.carver@example.com" },
  rachel: { role: "ADVISOR", email: "rachel.moss@example.com" },
  priya: { role: "ADMIN", email: "priya.nair@example.com" },
} as const;

RUN("demo seed: deals and the asset-transfer workspace", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let ids: { okafor: string; rossi: string; alvarez: string; okaforHousehold: string };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(DEMO_CONFIG)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    loopback(process.env.DATABASE_URL!, "app_rw");
    owner = new PrismaClient({ datasourceUrl: loopback(OWNER_URL!, "aoa") });
    ingest = new PrismaClient({ datasourceUrl: OWNER_URL!.replace("://aoa@", "://ingest_rw@") });
    const [{ held }] = await owner.$queryRaw<Array<{ held: bigint }>>`SELECT count(*) AS held FROM app.transfer`;
    if (held > 0n) throw new Error("DEMO_SEED_TEST_OWNER_URL must be a freshly migrated database");

    const { loadUniverse, storyTransferId } = await import("@/lib/demo/seed/universe");
    const { createSeedContext } = await import("@/lib/demo/seed/context");
    const { seedPeople } = await import("@/lib/demo/seed/people");
    const { seedTracker } = await import("@/lib/demo/seed/tracker");
    const { seedDeals } = await import("@/lib/demo/seed/deals");
    const { seedTransfers } = await import("@/lib/demo/seed/transfers");
    const ctx = createSeedContext(loadUniverse(), owner, ingest);
    await seedPeople(ctx);
    await seedTracker(ctx);
    await seedDeals(ctx);
    await seedTransfers(ctx);
    ids = {
      okafor: storyTransferId("T-298"), rossi: storyTransferId("T-299"), alvarez: storyTransferId("T-287"),
      okaforHousehold: ctx.householdId.get("okafor")!,
    };
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await owner?.$disconnect();
    await ingest?.$disconnect();
  });

  it("shows every lane and a working queue to every persona", async () => {
    const { getAssetTransferWorkspace } = await import("@/lib/data/asset-transfer-workspace");
    const { queueRows, queueCounts } = await import("@/lib/transfers/workspace-queue");
    for (const identity of Object.values(PERSONAS)) {
      const { transfers, activity } = await getAssetTransferWorkspace(identity);
      expect(new Set(transfers.map((t) => t.stage))).toEqual(new Set(["DECISION", "IN_TRANSFER", "FUNDED"]));
      expect(activity.length).toBeGreaterThan(100);
      const cs = queueCounts(queueRows(transfers, { query: "", team: "Client Service", stage: null }));
      const ops = queueCounts(queueRows(transfers, { query: "", team: "Operations", stage: null }));
      expect(cs.Ready + cs.Waiting).toBeGreaterThan(5);
      expect(ops.Ready).toBeGreaterThan(5);
      expect(transfers.some((t) => t.rejection?.status === "returned")).toBe(true);
    }
  });

  it("opens Okafor's partial ACAT with its deal, tracker link, plan, paperwork and history", async () => {
    const { getTransfer } = await import("@/lib/data/transfer-detail");
    const { getPaperworkRecords } = await import("@/lib/data/transfer-paperwork-store");
    const { getReceiptRecords } = await import("@/lib/transfers/receipt");
    const { getWorkspaceDetailRecords } = await import("@/lib/data/transfer-workspace-detail");
    const { getDeal } = await import("@/lib/data/deals");
    const { getAssetTransferWorkspace } = await import("@/lib/data/asset-transfer-workspace");
    const detail = await getTransfer(PERSONAS.rachel, ids.okafor);
    expect(detail?.transfer).toMatchObject({
      stage: "IN_TRANSFER", funding_type: "ACAT_PARTIAL", acat_record_id: "tr-t298", acat_transfer_id: "T-298",
      funding_plan_complete: true, funding_plan_version: 1,
    });
    const deal = await getDeal(PERSONAS.rachel, detail!.transfer.deal_id!);
    expect(deal).toMatchObject({ stage: "FUNDING", owner_name: "Rachel Moss", transferring_firm: "Edward Jones" });
    expect(detail!.decisions.find((d) => d.symbol === "BBGLX")?.decision).toBe("LEAVE_GIFT");
    const paperwork = await getPaperworkRecords(PERSONAS.helen, ids.okafor);
    expect(paperwork).toMatchObject({ sentPacketRecorded: true, returnedSignatureRecorded: true, latestStatement: { accepted: true } });
    const receipt = await getReceiptRecords(PERSONAS.jordan, ids.okafor);
    expect(receipt.latestSubmission?.controlNumber).toBe("CTL-10421");
    const { history } = await getWorkspaceDetailRecords(PERSONAS.jordan, ids.okafor);
    const actions = history.map((h) => h.action).reverse();
    expect(actions[0]).toBe("transfer.create");
    expect(actions.indexOf("transfer.funding_plan_approve")).toBeLessThan(actions.indexOf("transfer.submission_record"));
    expect(actions.indexOf("transfer.submission_record")).toBeLessThan(actions.indexOf("transfer.stage_change"));
    // The household page's transfers card reads the same workspace, narrowed to the household.
    const household = await getAssetTransferWorkspace(PERSONAS.rachel, { householdSfIds: [ids.okaforHousehold] });
    expect(household.transfers.map((t) => t.id)).toContain(ids.okafor);
  });

  it("keeps Rossi's rejection open for Operations' review and Alvarez funded with a full receipt", async () => {
    const { getFollowUpRecords } = await import("@/lib/transfers/follow-up");
    const { getReceiptRecords } = await import("@/lib/transfers/receipt");
    const rossi = await getFollowUpRecords(PERSONAS.jordan, ids.rossi);
    expect(rossi.rejections[0]).toMatchObject({ state: "awaiting_review", code: "Account title mismatch" });
    expect(rossi.arrivalPaused).toBe(true);
    const alvarez = await getReceiptRecords(PERSONAS.jordan, ids.alvarez);
    expect(alvarez.receipts[0]).toMatchObject({ version: 1, partial: false });
  });

  it("feeds the mailing report and the Command Center funnel", async () => {
    const { getMailingReport } = await import("@/lib/transfers/mailing");
    const { dealFunnel } = await import("@/lib/data/deal-funnel");
    expect((await getMailingReport(PERSONAS.helen)).length).toBeGreaterThanOrEqual(3);
    const funnel = await dealFunnel(PERSONAS.priya);
    for (const stage of ["Potential", "Potential-Committed", "Potential-In Process", "Funded"]) {
      expect(funnel.find((f) => f.stage === stage)?.count, stage).toBeGreaterThan(0);
    }
  });
});
