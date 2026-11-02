// The demo seed's funding work (lib/demo/seed/transfers-plan.ts), checked without a database: every movement is a
// transfer the app's own rules would hold (its deal at the stage the deal → transfer sync maps it to, inputs that
// pass the app's validators, steps in a possible order, nothing in the future) and every ACAT is the same transfer
// the Transfer Tracker's plan holds.
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { validateDealInput } from "@/lib/data/deal-validate";
import { DEAL_STAGE_TO_TRANSFER_STAGE } from "@/lib/data/transfer-sync";
import { createSeedContext } from "@/lib/demo/seed/context";
import { dealInput } from "@/lib/demo/seed/deals";
import { planDemoTransfers } from "@/lib/demo/seed/tracker-plan";
import { buildFundingWork, cuidFor, planFundingWork, type Movement } from "@/lib/demo/seed/transfers-plan";
import { loadUniverse, storyDealId, storyTrackerId, storyTransferId } from "@/lib/demo/seed/universe";

const universe = loadUniverse();
// A weekday morning and a Monday before the working day (the plan squeezes nothing; days only).
const NOWS = [new Date("2026-10-30T15:00:00Z"), new Date("2026-11-02T11:30:00Z")];
const ctx = createSeedContext(universe, {} as PrismaClient, {} as PrismaClient, NOWS[0]);
const work = planFundingWork(ctx);

const days = (m: Movement) => [
  m.created, m.clientRequest?.day, m.statement?.day, m.match, m.receivingOpen, m.plan?.day, m.formReview, m.sentPacket,
  m.returnedSignature, m.appAuthorization, m.mailedPaperwork, m.drsServiceRequest, m.mailing?.day, m.submission?.day,
  m.inTransfer?.day, m.accepted, ...m.tracking.map((t) => t.day), m.rejection?.day, m.rejection?.response?.day,
  m.checkTicket?.day, m.achInitiation?.day, m.cashInFlight, m.receipt?.day, m.funded?.day, m.feeReimbursement,
  m.residual?.day, m.outcome?.day, m.archived?.day, ...m.extraTasks.map((t) => t.day),
].filter((d): d is string => d != null);

describe("demo seed: the firm's funding work", () => {
  it("is the same plan for the same day", () => {
    const again = buildFundingWork(universe, NOWS[0], ctx.today);
    expect(again.movements.map((m) => [m.transferId, m.dealSfId, m.value, m.stage])).toEqual(
      work.movements.map((m) => [m.transferId, m.dealSfId, m.value, m.stage]),
    );
  });

  it("holds every universe transfer story under its shared ids", () => {
    for (const story of universe.stories.transfers) {
      const m = work.movements.find((x) => x.storyId === story.id);
      expect(m, story.id).toBeDefined();
      expect(m!.transferId).toBe(storyTransferId(story.id));
      expect(m!.dealSfId).toBe(storyDealId(story.id));
      expect(m!.trackerId).toBe(storyTrackerId(story.id));
      expect(m!.household.id).toBe(story.household);
      expect(m!.value).toBe(story.value);
    }
    const stageOf = (id: string) => work.movements.find((m) => m.storyId === id)!.stage;
    expect(stageOf("T-311")).toBe("DECISION");
    expect(stageOf("T-298")).toBe("IN_TRANSFER");
    expect(stageOf("T-287")).toBe("FUNDED");
    const okafor = work.movements.find((m) => m.storyId === "T-298")!;
    expect(okafor.fundingType).toBe("ACAT_PARTIAL");
    expect(okafor.plan?.decisions?.find((d) => d.symbol === "BBGLX")).toMatchObject({ decision: "LEAVE_GIFT", liquidate: true });
    const rossi = work.movements.find((m) => m.storyId === "T-299")!;
    expect(rossi.rejection?.reason).toMatch(/Jr\./);
  });

  it("gives every in-flight inbound ACAT in the tracker's book a transfer with the tracker's facts", () => {
    for (const now of NOWS) {
      const day = createSeedContext(universe, {} as PrismaClient, {} as PrismaClient, now).today;
      const plan = buildFundingWork(universe, now, day);
      const tracker = planDemoTransfers(universe, now).transfers;
      const open = tracker.filter((t) => t.direction === "In" && !["Completed", "Rejected", "Canceled", "Deferred", "Purged"].includes(t.status));
      for (const t of open) {
        const m = plan.movements.find((x) => x.trackerId === t.id);
        expect(m, t.id).toBeDefined();
        expect(m!.account.id).toBe(t.account.id);
        expect(m!.value).toBe(t.value);
        expect(m!.firm).toBe(t.firm.name);
        if (m!.submission) expect(m!.submission.control).toBe(t.controlNumber);
      }
      // An outgoing transfer is not money arriving: no transfer for it.
      for (const t of tracker.filter((x) => x.direction === "Out")) {
        expect(plan.movements.some((m) => m.trackerId === t.id)).toBe(false);
      }
    }
  });

  it("puts each deal at the stage its transfer implies, by the sync's own map", () => {
    for (const m of work.movements) {
      if (m.archived) expect(m.deal.stage, m.key).toBe("LOST");
      else if (m.syncFlag) expect(m.deal.stage, m.key).toBe("POTENTIAL");
      else {
        const stage = m.deal.stage as keyof typeof DEAL_STAGE_TO_TRANSFER_STAGE;
        expect(DEAL_STAGE_TO_TRANSFER_STAGE[stage], m.key).toBe(m.stage);
      }
      expect(m.deal.amount).toBe(m.value);
      expect(m.deal.sfDealId).toBe(m.dealSfId);
    }
  });

  it("writes deals the CRM import would accept", () => {
    const all = [...work.movements.map((m) => m.deal), ...work.pipelineDeals];
    for (const deal of all) {
      const result = validateDealInput(dealInput(ctx, deal));
      expect(result.errors, deal.sfDealId).toEqual([]);
    }
    expect(new Set(all.map((d) => d.sfDealId)).size).toBe(all.length);
    expect(new Set(all.map((d) => d.stage))).toEqual(new Set(["POTENTIAL", "COMMITTED", "FUNDING", "WON", "LOST"]));
  });

  it("orders each transfer's steps and never dates one after today", () => {
    for (const m of work.movements) {
      for (const d of days(m)) expect(d <= ctx.today, `${m.key} ${d}`).toBe(true);
      if (m.plan && m.submission) expect(m.plan.day <= m.submission.day, m.key).toBe(true);
      if (m.submission && m.inTransfer) expect(m.submission.day <= m.inTransfer.day, m.key).toBe(true);
      if (m.inTransfer && m.funded) expect(m.inTransfer.day <= m.funded.day, m.key).toBe(true);
      if (m.stage !== "DECISION") expect(m.inTransfer, m.key).toBeDefined();
      if (m.stage === "FUNDED") {
        expect(m.funded && m.plan, m.key).toBeTruthy();
        // Funded needs a confirmed (not partial) receipt on the ACAT routes.
        if (m.fundingType === "ACAT_FULL" || m.fundingType === "ACAT_PARTIAL") expect(m.receipt?.partial, m.key).toBeUndefined();
      }
      // The submission log and receipt belong to the ACAT routes.
      if (m.submission || m.receipt) expect(["ACAT_FULL", "ACAT_PARTIAL"]).toContain(m.fundingType);
    }
  });

  it("uses production's id shapes, never the old development seed's DEMO- ones outside the stories", () => {
    for (const m of work.movements.filter((x) => !x.storyId)) {
      expect(m.transferId).toMatch(/^c[0-9a-z]{24}$/);
      expect(m.dealSfId).toMatch(/^006[A-Za-z0-9]{15}$/);
    }
    expect(cuidFor("a")).toBe(cuidFor("a"));
    expect(new Set(work.movements.map((m) => m.transferId)).size).toBe(work.movements.length);
  });

  it("covers every lane, funding route and owner the workspace shows", () => {
    const live = work.movements.filter((m) => !m.archived);
    expect(new Set(live.map((m) => m.stage))).toEqual(new Set(["DECISION", "IN_TRANSFER", "FUNDED"]));
    expect(new Set(live.map((m) => m.fundingType))).toEqual(new Set(["ACAT_FULL", "ACAT_PARTIAL", "DRS", "MANUAL", "CHECK", "WIRE", "ACH"]));
    expect(new Set(live.map((m) => m.owner.kind))).toEqual(new Set(["OPERATIONS", "CLIENT_SERVICE", "ADVISOR"]));
    expect(live.some((m) => m.outcome?.outcome === "Deferred")).toBe(true);
    expect(live.some((m) => m.receipt?.partial)).toBe(true);
    expect(work.movements.some((m) => m.archived)).toBe(true);
  });
});
