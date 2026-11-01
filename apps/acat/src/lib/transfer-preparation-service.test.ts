import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { buildPreparation, receivingFingerprint, resolveGenerationInstructions, sourceRevision, validTitleConfirmation, type TransferSource } from "./transfer-preparation-service";
import { generateTransferFormSchema, transferFormPreparationSchema, type GenerateTransferForm } from "./transfer-form-contract";
import type { ManualTransferFormRule } from "./manual-transfer-forms";

const templateHash = "a".repeat(64);
function source(overrides: Partial<TransferSource> = {}): TransferSource {
  return {
    id: "record-1", deletedAt: null, clientName: "Synthetic Client", cedarRidgeUserId: null, identityVersion: 0, clientLinks: [],
    direction: "In", type: "Full account transfer", accountType: "IRA", status: "ToCome", transferWorkflow: "ACAT",
    apexAccountId: "SYN123456", statementAccountNumber: "SRC987654", transferringContra: "Synthetic Broker", dtccNumber: "9999",
    mappingSource: "test", mappingSyncedAt: null, mappingAccountId: null, mappingAccountSummary: null,
    verifiedApexAccountTitle: null, verifiedApexAccountTitleAt: null, verifiedApexAccountTitleBy: null,
    activeTransferTitleConfirmationId: null, activeTransferTitleConfirmation: null,
    transferTitleConfirmations: [],
    assets: [{ id: "position-1", symbol: "TEST", description: "Synthetic position", cusip: "123456789", expectedQty: 5,
      amount: 100, assetClass: "Equity", includeInTransfer: true }],
    custodian: { id: "custodian-1", name: "Synthetic Broker", reviewStatus: "VERIFIED", transferType: "ACAT_API",
      documentationStatus: "DOCUMENTED", dtcNumber: "9999", receivingAccountNumber: null, signature: "Required",
      letterOfAcceptance: "Required by custodian", medallionRequired: null, liquidationMethod: null,
      returnMethod: "Secure upload", watchouts: null, paperworkOnFile: true, projectionRevision: null }, ...overrides,
  };
}
function confirmedSource(): TransferSource {
  const record = source();
  const confirmedAt = new Date("2026-09-25T12:00:00.000Z");
  record.activeTransferTitleConfirmationId = "confirmation-1";
  record.verifiedApexAccountTitle = "Synthetic Client IRA";
  record.verifiedApexAccountTitleAt = confirmedAt.toISOString();
  record.verifiedApexAccountTitleBy = "operator@example.test";
  record.activeTransferTitleConfirmation = {
    id: "confirmation-1", acatRecordId: record.id, title: record.verifiedApexAccountTitle,
    registration: "Traditional IRA", receivingAccountFingerprint: receivingFingerprint(record),
    sourceAccountType: record.accountType, sourceIdentityVersion: 0, sourceRevision: "b".repeat(64),
    confirmedBy: record.verifiedApexAccountTitleBy, confirmedAt, serviceOrigin: "ops-portal@example.iam.gserviceaccount.com",
  };
  record.transferTitleConfirmations = [record.activeTransferTitleConfirmation];
  return record;
}

describe("Ops Portal transfer source contract", () => {
  it.each([
    ["ACAT", "ACAT"], ["MANUAL", "MANUAL"], ["PAPERWORK", "MANUAL"],
    ["DRS", "DRS"], ["RESIDUAL", "RESIDUAL"], ["UNCLASSIFIED", "UNCLASSIFIED"],
  ] as const)("keeps recorded %s method distinct from scope and PDF capability", (transferWorkflow, expected) => {
    const dto = buildPreparation(source({ transferWorkflow, type: "PARTIAL" }), templateHash);
    expect(dto.transferMethod).toBe(expected);
    expect(dto.scope).toBe("PARTIAL");
    expect(dto.workflows[0].automated).toBe(true);
  });
  it("returns a validated redacted full-transfer projection with explicit registration confirmation", () => {
    const dto = buildPreparation(source(), templateHash);
    expect(transferFormPreparationSchema.safeParse(dto).success).toBe(true);
    expect(dto.scope).toBe("FULL");
    expect(dto.accounts).toMatchObject({ receivingMasked: "*****3456", deliveringMasked: "*****7654", registrationSuggestion: null });
    expect(JSON.stringify(dto)).not.toContain("SYN123456");
    expect(JSON.stringify(dto)).not.toContain("123456789");
    expect(dto.workflows[0].id).toBe("default-brokerage-firm-transfer");
    expect(dto.blockers.map((b) => b.code)).toEqual(["receiving_confirmation"]);
    expect(dto.requirements).toContainEqual({ label: "Letter of Acceptance (custodian wording)", value: "Required by custodian" });
  });
  it("treats legacy confirmation as visible evidence that still needs binding", () => {
    const dto = buildPreparation(source({ verifiedApexAccountTitle: "Legacy title", verifiedApexAccountTitleBy: "old@example.test",
      verifiedApexAccountTitleAt: "2026-09-20T12:00:00Z" }), templateHash);
    expect(dto.confirmation).toMatchObject({ id: null, title: "Legacy title", valid: false, source: "TRACKER_LEGACY" });
  });
  it("validates all receiving identity and immutable confirmation bindings", () => {
    const record = confirmedSource();
    expect(validTitleConfirmation(record)).toBe(true);
    for (const changed of [
      { apexAccountId: "SYN999999" }, { accountType: "ROTH IRA" }, { identityVersion: 1 }, { clientName: "Different identity" },
      { verifiedApexAccountTitleBy: "changed@example.test" }, { verifiedApexAccountTitleAt: "2026-09-26T12:00:00.000Z" },
    ]) expect(validTitleConfirmation({ ...record, ...changed })).toBe(false);
    expect(buildPreparation(record, templateHash).blockers).toEqual([]);
  });
  it("binds joint-holder changes through the database-owned identity version and records the complete set in revisions", () => {
    const record = confirmedSource();
    record.clientLinks = [{ cedarRidgeUserId: "user-synthetic-a" }, { cedarRidgeUserId: "user-synthetic-b" }];
    expect(record.cedarRidgeUserId).toBeNull();
    expect(validTitleConfirmation(record)).toBe(true);
    const changed = { ...record, clientLinks: [{ cedarRidgeUserId: "user-synthetic-a" }, { cedarRidgeUserId: "user-synthetic-c" }], identityVersion: record.identityVersion + 1 };
    expect(changed.cedarRidgeUserId).toBeNull();
    expect(validTitleConfirmation(changed)).toBe(false);
    expect(sourceRevision(changed, templateHash)).not.toBe(sourceRevision(record, templateHash));
    expect(sourceRevision({ ...changed, identityVersion: record.identityVersion }, templateHash)).not.toBe(sourceRevision(record, templateHash));
    expect(JSON.stringify(buildPreparation(record, templateHash))).not.toContain("user-synthetic-");
  });
  it("retains the invalid Ops Portal confirmation's provenance after the receiving binding is cleared", () => {
    const record = confirmedSource();
    record.apexAccountId = "SYN999999";
    record.activeTransferTitleConfirmationId = null;
    record.activeTransferTitleConfirmation = null;
    const dto = buildPreparation(record, templateHash);
    expect(dto.confirmation).toEqual({ id: "confirmation-1", title: "Synthetic Client IRA", registration: "Traditional IRA",
      confirmedBy: "operator@example.test", confirmedAt: "2026-09-25T12:00:00.000Z", valid: false, source: "OPS_PORTAL" });
    expect(dto.blockers.map((blocker) => blocker.code)).toContain("receiving_confirmation");
  });
  it.each([
    { verifiedApexAccountTitle: "Browser revised title" },
    { verifiedApexAccountTitleBy: "different@example.test" },
    { verifiedApexAccountTitleAt: "2026-09-26T12:00:00.000Z" },
  ])("labels genuine later browser edits as legacy rather than attributing them to OpsPortal", (change) => {
    const record = { ...confirmedSource(), ...change, activeTransferTitleConfirmationId: null, activeTransferTitleConfirmation: null };
    expect(buildPreparation(record, templateHash).confirmation).toMatchObject({ id: null, registration: null, valid: false, source: "TRACKER_LEGACY" });
  });
  it("uses the explicit receiving registration for inherited and joint notices", () => {
    const record = confirmedSource();
    record.activeTransferTitleConfirmation!.registration = "Inherited Traditional IRA";
    expect(buildPreparation(record, templateHash).inheritedTitleReview).toBe(true);
    record.activeTransferTitleConfirmation!.registration = "Joint tenants with rights of survivorship";
    expect(buildPreparation(record, templateHash).notices.some((notice) => notice.includes("Both account holders"))).toBe(true);
  });
  it("preserves recognized historical registration evidence until an explicit new confirmation", () => {
    const record = confirmedSource();
    record.activeTransferTitleConfirmation!.registration = "Brokerage / Individual";
    const dto = buildPreparation(record, templateHash);
    expect(dto.confirmation).toMatchObject({ id: "confirmation-1", registration: "Brokerage / Individual", valid: true,
      confirmedBy: "operator@example.test", confirmedAt: "2026-09-25T12:00:00.000Z" });
    expect(record.activeTransferTitleConfirmation!.registration).toBe("Brokerage / Individual");
  });
  it.each(["IRA", "Joint", "Inherited IRA", "Other", "Individul", "constructor", "__proto__"])("keeps unknown stored %s visible but requires reconfirmation", (registration) => {
    const record = confirmedSource();
    record.activeTransferTitleConfirmation!.registration = registration;
    const dto = buildPreparation(record, templateHash);
    expect(validTitleConfirmation(record)).toBe(false);
    expect(dto.confirmation).toMatchObject({ id: "confirmation-1", registration, valid: false, source: "OPS_PORTAL",
      confirmedBy: "operator@example.test", confirmedAt: "2026-09-25T12:00:00.000Z" });
    expect(dto.blockers.map((blocker) => blocker.code)).toContain("receiving_confirmation");
    expect(record.activeTransferTitleConfirmation!.registration).toBe(registration);
  });
  it.each(["Community Property", "Community Property Registration"])("shows both-holder signature guidance for confirmed %s", (registration) => {
    const record = confirmedSource();
    record.activeTransferTitleConfirmation!.registration = registration;
    const dto = buildPreparation(record, templateHash);
    expect(dto.confirmation?.valid).toBe(true);
    expect(dto.notices.some((notice) => notice.includes("Both account holders must sign"))).toBe(true);
  });
  it("binds revisions to source details and template bytes, not a lastUpdated timestamp", () => {
    const record = source();
    const original = sourceRevision(record, templateHash);
    for (const changed of [
      { ...record, apexAccountId: "SYN999999" },
      { ...record, assets: [{ ...record.assets[0], expectedQty: 8 }] },
      { ...record, assets: [{ ...record.assets[0], includeInTransfer: false }] },
      { ...record, custodian: { ...record.custodian!, signature: "Wet required" } },
    ]) expect(sourceRevision(changed, templateHash)).not.toBe(original);
    expect(sourceRevision(record, "c".repeat(64))).not.toBe(original);
  });
  it("blocks unresolved partial positions and accepts the account-transfer alias", () => {
    const dto = buildPreparation(source({ type: "Partial account transfer", assets: [{ ...source().assets[0], includeInTransfer: null }] }), templateHash);
    expect(dto.scope).toBe("PARTIAL");
    expect(dto.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["positions_undecided", "positions_empty"]));
  });
  it.each([
    { custodian: null }, { custodian: { ...source().custodian!, transferType: "UNCONFIRMED" as const } },
    { custodian: { ...source().custodian!, reviewStatus: "NEEDS_SETUP" as const } },
  ])("does not offer the browser generic fallback for unknown/unreviewed profiles", (change) => {
    expect(buildPreparation(source(change), templateHash).workflows).toEqual([]);
  });
  it("keeps manual-only Empower visible without labeling it automated", () => {
    const dto = buildPreparation(source({ custodian: { ...source().custodian!, name: "Empower / Pershing", transferType: "MIXED" } }), templateHash);
    expect(dto.workflows.find((workflow) => workflow.id === "empower-direct-rollover")?.automated).toBe(false);
  });
  it.each(["Out", "unknown"])("blocks %s direction and masked account IDs", (direction) => {
    const dto = buildPreparation(source({ direction, apexAccountId: "****3456" }), templateHash);
    expect(dto.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["incoming_required", "accounts_required"]));
  });
});

describe("mixed partial generation instructions", () => {
  const rule: ManualTransferFormRule = { id: "synthetic-rule", custodianName: "Synthetic Broker", displayName: "Synthetic transfer",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST", apexTransferSelection: "BROKERAGE_FIRM_TRANSFER",
    assetHandling: { mode: "CLIENT_DIRECTED", options: ["IN_KIND", "LIQUIDATE"], defaultInstruction: "IN_KIND" } };
  const instructions = [
    { positionId: "position-2", assetInstruction: "LIQUIDATE" as const },
    { positionId: "position-1", assetInstruction: "IN_KIND" as const },
  ];
  const request: GenerateTransferForm = { expectedRevision: templateHash, confirmationId: "confirmation-1",
    operationId: "2a076e5e-c974-4421-80cb-320a36b40cf5", workflowId: rule.id, assetInstruction: "MIXED",
    positionInstructions: instructions, deliveringTitle: "Synthetic Client", deliveringTitleConfirmed: true,
    accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: false };
  function partialSource() {
    return source({ type: "Partial account transfer", assets: [
      source().assets[0],
      { ...source().assets[0], id: "position-2", symbol: "SECOND", expectedQty: 7.5 },
      { ...source().assets[0], id: "excluded", symbol: "EXCLUDED", includeInTransfer: false },
    ] });
  }
  it("accepts both explicit directions and binds them by source ID rather than caller order", () => {
    expect(generateTransferFormSchema.safeParse(request).success).toBe(true);
    const record = partialSource();
    const before = structuredClone(record);
    const resolved = resolveGenerationInstructions(record, rule, request);
    expect(resolved.selection).toBe("PARTIAL_TRANSFER");
    expect(resolved.positions.map((p) => ({ id: p.id, instruction: "assetInstruction" in p ? p.assetInstruction : undefined, quantity: p.expectedQty }))).toEqual([
      { id: "position-1", instruction: "IN_KIND", quantity: 5 },
      { id: "position-2", instruction: "LIQUIDATE", quantity: 7.5 },
      { id: "excluded", instruction: undefined, quantity: 5 },
    ]);
    expect(record).toEqual(before);
  });
  it.each([
    { positionInstructions: undefined }, { positionInstructions: [] },
    { positionInstructions: [instructions[0]] },
    { positionInstructions: [instructions[0], { ...instructions[1], positionId: "position-2" }] },
    { positionInstructions: instructions.map((item) => ({ ...item, assetInstruction: "IN_KIND" })) },
    { assetInstruction: "IN_KIND" }, { assetInstruction: "LIQUIDATE" },
    { positionInstructions: [instructions[0], { ...instructions[1], quantity: 2 }] },
    { positionInstructions: [instructions[0], { ...instructions[1], assetInstruction: "MIXED" }] },
  ])("rejects incomplete, duplicate, homogeneous or ambiguous request instructions", (change) => {
    expect(generateTransferFormSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
  it.each(["missing", "excluded", "unknown"])("rejects %s position coverage against current source", (kind) => {
    const positionInstructions = kind === "missing" ? [instructions[0]] : [instructions[0], { ...instructions[1], positionId: kind }];
    expect(() => resolveGenerationInstructions(partialSource(), rule, { ...request, positionInstructions })).toThrow("invalid");
  });
  it("rejects full, fixed and one-direction workflows for mixed instructions", () => {
    expect(() => resolveGenerationInstructions({ ...partialSource(), type: "Full" }, rule, request)).toThrow("invalid");
    expect(() => resolveGenerationInstructions(partialSource(), { ...rule, assetHandling: { mode: "FIXED", instruction: "LIQUIDATE" } }, request)).toThrow("invalid");
    expect(() => resolveGenerationInstructions(partialSource(), { ...rule, assetHandling: { mode: "CLIENT_DIRECTED", options: ["IN_KIND"], defaultInstruction: "IN_KIND" } }, request)).toThrow("invalid");
  });
  it("preserves single-instruction full and fixed partial behavior", () => {
    const single = { ...request, assetInstruction: "IN_KIND" as const, positionInstructions: undefined };
    expect(generateTransferFormSchema.safeParse(single).success).toBe(true);
    expect(resolveGenerationInstructions(source(), rule, single).selection).toBe("BROKERAGE_FIRM_TRANSFER");
    expect(resolveGenerationInstructions(partialSource(), { ...rule, assetHandling: { mode: "FIXED", instruction: "IN_KIND" } }, single).selection).toBe("PARTIAL_TRANSFER");
  });
});

describe("paperwork template switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the Apex template while rollout-acat-paperwork is on", () => {
    markCase("paperwork-template", "returns the Apex template while rollout-acat-paperwork is on");
    vi.stubEnv("ROLLOUT_ACAT_PAPERWORK", "1");
    const dto = buildPreparation(source(), templateHash);
    expect(dto.workflows[0].template).toBe("APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST");
    expect(dto.workflows[0].handling).toEqual({ mode: "CLIENT_DIRECTED", options: ["IN_KIND", "LIQUIDATE"] });
  });

  it("returns the Empower template on that workflow while the switch is on", () => {
    markCase("paperwork-template", "returns the Empower template on that workflow while the switch is on");
    vi.stubEnv("ROLLOUT_ACAT_PAPERWORK", "1");
    const dto = buildPreparation(source({
      custodian: { ...source().custodian!, name: "Empower / Pershing" },
    }), templateHash);
    expect(dto.workflows.find((workflow) => workflow.id === "empower-direct-rollover")?.template)
      .toBe("EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST");
  });

  it("keeps today's workflow keys while the switch is off", () => {
    markCase("paperwork-template", "keeps today's workflow keys while the switch is off");
    vi.stubEnv("ROLLOUT_ACAT_PAPERWORK", "0");
    const dto = buildPreparation(source(), templateHash);
    expect(Object.keys(dto.workflows[0]).join(",")).toBe(
      "id,name,automated,requiresReceivingAccountNumber,handling,note"
    );
  });

  it("keeps today's workflow keys when the switch is not exactly 1", () => {
    markCase("paperwork-template", "keeps today's workflow keys when the switch is not exactly 1");
    vi.stubEnv("ROLLOUT_ACAT_PAPERWORK", "true");
    const dto = buildPreparation(source(), templateHash);
    expect(Object.keys(dto.workflows[0]).join(",")).toBe(
      "id,name,automated,requiresReceivingAccountNumber,handling,note"
    );
  });
});
