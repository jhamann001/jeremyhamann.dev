import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { transferPreparationPrisma as prisma } from "@/lib/transfer-preparation-prisma";
import { fillApexTransferForm } from "@/lib/apex-transfer-form";
import {
  MANUAL_TRANSFER_FORM_RULES, buildManualTransferFormRecommendation,
  getManualTransferFormRulesForCustodian, getAssetHandlingRule, getApexTransferSelection,
  type ManualTransferFormRule,
} from "@/lib/manual-transfer-forms";
import { buildTransferDocument, safeDocumentFilename } from "@/lib/transfer-documents";
import { maskIdentifier } from "@/lib/mcp/redaction";
import { suggestedReceivingRegistration } from "@/lib/transfer-registration";
import {
  confirmReceivingTitleSchema, generateTransferFormSchema, transferFormPreparationSchema, updateTransferScopeSchema,
  type ConfirmReceivingTitle, type GenerateTransferForm, type TransferFormPreparation, type UpdateTransferScope,
  type TransferFormFailureReason,
} from "@/lib/transfer-form-contract";

// Bump when generation/validation semantics change. The revision also includes
// the complete rule catalog and the exact PDF template digest.
export const TRANSFER_FORM_RULE_VERSION = "ops-portal-catr-v3-2026-09-25-mixed-partial";
export type PreparationActor = { email: string; serviceAccount: string };
export class TransferPreparationError extends Error {
  constructor(public readonly reason: TransferFormFailureReason) { super(reason); }
}
function fail(reason: TransferFormFailureReason): never { throw new TransferPreparationError(reason); }
export const preparationHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sourceSelect = {
  id: true, deletedAt: true, clientName: true, cedarRidgeUserId: true, identityVersion: true,
  // The junction is authoritative for joint holders. Preserve the complete
  // ordered set in revision/archive evidence without exposing it in the DTO.
  clientLinks: { select: { cedarRidgeUserId: true }, orderBy: { cedarRidgeUserId: "asc" as const } },
  direction: true, type: true, accountType: true, status: true, transferWorkflow: true,
  apexAccountId: true, statementAccountNumber: true, transferringContra: true, dtccNumber: true,
  mappingSource: true, mappingSyncedAt: true, mappingAccountId: true, mappingAccountSummary: true,
  verifiedApexAccountTitle: true, verifiedApexAccountTitleAt: true, verifiedApexAccountTitleBy: true,
  activeTransferTitleConfirmationId: true, activeTransferTitleConfirmation: true,
  transferTitleConfirmations: { orderBy: [{ confirmedAt: "desc" as const }, { id: "desc" as const }], take: 1 },
  assets: { orderBy: { id: "asc" as const }, select: {
    id: true, symbol: true, description: true, cusip: true, expectedQty: true,
    amount: true, assetClass: true, includeInTransfer: true,
  } },
  custodian: { select: {
    id: true, name: true, reviewStatus: true, transferType: true, documentationStatus: true,
    dtcNumber: true, receivingAccountNumber: true, signature: true, letterOfAcceptance: true,
    medallionRequired: true, liquidationMethod: true, returnMethod: true, watchouts: true,
    paperworkOnFile: true, projectionRevision: true,
  } },
} satisfies Prisma.AcatRecordSelect;
export type TransferSource = Prisma.AcatRecordGetPayload<{ select: typeof sourceSelect }>;

export async function readTransferSource(tx: Prisma.TransactionClient, id: string): Promise<TransferSource> {
  const source = await tx.acatRecord.findUnique({ where: { id, deletedAt: null }, select: sourceSelect });
  return source ?? fail("not_found");
}

async function lockTransferSource(tx: Prisma.TransactionClient, id: string): Promise<TransferSource> {
  // Ordinary Tracker writers need not participate in our serializable policy.
  // Hold the parent (also blocks FK inserts), current positions, and playbook
  // while validating and archiving. A concurrent edit cannot slip past the
  // revision check before the archive commits.
  const parents = await tx.$queryRaw<Array<{ custodianId: string | null }>>`
    SELECT "custodianId" FROM "AcatRecord" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR UPDATE`;
  if (!parents.length) fail("not_found");
  await tx.$queryRaw`SELECT "id" FROM "Asset" WHERE "acatRecordId" = ${id} ORDER BY "id" FOR UPDATE`;
  if (parents[0].custodianId) {
    await tx.$queryRaw`SELECT "id" FROM "Custodian" WHERE "id" = ${parents[0].custodianId} FOR SHARE`;
  }
  return readTransferSource(tx, id);
}

async function readTemplate() {
  const bytes = await readFile(join(process.cwd(), "public/form-templates/apex-customer-account-transfer-request.pdf"));
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

export function receivingFingerprint(source: TransferSource): string {
  // Keep existing confirmation fingerprints stable. The database-owned version
  // advances for any clientLinks set change, including joint-to-joint edits
  // whose legacy singleton projection remains null.
  return preparationHash({ recordId: source.id, receivingAccount: source.apexAccountId,
    sourceAccountType: source.accountType, identityVersion: source.identityVersion,
    cedarRidgeUserId: source.cedarRidgeUserId, clientName: source.clientName });
}

export function sourceRevision(source: TransferSource, templateHash: string): string {
  return preparationHash({ schemaVersion: 1, ruleVersion: TRANSFER_FORM_RULE_VERSION,
    rules: MANUAL_TRANSFER_FORM_RULES, templateHash, source });
}

export function validTitleConfirmation(source: TransferSource): boolean {
  const c = source.activeTransferTitleConfirmation;
  return Boolean(c && c.id === source.activeTransferTitleConfirmationId && c.acatRecordId === source.id &&
    c.receivingAccountFingerprint === receivingFingerprint(source) &&
    c.sourceIdentityVersion === source.identityVersion && c.sourceAccountType === source.accountType &&
    matchesLegacyTitle(source, c) && suggestedReceivingRegistration(c.registration));
}

function matchesLegacyTitle(source: TransferSource, confirmation: NonNullable<TransferSource["activeTransferTitleConfirmation"]>): boolean {
  return confirmation.title === source.verifiedApexAccountTitle &&
    confirmation.confirmedBy === source.verifiedApexAccountTitleBy &&
    confirmation.confirmedAt.toISOString() === source.verifiedApexAccountTitleAt;
}

function direction(source: TransferSource): TransferFormPreparation["direction"] {
  const value = source.direction?.trim().toLowerCase();
  return value === "in" || value === "incoming" ? "INCOMING" : value === "out" || value === "outgoing" ? "OUTGOING" : "UNKNOWN";
}
function scope(source: TransferSource): TransferFormPreparation["scope"] {
  const value = source.type?.trim().toLowerCase();
  return ["full", "full transfer", "full account transfer"].includes(value ?? "") ? "FULL" :
    ["partial", "partial transfer", "partial account transfer"].includes(value ?? "") ? "PARTIAL" : "UNKNOWN";
}
function realAccount(value: string | null): boolean {
  const compact = value?.trim() ?? "";
  return compact.length >= 5 && compact.length <= 100 && /\d/.test(compact) &&
    !/[*•]/.test(compact) && !/^(?:n\/?a|none|null|unknown|pending|tbd|0+)$/i.test(compact) &&
    /^[A-Za-z0-9 ._-]+$/.test(compact);
}
function workflowRules(source: TransferSource): readonly ManualTransferFormRule[] {
  if (!source.custodian) return [];
  const known = getManualTransferFormRulesForCustodian(source.custodian.name);
  if (known.length) return known;
  // The browser's permissive fallback is deliberately narrower here.
  if (source.custodian.reviewStatus === "VERIFIED" && source.custodian.transferType === "ACAT_API") {
    return buildManualTransferFormRecommendation(source, source.custodian).candidates;
  }
  return [];
}

function sourceRecommendation(source: TransferSource) {
  // Preserve delivering-account warnings while also honoring the explicitly
  // confirmed receiving registration; source accountType alone cannot establish it.
  const receivingRegistration = validTitleConfirmation(source)
    ? suggestedReceivingRegistration(source.activeTransferTitleConfirmation?.registration)
    : "";
  // The legacy rule engine recognizes joint labels. Explicitly classify the
  // supported community-property receiving registration as multiple holders.
  const receivingWarningType = receivingRegistration === "Community Property"
    ? "Joint Account (Community Property)" : receivingRegistration;
  return buildManualTransferFormRecommendation({ ...source,
    accountType: [source.accountType, receivingWarningType].filter(Boolean).join(" "),
  }, source.custodian);
}

function sourceBlockers(source: TransferSource): TransferFormPreparation["blockers"] {
  const blockers: TransferFormPreparation["blockers"] = [];
  const block = (code: string, message: string) => blockers.push({ code, message });
  if (direction(source) !== "INCOMING") block("incoming_required", "Preparation requires a confirmed incoming transfer.");
  if (scope(source) === "UNKNOWN") block("scope_required", "Confirm full or partial transfer in the tracker.");
  if (!realAccount(source.apexAccountId) || !realAccount(source.statementAccountNumber)) {
    block("accounts_required", "Both account identifiers must be complete and verified in the tracker.");
  }
  if (!source.custodian) block("custodian_required", "Link the delivering custodian in the tracker.");
  else if (source.custodian.reviewStatus !== "VERIFIED") block("custodian_review", "The custodian playbook needs review.");
  if (["DRS", "RESIDUAL"].includes(source.transferWorkflow)) block("workflow_unsupported", "This transfer method requires a separate workflow.");
  if (["Canceled", "Purged"].includes(source.status)) block("inactive_transfer", "This transfer is no longer active.");
  if (!workflowRules(source).some((rule) => rule.generationSupport !== "MANUAL_ONLY")) {
    block("form_unavailable", "No reviewed automated form workflow is available for this custodian.");
  }
  if (source.assets.length > 5000) block("positions_limit", "The position list exceeds the supported preparation limit.");
  if (scope(source) === "PARTIAL") {
    if (source.assets.some((asset) => asset.includeInTransfer == null)) block("positions_undecided", "Choose Yes or No for every holding in the tracker.");
    if (!source.assets.some((asset) => asset.includeInTransfer === true)) block("positions_empty", "Include at least one holding in the tracker.");
  }
  const selected = scope(source) === "PARTIAL" ? source.assets.filter((a) => a.includeInTransfer === true) : source.assets;
  if (selected.some((asset) => !Number.isFinite(asset.expectedQty) || asset.expectedQty < 0)) {
    block("positions_invalid", "Review the source holding quantities in the tracker.");
  }
  return blockers;
}

type DocumentSummary = { id: string; filename: string; createdBy: string; createdAt: Date; sha256: string };

export function paperworkRequirementValues(
  custodian: {
    signature: string | null;
    letterOfAcceptance: string | null;
    medallionRequired: string | null;
    liquidationMethod: string | null;
    returnMethod: string | null;
    watchouts: string | null;
    projectionRevision: number | null;
  } | null
): Array<{ label: string; value: string }> {
  const requirements: Array<{ label: string; value: string }> = [];
  for (const [label, value] of [
    ["Client signature", custodian?.signature],
    ["Letter of Acceptance (custodian wording)", custodian?.letterOfAcceptance],
    ["Medallion", custodian?.medallionRequired],
    ["Liquidation instructions", custodian?.liquidationMethod],
    ["Return method", custodian?.returnMethod],
    ["Watchouts", custodian?.watchouts],
  ]) if (value) requirements.push({ label: label!, value });
  return requirements;
}

export function buildPreparation(source: TransferSource, templateHash: string, documents: DocumentSummary[] = []): TransferFormPreparation {
  const rec = sourceRecommendation(source);
  const valid = validTitleConfirmation(source);
  // Clearing the binding does not erase provenance. Keep the immutable Ops Portal
  // confirmation visible (and invalid) while its exact mirrored title/actor/time
  // remain unchanged. A subsequent browser title edit is genuinely legacy data.
  const previous = source.transferTitleConfirmations[0];
  const c = source.activeTransferTitleConfirmation ??
    (previous && matchesLegacyTitle(source, previous) ? previous : null);
  const confirmation: TransferFormPreparation["confirmation"] = c ? {
    id: c.id, title: c.title, registration: c.registration, confirmedBy: c.confirmedBy,
    confirmedAt: c.confirmedAt.toISOString(), valid, source: "OPS_PORTAL",
  } : source.verifiedApexAccountTitle ? {
    id: null, title: source.verifiedApexAccountTitle, registration: null,
    confirmedBy: source.verifiedApexAccountTitleBy, confirmedAt: validTimestamp(source.verifiedApexAccountTitleAt),
    valid: false, source: "TRACKER_LEGACY",
  } : null;
  const requirements = paperworkRequirementValues(source.custodian);
  const rules = workflowRules(source);
  const notices = [...rec.sourceGuidance, ...rec.actions.map((action) => action.message)];
  if (rec.secondaryClientSignatureRequired) notices.push("Both account holders must sign; generation does not collect signatures.");
  if (rules.some((r) => r.apexSignatureRequirement === "WET_REQUIRED")) notices.push("The selected custodian workflow may require a wet signature on the Apex form.");
  notices.push("Letter of Acceptance wording is separate from the Letter of Authorization section. Confirm the authorization choice explicitly.");
  notices.push("Account type is a source hint only. Confirm the receiving registration against Apex.");
  const blockers = sourceBlockers(source);
  if (!valid) blockers.push({ code: "receiving_confirmation", message: "Confirm the exact receiving title and registration against Apex." });
  return transferFormPreparationSchema.parse({
    schemaVersion: 1, recordId: source.id, sourceRevision: sourceRevision(source, templateHash), checkedAt: new Date().toISOString(),
    direction: direction(source), scope: scope(source),
    // PAPERWORK was migrated to MANUAL; retain that mapping for legacy records.
    // This is the chosen record method, not whether its PDF can be generated.
    transferMethod: source.transferWorkflow === "PAPERWORK" ? "MANUAL" : source.transferWorkflow,
    custodian: source.custodian ? { id: source.custodian.id, name: source.custodian.name } : null,
    accounts: {
      receivingMasked: maskIdentifier(source.apexAccountId) ?? "", deliveringMasked: maskIdentifier(source.statementAccountNumber) ?? "",
      receivingTitleSuggestion: source.verifiedApexAccountTitle ?? source.clientName,
      deliveringTitleSuggestion: source.clientName, registrationSuggestion: null,
    },
    confirmation, workflows: rules.map((rule) => {
      const handling = getAssetHandlingRule(rule);
      const workflow = { id: rule.id, name: rule.displayName, automated: rule.generationSupport !== "MANUAL_ONLY",
        requiresReceivingAccountNumber: rule.requiresVerifiedReceivingAccountNumber === true,
        handling: { mode: handling.mode, options: handling.mode === "FIXED" ? [handling.instruction] : [...handling.options] }, note: rule.note ?? null };
      // Additive field for the paperwork contract (ticket). Off by default.
      return process.env.ROLLOUT_ACAT_PAPERWORK === "1" ? { ...workflow, template: rule.template } : workflow;
    }),
    positions: source.assets.slice(0, 5000).map((asset) => ({ id: asset.id, symbol: asset.symbol,
      description: asset.description, quantity: Number.isFinite(asset.expectedQty) ? asset.expectedQty : 0, include: asset.includeInTransfer })),
    inheritedTitleReview: rec.inheritedAccountTitleReviewRequired,
    requirements, notices, blockers, documents: documents.map((doc) => ({ ...doc, createdAt: doc.createdAt.toISOString() })),
    ruleVersion: TRANSFER_FORM_RULE_VERSION,
  });
}
function validTimestamp(value: string | null): string | null {
  if (!value) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
async function preparationFromSource(tx: Prisma.TransactionClient, source: TransferSource, templateHash: string) {
  const docs = await tx.acatDocument.findMany({ where: { acatRecordId: source.id, kind: "TRANSFER_FORM" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
    select: { id: true, filename: true, createdBy: true, createdAt: true, sha256: true } });
  return buildPreparation(source, templateHash, docs);
}

async function transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await prisma.$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 }); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (
      ["P2034", "P2002"].includes(error.code) ||
      // Raw row-lock queries surface PostgreSQL serialization/deadlock errors
      // as P2010 rather than the ORM's P2034 transaction-conflict code.
      (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)))
    )) fail("stale");
    throw error;
  }
}

export async function getPreparation(recordId: string): Promise<TransferFormPreparation> {
  const template = await readTemplate();
  return transaction(async (tx) => preparationFromSource(tx, await readTransferSource(tx, recordId), template.hash));
}

async function priorOperation(tx: Prisma.TransactionClient, recordId: string, actor: PreparationActor,
  operationId: string, kind: string, requestHash: string) {
  const prior = await tx.transferPreparationOperation.findUnique({
    where: { acatRecordId_actorEmail_operationId: { acatRecordId: recordId, actorEmail: actor.email, operationId } },
  });
  if (prior && (prior.kind !== kind || prior.requestHash !== requestHash || prior.serviceOrigin !== actor.serviceAccount)) fail("invalid");
  return prior;
}

export async function confirmReceivingTitle(recordId: string, input: ConfirmReceivingTitle, actor: PreparationActor): Promise<TransferFormPreparation> {
  const parsed = confirmReceivingTitleSchema.safeParse(input);
  if (!parsed.success) fail("invalid");
  const request = parsed.data;
  const requestHash = preparationHash(request);
  const template = await readTemplate();
  return transaction(async (tx) => {
    const source = await lockTransferSource(tx, recordId);
    const prior = await priorOperation(tx, recordId, actor, request.operationId, "CONFIRM_TITLE", requestHash);
    if (prior) return preparationFromSource(tx, source, template.hash);
    if (sourceRevision(source, template.hash) !== request.expectedRevision) fail("stale");
    if (!realAccount(source.apexAccountId)) fail("review_required");
    let confirmation = validTitleConfirmation(source) ? source.activeTransferTitleConfirmation : null;
    // Unchanged saves preserve the original human and time, even with a fresh operation ID.
    if (!confirmation || confirmation.title !== request.title || confirmation.registration !== request.registration) {
      confirmation = await tx.transferTitleConfirmation.create({ data: {
        acatRecordId: recordId, title: request.title, registration: request.registration,
        receivingAccountFingerprint: receivingFingerprint(source), sourceAccountType: source.accountType,
        sourceIdentityVersion: source.identityVersion, sourceRevision: request.expectedRevision,
        confirmedBy: actor.email, serviceOrigin: actor.serviceAccount,
      } });
      await tx.acatRecord.update({ where: { id: recordId, deletedAt: null }, data: {
        activeTransferTitleConfirmationId: confirmation.id,
        verifiedApexAccountTitle: confirmation.title, verifiedApexAccountTitleBy: confirmation.confirmedBy,
        verifiedApexAccountTitleAt: confirmation.confirmedAt.toISOString(),
      } });
    }
    await tx.transferPreparationOperation.create({ data: { acatRecordId: recordId, actorEmail: actor.email,
      operationId: request.operationId, kind: "CONFIRM_TITLE", requestHash,
      confirmationId: confirmation.id, serviceOrigin: actor.serviceAccount } });
    return preparationFromSource(tx, await readTransferSource(tx, recordId), template.hash);
  });
}

export async function updateTransferScope(recordId: string, input: UpdateTransferScope, actor: PreparationActor): Promise<TransferFormPreparation> {
  const parsed = updateTransferScopeSchema.safeParse(input);
  if (!parsed.success) fail("invalid");
  const request = parsed.data;
  const requestHash = preparationHash(request);
  const template = await readTemplate();
  return transaction(async (tx) => {
    const source = await lockTransferSource(tx, recordId);
    const prior = await priorOperation(tx, recordId, actor, request.operationId, "UPDATE_SCOPE", requestHash);
    // Replays report the current record. They must not reverse later edits.
    if (prior) return preparationFromSource(tx, source, template.hash);
    if (sourceRevision(source, template.hash) !== request.expectedRevision) fail("stale");
    if (direction(source) !== "INCOMING" || ["DRS", "RESIDUAL"].includes(source.transferWorkflow)) fail("review_required");
    if (scope(source) !== request.scope) {
      const nextType = request.scope === "FULL" ? "Full" : "Partial";
      // Match the ordinary Tracker type edit: canonical type, ISO lastUpdated,
      // and an audit of the changed field. Incoming changes have no outgoing
      // fee/monitoring defaults. Identity, title, status and holdings stay intact.
      await tx.acatRecord.update({ where: { id: recordId, deletedAt: null },
        data: { type: nextType, lastUpdated: new Date().toISOString() } });
      await tx.auditLog.create({ data: { acatRecordId: recordId, action: "ops-portal-transfer-scope-update", field: "type",
        oldValue: source.type, newValue: nextType, performedBy: actor.email } });
    }
    await tx.transferPreparationOperation.create({ data: { acatRecordId: recordId, actorEmail: actor.email,
      operationId: request.operationId, kind: "UPDATE_SCOPE", requestHash, serviceOrigin: actor.serviceAccount } });
    return preparationFromSource(tx, await readTransferSource(tx, recordId), template.hash);
  });
}

const normalizedTitle = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export function resolveGenerationInstructions(source: TransferSource, rule: ManualTransferFormRule, request: GenerateTransferForm) {
  const partial = scope(source) === "PARTIAL";
  const handling = getAssetHandlingRule(rule);
  const positions = source.assets.map((asset) => ({ ...asset, includeInTransfer: partial ? asset.includeInTransfer : true }));
  if (request.assetInstruction === "MIXED") {
    if (!partial || handling.mode !== "CLIENT_DIRECTED" ||
      !handling.options.includes("IN_KIND") || !handling.options.includes("LIQUIDATE")) fail("invalid");
    const instructions = new Map(request.positionInstructions?.map((item) => [item.positionId, item.assetInstruction]));
    const included = positions.filter((asset) => asset.includeInTransfer === true);
    // Bind directions to the complete source-owned selection. No quantities,
    // extra positions, excluded positions or caller-owned holding edits enter here.
    if (instructions.size !== included.length || instructions.size !== request.positionInstructions?.length ||
      new Set(instructions.values()).size !== 2 || included.some((asset) => !instructions.has(asset.id))) fail("invalid");
    return { selection: "PARTIAL_TRANSFER" as const,
      positions: positions.map((asset) => ({ ...asset, assetInstruction: instructions.get(asset.id) })) };
  }
  if (request.positionInstructions !== undefined ||
    (handling.mode === "FIXED" ? handling.instruction !== request.assetInstruction : !handling.options.includes(request.assetInstruction))) fail("invalid");
  const selection = partial ? "PARTIAL_TRANSFER" : getApexTransferSelection(rule, request.assetInstruction);
  if (!selection) fail("review_required");
  return { selection, positions };
}

export async function generateTransferForm(recordId: string, input: GenerateTransferForm, actor: PreparationActor): Promise<{ documentId: string }> {
  const parsed = generateTransferFormSchema.safeParse(input);
  if (!parsed.success) fail("invalid");
  const request = parsed.data;
  const requestHash = preparationHash(request);
  const template = await readTemplate();
  return transaction(async (tx) => {
    const source = await lockTransferSource(tx, recordId);
    const prior = await priorOperation(tx, recordId, actor, request.operationId, "GENERATE", requestHash);
    if (prior?.documentId) return { documentId: prior.documentId };
    if (sourceRevision(source, template.hash) !== request.expectedRevision) fail("stale");
    if (sourceBlockers(source).length || !validTitleConfirmation(source)) fail("review_required");
    const confirmation = source.activeTransferTitleConfirmation!;
    if (confirmation.id !== request.confirmationId) fail("stale");
    const rule = workflowRules(source).find((candidate) => candidate.id === request.workflowId);
    if (!rule || rule.generationSupport === "MANUAL_ONLY" || rule.template !== "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST") fail("review_required");
    const { selection, positions } = resolveGenerationInstructions(source, rule, request);
    if (rule.requiresVerifiedReceivingAccountNumber && (!request.receivingAccountNumberVerified || !realAccount(request.receivingAccountNumber ?? null))) fail("review_required");
    const rec = sourceRecommendation(source);
    const inheritedMismatch = rec.inheritedAccountTitleReviewRequired && normalizedTitle(request.deliveringTitle) !== normalizedTitle(confirmation.title);
    if (inheritedMismatch && !request.letterOfAuthorizationRequired) fail("review_required");
    const generatedAt = new Date();
    const output = await fillApexTransferForm(template.bytes, {
      generatedOn: generatedAt, clientName: source.clientName, apexAccountNumber: source.apexAccountId,
      apexAccountTitle: confirmation.title, transferringAccountNumber: source.statementAccountNumber,
      transferringAccountTitle: request.deliveringTitle,
      deliveringFirmName: source.transferringContra?.trim() || source.custodian!.name,
      brokerClearingNumber: source.dtccNumber, apexTransferSelection: selection, assetInstruction: request.assetInstruction,
      receivingAccountNumber: rule.requiresVerifiedReceivingAccountNumber ? request.receivingAccountNumber : undefined,
      // Acceptance is not authorization. The explicit human selection controls
      // this section, with the inherited mismatch guard above.
      letterOfAuthorizationRequired: request.letterOfAuthorizationRequired,
      assets: positions.filter((asset) => asset.includeInTransfer === true),
    });
    const snapshot = JSON.parse(JSON.stringify({ schemaVersion: 1, sourceRevision: request.expectedRevision,
      ruleVersion: TRANSFER_FORM_RULE_VERSION, template: rule.template, templateSha256: template.hash,
      rule, confirmation, source, request, actor, generatedAt: generatedAt.toISOString() })) as Prisma.InputJsonValue;
    const document = await tx.acatDocument.create({ data: {
      ...buildTransferDocument({ kind: "TRANSFER_FORM", filename: `${source.clientName}-Apex-CATR.pdf`,
        createdBy: actor.email, accountNumber: source.statementAccountNumber, positions, content: output }),
      acatRecordId: recordId, preparationSnapshot: snapshot, serviceOrigin: actor.serviceAccount,
    }, select: { id: true } });
    await tx.transferPreparationOperation.create({ data: { acatRecordId: recordId, actorEmail: actor.email,
      operationId: request.operationId, kind: "GENERATE", requestHash, confirmationId: confirmation.id,
      documentId: document.id, serviceOrigin: actor.serviceAccount } });
    await tx.auditLog.create({ data: { acatRecordId: recordId, action: "ops-portal-transfer-form-generate", field: "documentId",
      oldValue: null, newValue: document.id, performedBy: actor.email } });
    return { documentId: document.id };
  });
}

export async function getPreparationDocument(recordId: string, documentId: string) {
  const document = await prisma.acatDocument.findFirst({ where: { id: documentId, acatRecordId: recordId,
    kind: "TRANSFER_FORM", acatRecord: { deletedAt: null } },
    select: { id: true, filename: true, content: true, sha256: true } });
  if (!document) fail("not_found");
  const content = Buffer.from(document.content);
  if (createHash("sha256").update(content).digest("hex") !== document.sha256) fail("unavailable");
  return { ...document, content, filename: safeDocumentFilename(document.filename, "pdf") };
}
