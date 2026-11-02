import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
vi.mock("server-only", () => ({}));
import { historicalCandidatePresentation, historicalCohort, historicalCohortWhere, historicalFundingLane, readTrackerDirectoryLabels } from "@/lib/data/acat-reconciliation/historical-presentation";
import * as historicalPolicy from "@/lib/data/acat-historical-review";
import { makeHistoricalAcatIntent } from "@/lib/data/acat-historical-review";
import { snapshot, sourceRecord, targetRecord } from "./fixtures";
const target = () => ({ ...targetRecord(), existingTransferUuid: null, fundingType: "ACAT_FULL", hold: true, stage: "FUNDED" });
const record = () => ({ ...sourceRecord(), workflow: "ACAT", status: "Completed" });
const intent = () => makeHistoricalAcatIntent([], []);

describe("historical presentation without matching authority", () => {
  it.each([["ACAT_FULL", "known_acat"], ["ACAT_PARTIAL", "known_acat"], ["WIRE", "not_applicable"], ["ACH", "not_applicable"], ["CHECK", "not_applicable"], ["MANUAL", "not_applicable"], [null, "evidence_needed"]] as const)("classifies %s without changing it", (funding, lane) => {
    expect(historicalFundingLane(funding)).toBe(lane);
  });
  it("uses explicit current hold/unlinked scope for every cohort", () => {
    for (const cohort of ["known_acat", "not_applicable", "evidence_needed"] as const) expect(historicalCohortWhere(cohort)).toMatchObject({ archived_at: null, acat_auto_link_hold: true, acat_record_id: null, acat_transfer_id: null });
    expect(historicalCohortWhere("not_applicable").funding_type).toEqual({ not: null, notIn: ["ACAT_FULL", "ACAT_PARTIAL"] });
    expect(historicalCohortWhere("evidence_needed").funding_type).toBe(null);
    expect(historicalCohort("__proto__")).toBe("all");
  });
  it("shows related records with policy blockers, but excludes other people and does not select one", () => {
    const t = target(); const r = record();
    const result = historicalCandidatePresentation(snapshot([r, { ...r, recordId: "other", cedarRidgeUserIds: ["someone-else"], acatTransferId: null }, { ...r, recordId: "joint", cedarRidgeUserIds: ["synthetic-person", "joint-person"], acatTransferId: null }]), [t], t, intent());
    expect(result.records.map((row) => [row.record.recordId, row.blocker])).toEqual([["joint", "incomplete_joint_evidence"], [r.recordId, null]]);
    expect(result.selected).toBeUndefined();
  });
  it.each(["Canceled", "Rejected", "Purged"])("explains %s as ineligible", (status) => {
    const t = target(); const r = { ...record(), status };
    expect(historicalCandidatePresentation(snapshot([r]), [t], t, intent()).records[0].blocker).toBe("ineligible_source_lifecycle");
  });
  it.each(["MISSING_ACCOUNT", "ACCOUNT_UNRESOLVED"] as const)("explains receiving account state %s without an override", (verification) => {
    const t = target(); const r = record(); r.receivingAccount = { ...r.receivingAccount, verification };
    const result = historicalCandidatePresentation(snapshot([r]), [t], t, intent()).records[0];
    expect(result.blocker).toBe("missing_identity"); expect(result.message).toContain(verification === "MISSING_ACCOUNT" ? "account is missing" : "could not be resolved");
  });
  it("classifies at most one page plus the selected lead while retaining all 5000 records and reservations", () => {
    const t = target(); const records = Array.from({ length: 5000 }, (_, i) => ({ ...record(), recordId: `record-${String(i).padStart(4, "0")}`, acatTransferId: null }));
    const targets = Array.from({ length: 5000 }, (_, i) => ({ ...t, transferId: `target-${i}` }));
    const source = snapshot(records); const policy = vi.spyOn(historicalPolicy, "historicalAcatPairBlocker");
    try {
      const result = historicalCandidatePresentation(source, targets, targets[0], intent(), { page: 2, selectedRecordId: "record-4999" });
      expect(result.total).toBe(5000); expect(result.page).toBe(2); expect(result.records).toHaveLength(20);
      expect(result.records[0].record.recordId).toBe("record-0020"); expect(result.selected?.record.recordId).toBe("record-4999");
      expect(policy).toHaveBeenCalledTimes(21);
      for (const call of policy.mock.calls) { expect(call[0]).toBe(source); expect(call[1]).toBe(targets); }
    } finally { policy.mockRestore(); }
  });
  it("requires prior intent and does not use an absent identity as an unrestricted search", () => {
    const t = target(); const r = record();
    expect(historicalCandidatePresentation(snapshot([r]), [t], t, null)).toMatchObject({ records: [], message: expect.stringContaining("history could not be verified") });
    const missing = { ...t, identityState: "missing" as const, canonicalClientUserIds: [] };
    expect(historicalCandidatePresentation(snapshot([r]), [missing], missing, intent()).records).toEqual([]);
  });
});

describe("bounded role-scoped directory display", () => {
  const tx = (rows: unknown[]) => ({ $queryRaw: vi.fn().mockResolvedValue(rows) }) as unknown as Prisma.TransactionClient;
  const row = (user = "synthetic-person", contact = "003SYNTHETIC123", name = "Synthetic Client") => ({ user_id: user, contact_key: contact, name });
  it("projects a display name without exposing server identity keys", async () => {
    const db = tx([row()]);
    const labels = await readTrackerDirectoryLabels(db, [record()]);
    expect([...labels]).toEqual([["synthetic-record", "Client directory: Synthetic Client"]]);
    expect(JSON.stringify([...labels])).not.toContain("synthetic-person");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it("accepts duplicate width aliases only when both contact key and name agree", async () => {
    expect((await readTrackerDirectoryLabels(tx([row(), row()]), [record()])).get("synthetic-record")).toBe("Client directory: Synthetic Client");
    expect((await readTrackerDirectoryLabels(tx([row(), row(undefined, "different-contact")]), [record()])).get("synthetic-record")).toContain("conflicting entries");
    expect((await readTrackerDirectoryLabels(tx([row(), row(undefined, undefined, "Other Name")]), [record()])).get("synthetic-record")).toContain("conflicting entries");
  });
  it("does not collapse joint labels to the first person or hide a missing holder name", async () => {
    const joint = { ...record(), cedarRidgeUserIds: ["synthetic-person", "second-person"] };
    expect((await readTrackerDirectoryLabels(tx([row(), row("second-person", "003CEUAXT040715", "Second Client")]), [joint])).get(joint.recordId)).toBe("Client directory: Synthetic Client / Second Client");
    expect((await readTrackerDirectoryLabels(tx([row()]), [joint])).get(joint.recordId)).toContain("name unavailable");
  });
  it("withholds an overflowing query instead of silently choosing the first name", async () => {
    expect((await readTrackerDirectoryLabels(tx(Array.from({ length: 1001 }, () => row())), [record()])).size).toBe(0);
    const db = tx([]);
    expect((await readTrackerDirectoryLabels(db, [{ ...record(), cedarRidgeUserIds: Array.from({ length: 1001 }, (_, i) => `synthetic-${i}`) }])).size).toBe(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it("does not query for an empty record population", async () => {
    const db = tx([]); expect((await readTrackerDirectoryLabels(db, [])).size).toBe(0); expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
