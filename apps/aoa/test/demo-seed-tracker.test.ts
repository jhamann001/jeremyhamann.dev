// The demo seed's Transfer Tracker part: the tracker demo's plan, ported (lib/demo/seed/tracker-plan.ts), written as
// the stand-in's records and client directory (tracker-records.ts), read back through the stand-in's own
// projections. Pure: no database.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pastBusinessInstant } from "@/lib/demo/seed/calendar";
import { accountOwners } from "@/lib/demo/seed/people";
import { firmCustodianId, planDemoTransfers } from "@/lib/demo/seed/tracker-plan";
import { trackerDirectory, trackerSeed } from "@/lib/demo/seed/tracker-records";
import { cedarRidgeUserId, loadUniverse, storyDealId } from "@/lib/demo/seed/universe";
import { composeDashboard } from "@/lib/demo/stand-ins/tracker-analytics";
import { linkageSnapshot } from "@/lib/demo/stand-ins/tracker-linkage";
import { advisorProjection, bookProjection, detailProjection, inFlightRecords } from "@/lib/demo/stand-ins/tracker-model";

const universe = loadUniverse();
const now = new Date("2026-11-02T15:30:00Z"); // a Monday afternoon in New York
const at = (day: string, key: string) => pastBusinessInstant(day, key, now);
const plan = planDemoTransfers(universe, now);
const seed = trackerSeed(universe, plan, now, at);
const byId = new Map(seed.records.map((r) => [r.id, r]));

describe("the tracker demo's plan", () => {
  it("is the same for the same clock and anchored on today's business day", () => {
    expect(planDemoTransfers(universe, now)).toEqual(plan);
    expect(plan.today).toBe("2026-11-02");
  });

  it("holds the nine stories, the history, its residuals and one in-flight transfer per working status", () => {
    const ids = plan.transfers.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => /^tr-t\d+$/.test(id))).toHaveLength(universe.stories.transfers.length);
    expect(ids.filter((id) => /^tr-h\d{3}$/.test(id))).toHaveLength(92);
    expect(ids.filter((id) => /^tr-o\d{2}$/.test(id))).toHaveLength(11);
    expect(ids.filter((id) => id.endsWith("-r")).length).toBeGreaterThan(0);
    const stories = Object.fromEntries(plan.transfers.filter((t) => t.storyId).map((t) => [t.storyId!, t.status]));
    expect(stories).toEqual({
      "T-311": "WaitingOnClient", "T-312": "WaitingOnClient", "T-305": "Submitted", "T-304": "Submitted", "T-298": "PendingSettlement",
      "T-301": "Accepted", "T-287": "Completed", "T-280": "Completed", "T-299": "Rejected",
    });
  });

  it("numbers transfers and control numbers without reusing a story's", () => {
    const transferIds = seed.records.map((r) => r.acatTransferId).filter(Boolean);
    expect(new Set(transferIds).size).toBe(transferIds.length);
    const controls = seed.records.map((r) => r.controlNumber).filter((c): c is string => !!c && c !== "To Come");
    expect(new Set(controls).size).toBe(controls.length);
    expect(byId.get("tr-t298")!.controlNumber).toBe("CTL-10421");
  });
});

describe("the stand-in's records", () => {
  it("carries the Okafor partial transfer as the tracker demo shows it", () => {
    const okafor = byId.get("tr-t298")!;
    expect(okafor).toMatchObject({
      acatTransferId: "T-298", status: "PendingSettlement", type: "Partial", transferringContra: "Edward Jones",
      custodianId: "cust-edj", custodianAvgProcessingDays: 5, statementAmount: 41288000, crmDealId: storyDealId("T-298"),
      wealthAdvisor: "Rachel",
    });
    expect(okafor.statementAccountNumber).toMatch(/^EDJ-\d{4}7781$/);
    expect(okafor.assets.map((a) => a.symbol)).toEqual(["VTI", "MSFT", "AAPL", "BND", "BBGLX", "CASH"]);
    expect(okafor.assets.find((a) => a.symbol === "BBGLX")).toMatchObject({ mappingTransferStatus: "Liquidate", includeInTransfer: true });
    expect(okafor.history[0].timestamp >= okafor.history[okafor.history.length - 1].timestamp).toBe(true);
  });

  it("links every record to its account's owners and the custodian library, and leaves a fee log on each", () => {
    for (const t of plan.transfers) {
      const r = byId.get(t.id)!;
      expect(r.cedarRidgeUserIds).toEqual(accountOwners(universe, t.account).map((p) => cedarRidgeUserId(p.id)).sort());
      expect(r.custodianId).toBe(firmCustodianId(t.firm));
      expect(r.crmDealId).toBe(t.storyId ? storyDealId(t.storyId) : "");
      expect(Array.isArray(r.feeLog)).toBe(true);
      if (t.direction === "Out") expect(r.statementAmount).toBeLessThan(0);
    }
    const credited = seed.records.filter((r) => r.feeCreditRequestId);
    expect(credited.length).toBe(seed.feeCredits.length);
    for (const r of credited) expect(r.feeLog!.map((row) => row.id)).toContain(r.feeCreditRequestId);
  });

  it("leaves the tracker demo's dashboard reviews on the exceptions they match", () => {
    expect(seed.reviews).toBe(seed.records.flatMap((r) => r.reviews).length);
    expect(seed.records.flatMap((r) => r.reviews).map((r) => r.ruleKey)).toContain("residual_sweep_missing");
  });

  it("reads through the stand-in's book, detail, advisor, in-flight and dashboard projections", () => {
    const nowMs = now.getTime();
    for (const r of seed.records) {
      expect(bookProjection(r, { ops: true, now: nowMs }).id).toBe(r.id);
      expect(detailProjection(r).id).toBe(r.id);
      expect(advisorProjection(r).custodian).not.toBeNull();
    }
    expect(inFlightRecords(seed.records, now).length).toBeGreaterThan(10);
    const dashboard = composeDashboard(seed.records, now);
    expect(dashboard.summary.total).toBe(seed.records.length);
  });
});

describe("the client directory", () => {
  const directory = trackerDirectory(universe);

  it("lists every universe person with the Apex accounts they hold", () => {
    expect(directory).toHaveLength(universe.people.length);
    const accounts = new Set(directory.flatMap((c) => c.accounts.map((a) => a.accountNumber)));
    expect(accounts.size).toBe(universe.accounts.length);
    const joint = universe.accounts.find((a) => a.type === "joint-taxable")!;
    const holders = directory.filter((c) => c.accounts.some((a) => a.accountNumber === joint.number));
    expect(holders.map((c) => c.accounts.find((a) => a.accountNumber === joint.number)!.relationshipType).sort()).toEqual(["JOINT", "PRIMARY"]);
  });

  it("resolves every record's receiving account in the transfer linkage snapshot", () => {
    vi.stubEnv("TRANSFER_LINKAGE_ENVIRONMENT", "production");
    const snapshot = linkageSnapshot(seed.records, directory, now)!;
    vi.unstubAllEnvs();
    expect(snapshot.recordCount).toBe(seed.records.length);
    const verification = snapshot.records.map((r: { receivingAccount: { verification: string } }) => r.receivingAccount.verification);
    // Single-owner accounts verify; joint accounts list their first owner as PRIMARY, as the tracker demo's directory
    // does, so the tracker's rule reads them as a holder mismatch in both demos.
    expect(verification.filter((v: string) => v !== "VERIFIED" && v !== "HOLDER_MISMATCH")).toEqual([]);
    expect(verification.filter((v: string) => v === "VERIFIED").length).toBeGreaterThan(seed.records.length / 2);
  });
});
