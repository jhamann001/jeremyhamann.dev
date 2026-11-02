import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(), scope: vi.fn(), config: vi.fn(), verify: vi.fn(), source: vi.fn(), targets: vi.fn(), intent: vi.fn(), detail: vi.fn(), focus: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/app/(authenticated)/acat-link-review/review-focus", () => ({ default: (props: unknown) => { m.focus(props); return null; } }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ acatAutoLinkReviewEnabled: m.enabled }));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/data/acat-match-source", () => ({ transferLinkageConfiguration: m.config, fetchTransferLinkageSnapshot: m.source, readAcatCandidatesWithinScope: m.targets }));
vi.mock("@/lib/data/acat-status", () => ({ getAcatStatusByRecordId: m.detail }));
vi.mock("@/lib/data/acat-historical-review", async (original) => ({ ...await original<typeof import("@/lib/data/acat-historical-review")>(), readHistoricalAcatIntentWithinScope: m.intent }));
vi.mock("@/lib/data/acat-reconciliation/verification", () => ({ verifyReconciliationRun: m.verify }));
vi.mock("@/app/(authenticated)/acat-link-review/actions", () => ({
  prepareAcatReview: vi.fn(), prepareAcatPair: vi.fn(), prepareHistoricalAcatPair: vi.fn(), reviewAcatDecision: vi.fn(), applyReviewedAcatDecision: vi.fn(), undoReviewedAcatDecision: vi.fn(),
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
import { snapshot, sourceRecord, targetRecord } from "./acat-reconciliation/fixtures";
import Page from "@/app/(authenticated)/acat-link-review/page";

const decision = { id: "decision-1", transfer_id: "transfer-1", record_id: "record-1", reason: "legacy_enrichment", action: "propose", disposition: "ACCEPT", review_version: 3, evidence_digest: "a".repeat(64), outcome: "PENDING", expected_target_version: 7, review_reason: null, reviewed_at: null, reviewed_by: null };
const historicalDecision = { ...decision, action: "review", reason: "missing_transaction_evidence", payload: { context: { historicalReview: {
  kind: "HISTORICAL_ACAT_REVIEW", version: 1, confirmation: "SAME_TRANSFER_KEEP_HOLD", intentDigest: "f".repeat(64),
  evidenceKind: "TRANSFER_DOCUMENT", evidenceReference: "DOC-123", correspondence: "A synthetic confirmation explicitly identifies both existing transfer records.",
} } } };
const tx = {
  acatLinkRun: { findMany: vi.fn() },
  acatLinkDecision: { count: vi.fn(), findMany: vi.fn() },
  transfer: { findMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn() },
  deal: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
};
async function html(params: Record<string, string> = {}) { return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ENV", "dev");
  vi.stubEnv("TRANSFER_TRACKER_URL", "https://tracker.example.invalid");
  m.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.invalid" } });
  m.enabled.mockReturnValue(true);
  tx.transfer.groupBy.mockResolvedValue([]); tx.transfer.findUnique.mockResolvedValue(null); tx.deal.findUnique.mockResolvedValue(null); tx.$queryRaw.mockResolvedValue([]);
  m.intent.mockResolvedValue({ rejections: [], linkClears: [], digest: "f".repeat(64) });
  m.detail.mockResolvedValue(null);
  m.scope.mockImplementation(async (_identity, callback) => callback(tx));
  m.config.mockReturnValue({ environment: "production", baseUrl: "https://tracker.example.invalid" });
  m.verify.mockResolvedValue({ manifestValid: true, outcomes: { APPLIED: 0, PENDING: 1, UNDONE: 0, NOOP: 0, CONFLICT: 0, BLOCKED: 0 }, linkStateDriftCount: 0, invalidOutcomeCount: 0, outcomeMetadataMissingCount: 0 });
  tx.acatLinkRun.findMany.mockResolvedValue([{ id: "run-1", created_at: new Date("2026-09-26T10:00:00Z"), source_count: 1, target_count: 1, status: "PREPARED" }]);
  tx.acatLinkDecision.count.mockResolvedValue(1);
  tx.acatLinkDecision.findMany.mockResolvedValue([decision]);
  tx.transfer.findMany.mockResolvedValue([{ id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client", stage: "IN_TRANSFER", funding_type: "ACAT_FULL", created_at: new Date("2026-09-20T12:00:00Z"), transferring_firm: null, acat_auto_link_hold: false, acat_link_version: 7 }]);
});

describe("ACAT review page", () => {
  it.each(["disabled", "viewer", "signed-out"])("%s cannot read saved evidence or source", async (kind) => {
    if (kind === "disabled") m.enabled.mockReturnValue(false);
    if (kind === "viewer") m.auth.mockResolvedValue({ user: { role: "VIEWER", email: "viewer@example.invalid" } });
    if (kind === "signed-out") m.auth.mockResolvedValue(null);
    await expect(html()).rejects.toThrow(kind === "signed-out" ? "REDIRECT" : "NOT_FOUND");
    expect(m.scope).not.toHaveBeenCalled();
    expect(m.source).not.toHaveBeenCalled();
  });

  it("renders linked navigation, bounded review controls and no private evidence payload", async () => {
    const output = await html();
    expect(output).toContain("Synthetic");
    expect(output).toContain('id="decision-decision-1"');
    expect(output).toContain("/asset-transfer/transfer-1");
    expect(output).toContain("https://tracker.example.invalid/records?open=record-1");
    expect(output).toContain("Apply confirmed link");
    expect(output).toContain("Hold automatic linking");
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0, select: expect.objectContaining({ payload: true }) }));
    expect(output).not.toContain("sourceAccountDigest");
    expect(output).not.toContain("cedarRidgeUserIds");
  });

  it.each(["CONFLICT", "BLOCKED"])("accepted %s decisions remain recoverable through full revalidation", async (outcome) => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, outcome }]);
    const output = await html();
    expect(output).toContain("Retry confirmed link");
    expect(output).not.toContain("Undo this link");
  });

  it("applied decisions expose conditional undo and no second apply", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, outcome: "APPLIED" }]);
    const output = await html();
    expect(output).toContain("Undo this link and hold automation");
    expect(output).not.toContain("Apply confirmed link");
  });

  it("does not use a production navigation fallback for a synthetic or unavailable source configuration", async () => {
    m.config.mockReturnValue({ environment: "synthetic", baseUrl: "https://synthetic.example.invalid" });
    expect(await html()).not.toContain("/records?open=");
    m.config.mockImplementation(() => { throw new Error("unconfigured"); });
    expect(await html()).not.toContain("/records?open=");
  });

  it("rounds fractional pages down before querying Prisma", async () => {
    tx.acatLinkDecision.count.mockResolvedValue(101);
    await html({ page: "2.8" });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50 }));
  });
  it("shows separate saved populations and never presents all storage rows as pending matches", async () => {
    const categories = { linked: 5, held: 242, proposed: 0, review: 0, excluded: 0, no_counterpart: 0 };
    m.verify.mockResolvedValue({ manifestValid: true, coverage: {
      aoa: { total: 247, categories }, tracker: { total: 644, categories: { ...categories, held: 0, no_counterpart: 639 } },
    }, outcomes: { PENDING: 886, APPLIED: 0, NOOP: 0, CONFLICT: 0, BLOCKED: 0, UNDONE: 0 } });
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, action: "exclude", reason: "manual_hold", record_id: null, disposition: "PENDING" }]);
    const output = await html();
    expect(output).toContain("AOA asset transfers · 247");
    expect(output).toContain("Tracker ACAT records · 644");
    expect(output).toContain("Existing links");
    expect(output).toContain("Automatic linking on hold");
    expect(output).toContain("242");
    expect(output).toContain("639");
    expect(output).toContain("Link attempts for this saved review");
    expect(output).not.toContain("886 pending");
    expect(output).not.toContain("Apply confirmed link");
  });

  it("withholds incomplete coverage instead of inventing a partition", async () => {
    expect(await html()).toContain("cannot support a complete population summary");
  });

  it("explains historical lifecycle restrictions instead of asserting missing identity", async () => {
    m.source.mockResolvedValue(snapshot([{ ...sourceRecord(), workflow: "ACAT" }]));
    m.targets.mockResolvedValue([{ ...targetRecord("transfer-1"), existingTransferUuid: null, stage: "FUNDED" }]);
    const output = await html({ transfer: "transfer-1" });
    expect(output).toContain("Historical transfers need a separate evidence review");
    expect(output).not.toContain("Prepare selected pair");
  });

  it("keeps eligible held pairs available and does not change hold controls", async () => {
    m.source.mockResolvedValue(snapshot([{ ...sourceRecord(), workflow: "ACAT" }]));
    m.targets.mockResolvedValue([{ ...targetRecord("transfer-1"), existingTransferUuid: null, hold: true }]);
    tx.transfer.findMany.mockResolvedValue([{ id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client", stage: "DECISION", funding_type: "ACAT_FULL", acat_auto_link_hold: true, acat_link_version: 7 }]);
    const output = await html({ transfer: "transfer-1" });
    expect(output).toContain("Prepare selected pair");
    expect(output).toContain("Resume automatic linking");
  });

  it("defaults to AOA transfers and applies the same filter to count and cards", async () => {
    const output = await html();
    const expected = { run_id: "run-1", transfer_id: { not: null } };
    expect(tx.acatLinkDecision.count).toHaveBeenCalledWith({ where: expected });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected }));
    expect(output).toContain("Review entry filters");
    expect(output).toContain("Sep 26, 2026, 6:00 AM EDT");
  });

  it("filters held transfers consistently and retains filters in pagination", async () => {
    tx.acatLinkDecision.count.mockResolvedValue(242);
    const output = await html({ population: "aoa", category: "held", page: "2" });
    const expected = { run_id: "run-1", transfer_id: { not: null }, action: "exclude", reason: "manual_hold" };
    expect(tx.acatLinkDecision.count).toHaveBeenCalledWith({ where: expected });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected, take: 50, skip: 50 }));
    expect(output).toContain("population=aoa&amp;category=held&amp;page=3");
    const filterForm = output.slice(output.indexOf('aria-label="Review entry filters"'), output.indexOf("Filter entries"));
    expect(filterForm).not.toContain('name="page"');
  });

  it("shows Tracker-only entries without claiming no real counterpart exists", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, transfer_id: null, action: "no_counterpart", reason: "no_counterpart", disposition: "PENDING" }]);
    const output = await html({ population: "tracker_only", category: "no_counterpart" });
    expect(tx.acatLinkDecision.count).toHaveBeenCalledWith({ where: { run_id: "run-1", transfer_id: null, action: "no_counterpart" } });
    expect(output).toContain("Tracker ACAT not yet matched in this run");
    expect(output).not.toContain("ACAT without an AOA counterpart");
  });

  it("resets out-of-range pages and explains an empty filtered view", async () => {
    tx.acatLinkDecision.count.mockResolvedValue(0);
    tx.acatLinkDecision.findMany.mockResolvedValue([]);
    const output = await html({ population: "all", category: "proposed", page: "99" });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, where: { run_id: "run-1", action: "propose" } }));
    expect(output).toContain("No entries in this saved review match these filters");
    expect(output).not.toContain("Page 99");
  });

  it("does not mislabel a missing AOA transfer as a Tracker-only entry", async () => {
    tx.transfer.findMany.mockResolvedValue([]);
    expect(await html()).toContain("AOA transfer unavailable");
  });

  it("explains an invalid picker selection without fetching source or offering an empty form", async () => {
    const output = await html({ transfer: "invalid transfer" });
    expect(output).toContain("This transfer selection is invalid");
    expect(output).not.toContain("Prepare selected pair");
    expect(m.source).not.toHaveBeenCalled();
  });

  it("preserves full-ledger pagination for existing links with page but no population", async () => {
    tx.acatLinkDecision.count.mockResolvedValue(886);
    await html({ run: "run-1", page: "3" });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { run_id: "run-1" }, skip: 100 }));
    tx.acatLinkDecision.findMany.mockClear();
    await html({ run: "run-1", page: "3", population: "aoa" });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { run_id: "run-1", transfer_id: { not: null } }, skip: 100 }));
  });

  function historicalSelection(recordOverrides = {}, targetOverrides = {}) {
    const source = { ...sourceRecord("history-record"), workflow: "ACAT", status: "Completed", controlNumber: "CONTROL-123", ...recordOverrides };
    const target = { ...targetRecord("transfer-1"), stage: "FUNDED", fundingType: "ACAT_FULL", existingTransferUuid: null, hold: true, ...targetOverrides };
    m.source.mockResolvedValue(snapshot([source])); m.targets.mockResolvedValue([target]);
    tx.transfer.findUnique.mockResolvedValue({ id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client", stage: "FUNDED", funding_type: target.fundingType,
      created_at: new Date("2026-08-10T12:00:00Z"), transferring_firm: "Synthetic Custodian", value: "1234", deal_id: null, acat_auto_link_hold: true, acat_link_version: 0 });
    return { source, target };
  }

  it("partitions current held transfers by known ACAT, other funding and missing funding across the full query", async () => {
    tx.transfer.groupBy.mockResolvedValue([{ funding_type: "ACAT_FULL", _count: { _all: 56 } }, { funding_type: "ACAT_PARTIAL", _count: { _all: 5 } },
      { funding_type: "ACH", _count: { _all: 59 } }, { funding_type: null, _count: { _all: 122 } }]);
    const output = await html();
    expect(output).toContain("evidence review</a></dt><dd>61"); expect(output).toContain("ACAT not applicable</a></dt><dd>59");
    expect(output).toContain("evidence needed</a></dt><dd>122");
    expect(tx.transfer.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { archived_at: null, acat_auto_link_hold: true, acat_record_id: null, acat_transfer_id: null } }));
  });

  it("offers comparison only, without selecting the sole historical candidate or preparing an unreviewed pair", async () => {
    historicalSelection();
    const output = await html({ historical: "transfer-1" });
    expect(output).toContain("Compare this Tracker record"); expect(output).toContain("CONTROL-123");
    expect(output).toContain("No record has been selected automatically"); expect(output).not.toContain("Prepare historical pair");
    expect(m.detail).not.toHaveBeenCalled();
  });

  it("renders complete explicit historical evidence fields and source/target comparison without identity IDs", async () => {
    historicalSelection();
    m.detail.mockResolvedValue({ transferringContra: "Synthetic Broker", apexAccountId: "******1234", statementAccountNumber: "******5678", statementAmount: 1234 });
    tx.$queryRaw.mockResolvedValue([{ user_id: "synthetic-person", contact_key: "003SYNTHETIC123", name: "Synthetic Directory Client" }]);
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain("Prepare historical pair"); expect(output).toContain('name="evidenceKind"');
    expect(output).toContain('name="correspondence" required="" minLength="40"');
    expect(output.match(/<input[^>]+name="historicalConfirmed"[^>]*>/)?.[0]).toContain('required=""');
    expect(output).toContain('name="expectedSourceDigest"'); expect(output).toContain("Client directory: Synthetic Directory Client");
    expect(output).toContain("******1234"); expect(output).toContain("Synthetic Broker");
    expect(output).toContain("Tracker statement amount</dt><dd>$12.34");
    expect(output).toContain("AOA value</dt><dd>$1,234.00");
    expect(output).toContain("/asset-transfer/transfer-1"); expect(output).toContain("records?open=history-record");
    expect(output).not.toContain("synthetic-person"); expect(output).not.toContain("synthetic-account");
    expect(output).not.toContain("holderIds"); expect(output).not.toContain("cedarRidgeUserIds");
  });

  it.each([null, "WIRE"])("keeps %s funding outside historical linking without a funding mutation form", async (fundingType) => {
    historicalSelection({}, { fundingType });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain(fundingType ? "ACAT linking is not applicable" : "Funding type is not recorded");
    expect(output).not.toContain("Prepare historical pair"); expect(output).not.toContain('name="fundingType"');
  });

  it("explains incomplete joint holder proof and offers no confirmation override", async () => {
    historicalSelection({ cedarRidgeUserIds: ["synthetic-person", "second-person"] }, { receivingAccount: null });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain("Joint-account evidence is incomplete"); expect(output).not.toContain("Prepare historical pair");
    expect(output).not.toContain('name="historicalConfirmed"');
  });

  it.each(["rejection", "unlink"])("shows a prior %s blocker instead of allowing fresh evidence to override it", async (kind) => {
    historicalSelection();
    m.intent.mockResolvedValue({ rejections: kind === "rejection" ? [{ recordId: "history-record" }] : [], linkClears: kind === "unlink" ? [{ recordId: "history-record", transferUuid: null }] : [], digest: "f".repeat(64) });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain(kind === "rejection" ? "previously rejected" : "cleared or undone"); expect(output).not.toContain("Prepare historical pair");
  });

  it("withholds historical controls on unavailable intent or a foreign record, while display-metadata failure does not invent an identity blocker", async () => {
    historicalSelection(); m.detail.mockRejectedValue(new Error("private response"));
    expect(await html({ historical: "transfer-1", record: "history-record" })).toContain("Prepare historical pair");
    expect(await html({ historical: "transfer-1", record: "foreign-record" })).not.toContain("Prepare historical pair");
    m.intent.mockRejectedValue(new Error("private query"));
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain("Historical linking is blocked"); expect(output).not.toContain("private query");
  });

  it("shows immutable historical evidence, explicit confirmation and historical apply text while suppressing resume", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([historicalDecision]);
    const output = await html();
    expect(output).toContain("DOC-123"); expect(output).toContain("Confirm this historical pair");
    expect(output).toContain("Apply confirmed historical link"); expect(output).toContain('name="historicalConfirmed"');
    expect(output).toContain("Review note"); expect(output).toContain("Reject pair"); expect(output).toContain("Keep pending");
    expect(output).toContain("Review both records and the saved evidence before confirming.");
    expect(output).not.toContain("Resume automatic linking"); expect(output).not.toContain("Hold automatic linking");
    expect(output).not.toContain("intentDigest");
  });

  it.each([
    ["APPLIED", "This historical link was applied using the saved evidence."],
    ["NOOP", "This historical link needed no further change."],
    ["UNDONE", "This historical link was undone."],
  ])("historical %s keeps audit evidence without obsolete pair-review controls", async (outcome, message) => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...historicalDecision, outcome }]);
    tx.transfer.findMany.mockResolvedValue([{ id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client", stage: "FUNDED", acat_auto_link_hold: true, acat_link_version: 8 }]);
    const output = await html();
    expect(output).toContain("<p>Prepared matching reason: missing transaction evidence</p>");
    expect(output).toContain("<p>Current AOA stage: funded · Automatic linking on hold</p>");
    expect(output).toContain("Historical pair · saved evidence");
    expect(output).toContain("DOC-123"); expect(output).toContain(historicalDecision.payload.context.historicalReview.correspondence);
    expect(output).toContain(message); expect(output).toContain("Review: accept");
    for (const obsolete of ["Confirm this historical pair", "Reject pair", "Keep pending", "Review note", 'name="historicalConfirmed"', "Apply confirmed historical link", "Retry confirmed historical link", "Review both records and the saved evidence before confirming."]) {
      expect(output).not.toContain(obsolete);
    }
    expect(output.includes('<button type="submit">Undo this link and hold automation</button>')).toBe(outcome === "APPLIED");
    expect(output).not.toContain("Resume automatic linking"); expect(output).not.toContain("Hold automatic linking");
    expect(output).not.toContain("intentDigest");
  });

  it.each(["CONFLICT", "BLOCKED"])("historical %s still offers confirmation and retry", async (outcome) => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...historicalDecision, outcome }]);
    const output = await html();
    expect(output).toContain("Confirm this historical pair"); expect(output).toContain("Retry confirmed historical link");
    expect(output).toContain('name="historicalConfirmed"'); expect(output).toContain("Reject pair"); expect(output).toContain("Keep pending");
    expect(output).not.toContain("Undo this link");
  });

  it.each([false, true])("ordinary applied decisions retain automation policy controls when hold is %s", async (hold) => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, outcome: "APPLIED" }]);
    tx.transfer.findMany.mockResolvedValue([{ id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client", stage: "IN_TRANSFER", acat_auto_link_hold: hold, acat_link_version: 8 }]);
    const output = await html();
    expect(output).toContain(hold ? "Resume automatic linking" : "Hold automatic linking");
    expect(output).toContain("Undo this link and hold automation"); expect(output).toContain("Review note");
    expect(output).not.toContain("Apply confirmed link"); expect(output).not.toContain("Retry confirmed link");
  });

  it("blocks malformed historical context instead of falling through to ordinary confirm/apply", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, payload: { context: { historicalReview: { kind: "HISTORICAL_ACAT_REVIEW" } } } }]);
    const output = await html();
    expect(output).toContain("saved historical evidence is invalid"); expect(output).not.toContain("Apply confirmed link");
    expect(output).not.toContain("Confirm proposed link");
  });

  it("bounds historical candidate pagination at 20 and retains explicit review scope", async () => {
    const { source } = historicalSelection();
    m.source.mockResolvedValue(snapshot(Array.from({ length: 21 }, (_, i) => ({ ...source, recordId: `history-${i}`, acatTransferId: null }))));
    const output = await html({ historical: "transfer-1" });
    expect((output.match(/>Compare this Tracker record<\/a>/g) ?? []).length).toBe(20);
    expect(output).toContain("candidatePage=2"); expect(output).toContain("historical=transfer-1");
  });

  it("preserves calendar dates and keeps transfer value separate from the parent deal amount", async () => {
    historicalSelection({ requestDate: "2026-09-28", createdAt: "2026-09-28T00:30:00Z" });
    tx.transfer.findUnique.mockResolvedValue({ id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client", stage: "FUNDED", funding_type: "ACAT_FULL", created_at: new Date("2026-09-28T00:30:00Z"), transferring_firm: null, value: "1000", deal_id: "deal-1", acat_auto_link_hold: true, acat_link_version: 0 });
    tx.deal.findUnique.mockResolvedValue({ id: "deal-1", amount: "9999", account_last4: "123456789", account_type: "ACAT Full", transferring_firm: "Synthetic Firm", created_date: new Date("2026-09-28T00:00:00Z"), close_date: new Date("2026-09-29T00:00:00Z") });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain("Request date</dt><dd>Sep 28, 2026");
    expect(output).toContain("Tracker record created</dt><dd>Sep 27, 2026");
    expect(output).toContain("Deal created / close date</dt><dd>Sep 28, 2026 / Sep 29, 2026");
    expect(output).toContain("AOA value</dt><dd>$1,000.00"); expect(output).toContain("Parent deal amount</dt><dd>$9,999.00");
    expect(output).not.toContain("123456789");
  });

  it("does not query another Tracker base for optional metadata or display an unmasked account", async () => {
    historicalSelection();
    vi.stubEnv("TRANSFER_TRACKER_URL", "https://other-tracker.example.invalid");
    expect(await html({ historical: "transfer-1", record: "history-record" })).toContain("Masked account and custodian details are unavailable");
    expect(m.detail).not.toHaveBeenCalled();
    vi.stubEnv("TRANSFER_TRACKER_URL", "https://tracker.example.invalid");
    m.detail.mockResolvedValue({ apexAccountId: "123456789", statementAccountNumber: "536898819" });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).not.toContain("123456789"); expect(output).not.toContain("536898819");
  });

  it("uses the existing production status default only for the matching production linkage source", async () => {
    historicalSelection();
    vi.stubEnv("APP_ENV", "prod"); vi.stubEnv("TRANSFER_TRACKER_URL", undefined);
    m.config.mockReturnValue({ environment: "production", baseUrl: "https://transfers.jeremyhamann.dev" });
    m.detail.mockResolvedValue({ transferringContra: "Synthetic Broker", apexAccountId: "******1234", statementAccountNumber: "******5678", statementAmount: 1234 });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(m.detail).toHaveBeenCalledExactlyOnceWith("history-record", { signal: expect.any(AbortSignal) });
    expect(output).toContain("Custodian</dt><dd>Synthetic Broker");
    expect(output).toContain("Receiving account (masked)</dt><dd>******1234");
    expect(output).toContain("Delivering account (masked)</dt><dd>******5678");
    expect(output).toContain("Tracker statement amount</dt><dd>$12.34");
    expect(output).toContain("Prepare historical pair");
  });

  it.each([
    { appEnv: "dev", environment: "production", baseUrl: "https://transfers.jeremyhamann.dev", configured: undefined },
    { appEnv: undefined, environment: "production", baseUrl: "https://transfers.jeremyhamann.dev", configured: undefined },
    { appEnv: "prod", environment: "production", baseUrl: "https://other-tracker.example.invalid", configured: undefined },
    { appEnv: "prod", environment: "synthetic", baseUrl: "https://transfers.jeremyhamann.dev", configured: undefined },
    { appEnv: "prod", environment: "production", baseUrl: "https://transfers.jeremyhamann.dev", configured: "" },
    { appEnv: "prod", environment: "production", baseUrl: "https://transfers.jeremyhamann.dev", configured: "https://other-tracker.example.invalid" },
  ])("withholds optional metadata for an unapproved default or configured base: %j", async ({ appEnv, environment, baseUrl, configured }) => {
    historicalSelection();
    vi.stubEnv("APP_ENV", appEnv); vi.stubEnv("TRANSFER_TRACKER_URL", configured);
    m.config.mockReturnValue({ environment, baseUrl });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(m.detail).not.toHaveBeenCalled();
    expect(output).toContain("Masked account and custodian details are unavailable");
    expect(output).toContain("Prepare historical pair");
  });

  it("preserves explicitly configured matching metadata reads in dev, including a trailing slash", async () => {
    historicalSelection();
    vi.stubEnv("TRANSFER_TRACKER_URL", "https://tracker.example.invalid/");
    await html({ historical: "transfer-1", record: "history-record" });
    expect(m.detail).toHaveBeenCalledExactlyOnceWith("history-record", { signal: expect.any(AbortSignal) });
  });

  it.each([[0, "$0.00"], [null, "Not recorded"], [undefined, "Not recorded"]])("displays a %s-cent Tracker statement amount as %s", async (statementAmount, expected) => {
    historicalSelection(); m.detail.mockResolvedValue({ statementAmount });
    const output = await html({ historical: "transfer-1", record: "history-record" });
    expect(output).toContain(`Tracker statement amount</dt><dd>${expected}`);
    expect(output).toContain("AOA value</dt><dd>$1,234.00");
  });

  it("filters the complete current known-ACAT cohort consistently and preserves it across pages", async () => {
    tx.transfer.findMany.mockResolvedValueOnce([{ id: "transfer-1" }, { id: "transfer-2" }]).mockResolvedValueOnce([]);
    tx.acatLinkDecision.count.mockResolvedValue(61);
    const output = await html({ cohort: "known_acat", category: "held", population: "tracker_only" });
    expect(tx.transfer.findMany).toHaveBeenNthCalledWith(1, { where: { archived_at: null, acat_auto_link_hold: true, acat_record_id: null, acat_transfer_id: null, funding_type: { in: ["ACAT_FULL", "ACAT_PARTIAL"] } }, select: { id: true }, take: 5001 });
    const where = { run_id: "run-1", action: "exclude", reason: "manual_hold", transfer_id: { in: ["transfer-1", "transfer-2"] } };
    expect(tx.acatLinkDecision.count).toHaveBeenCalledWith({ where });
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 0 }));
    expect(output).toContain("cohort=known_acat&amp;page=2"); expect(output).toContain("Current cohort: Known full or partial ACAT");
    const form = output.slice(output.indexOf('aria-label="Review entry filters"'), output.indexOf("Filter entries"));
    expect(form).not.toContain('name="page"'); expect(form).toContain('name="cohort"');
  });

  it("does not silently truncate a historical cohort larger than 5000", async () => {
    tx.transfer.findMany.mockResolvedValueOnce(Array.from({ length: 5001 }, (_, i) => ({ id: `transfer-${i}` }))).mockResolvedValueOnce([]);
    tx.acatLinkDecision.count.mockResolvedValue(0); tx.acatLinkDecision.findMany.mockResolvedValue([]);
    const output = await html({ cohort: "evidence_needed" });
    expect(output).toContain("No partial result is shown"); expect(output).not.toContain("No entries in this saved review match these filters");
    expect(tx.acatLinkDecision.count).toHaveBeenCalledWith({ where: { run_id: "run-1", transfer_id: { in: [] } } });
  });

  it("focuses only a decision actually loaded for this authorized page", async () => {
    const output = await html({ focus: "decision-1", message: "reviewed" });
    expect(m.focus).toHaveBeenCalledWith({ decisionId: "decision-1", revision: "3:PENDING:reviewed" });
    expect(output).toContain('id="decision-decision-1" tabindex="-1"');
    m.focus.mockClear(); await html({ focus: "not-on-this-page" }); expect(m.focus).not.toHaveBeenCalled();
    await html({ focus: "decision-1\" onfocus=bad" }); expect(m.focus).not.toHaveBeenCalled();
  });

});

describe("saved review note visibility", () => {
  const earlier = { transfer_id: "transfer-1", run_id: "run-earlier", run_created_at: new Date("2026-09-24T10:00:00Z"),
    review_reason: "Earlier synthetic note", reviewed_at: new Date("2026-09-25T10:00:00Z"), reviewed_by: "earlier@example.invalid" };

  it("selects current saved fields and shows current note without querying older annotations", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, review_reason: "Current note", reviewed_at: new Date("2026-09-26T11:00:00Z"), reviewed_by: "current@example.invalid" }]);
    const output = await html();
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ review_reason: true, reviewed_at: true, reviewed_by: true }) }));
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(output).toContain("Saved note for this review");
    expect(output).toContain("Current note");
    expect(output).toContain("current@example.invalid");
    expect(output).toContain("Sep 26, 2026, 7:00 AM EDT");
    expect(output).not.toContain("Earlier review of this transfer");
    expect(output).toContain('name="reason" maxLength="2000" rows="2"></textarea>');
  });

  it("binds the requested older run and only distinct visible transfers lacking current notes", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([
      { ...decision, id: "one" }, { ...decision, id: "same-transfer-again" },
      { ...decision, id: "current", transfer_id: "current-transfer", review_reason: "Current wins" },
      { ...decision, id: "tracker-only", transfer_id: null },
      { ...decision, id: "blank", transfer_id: "blank-transfer", review_reason: " \n\t " },
    ]);
    tx.$queryRaw.mockResolvedValue([earlier]);
    const output = await html({ run: "run-outside-menu" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const query = tx.$queryRaw.mock.calls[0][0];
    expect(query.values).toEqual(["transfer-1", "blank-transfer", "run-outside-menu"]);
    expect(query.sql).toContain("CROSS JOIN LATERAL");
    expect(query.sql).toContain("earlier.created_at < selected.created_at");
    expect(query.sql).toContain("previous.run_id <> selected.id");
    expect(query.sql).toContain("ORDER BY previous.reviewed_at DESC NULLS LAST, previous.id DESC");
    expect(query.sql).toContain("LIMIT 1");
    expect(query.sql).not.toContain("payload");
    expect(output).toContain("Earlier review of this transfer");
    expect(output).toContain("Earlier review prepared: Sep 24, 2026, 6:00 AM EDT");
    expect(output).toContain("Note saved: Sep 25, 2026, 6:00 AM EDT");
    expect(output).toContain("earlier@example.invalid");
    expect(output).toContain("Historical context only. This note may concern a different ACAT and is not evidence or approval for the current pair.");
    expect(output).toContain("Current wins");
  });

  it("binds all 50 visible transfer IDs without caller SQL interpolation", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `synthetic-${i}' OR TRUE --`);
    tx.acatLinkDecision.findMany.mockResolvedValue(ids.map((transfer_id, i) => ({ ...decision, id: `d-${i}`, transfer_id })));
    await html({ run: "run' OR TRUE --" });
    const query = tx.$queryRaw.mock.calls[0][0];
    expect(query.values).toEqual([...ids, "run' OR TRUE --"]);
    expect(query.sql).not.toContain("OR TRUE");
    expect(tx.acatLinkDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    expect(m.scope).toHaveBeenCalledWith(expect.anything(), expect.any(Function), { isolationLevel: "RepeatableRead", timeout: 30_000 });
  });

  it.each(["no-decisions", "tracker-only", "no-run"])("does not query history for %s", async (kind) => {
    tx.acatLinkDecision.findMany.mockResolvedValue(kind === "tracker-only" ? [{ ...decision, transfer_id: null }] : []);
    if (kind === "no-run") tx.acatLinkRun.findMany.mockResolvedValue([]);
    await html();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("shows a Tracker-only current note but never attaches a transfer's earlier note to it", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, transfer_id: null, review_reason: "Source-only saved annotation" }]);
    const output = await html();
    expect(output).toContain("Source-only saved annotation");
    expect(output).toContain("Saved note for this review");
    expect(output).not.toContain("Earlier review of this transfer");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("does not use another transfer's note or fabricate a note when history is absent", async () => {
    tx.$queryRaw.mockResolvedValue([{ ...earlier, transfer_id: "different-transfer" }]);
    const output = await html();
    expect(output).not.toContain("Earlier synthetic note");
    expect(output).not.toContain("Earlier review of this transfer");
  });

  it("renders annotation and attribution as escaped multiline plaintext with truthful unavailable dates", async () => {
    tx.$queryRaw.mockResolvedValue([{ ...earlier, review_reason: "<script>alert(1)</script>\n[do not link](https://example.invalid)", reviewed_by: '<img src=x onerror="alert(1)">', reviewed_at: new Date("invalid") }]);
    const output = await html();
    expect(output).toContain("&lt;script&gt;alert(1)&lt;/script&gt;\n[do not link](https://example.invalid)");
    expect(output).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(output).toContain("Note saved: Date unavailable");
    expect(output).toContain("white-space:pre-wrap");
    expect(output).not.toContain("<script>alert(1)</script>");
    expect(output).not.toContain('href="https://example.invalid"');
  });

  it("labels missing attribution rather than borrowing the signed-in identity", async () => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...decision, review_reason: "Undated current note", reviewed_by: "  " }]);
    const output = await html();
    expect(output).toContain("Date unavailable");
    expect(output).toContain("Reviewer unavailable");
    expect(output).not.toContain("ops@example.invalid");
  });

  it.each(["APPLIED", "NOOP", "UNDONE"])("retains notes on historical %s cards without reintroducing controls", async (outcome) => {
    tx.acatLinkDecision.findMany.mockResolvedValue([{ ...historicalDecision, outcome }]);
    tx.$queryRaw.mockResolvedValue([earlier]);
    const output = await html();
    expect(output).toContain("Earlier synthetic note");
    expect(output).not.toContain('name="reason"');
    expect(output).not.toContain('name="historicalConfirmed"');
    expect(output).not.toContain("Keep pending");
    expect(output).not.toContain("Confirm this historical pair");
    expect(output.includes("Undo this link and hold automation")).toBe(outcome === "APPLIED");
  });

  it.each(["disabled", "VIEWER", "ASSOCIATE", "missing-email"])("denies note queries for %s", async (kind) => {
    if (kind === "disabled") m.enabled.mockReturnValue(false);
    else m.auth.mockResolvedValue({ user: { role: kind === "missing-email" ? "OPERATIONS" : kind, email: kind === "missing-email" ? "" : "synthetic@example.invalid" } });
    await expect(html()).rejects.toThrow("NOT_FOUND");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
