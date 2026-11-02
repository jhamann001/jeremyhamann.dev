// Transfer paperwork in the demo's Transfer Tracker: the preparation AoA's Paperwork section reads, the receiving
// title confirmation, the full/partial scope change, and the generated transfer request PDF. The rules follow the
// tracker demo's lib/transfer-preparation-service.ts (blockers, revision check, replayed operations, one live title
// confirmation). Two simplifications: every linked custodian gets the tracker's standard brokerage-transfer
// workflow (the custodian-specific form catalog is not part of the demo), and the PDF is a one-page form drawn
// here with the same fields, not the clearing firm's form template.

import { createHash, randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { maskIdentifier, type TrackerRecord } from "./tracker-model";

export const TRANSFER_FORM_RULE_VERSION = "aoa-demo-catr-v1";
const WORKFLOW_ID = "default-brokerage-firm-transfer";
const REGISTRATIONS = new Set([
  "Individual", "Joint tenants with rights of survivorship", "Joint tenants in common", "Community Property", "Traditional IRA",
  "Roth IRA", "Inherited Traditional IRA", "Inherited Roth IRA", "SEP IRA", "SIMPLE IRA", "Trust",
]);

export type PreparationFailure = "invalid" | "not_found" | "stale" | "review_required";
export class PreparationError extends Error {
  constructor(readonly reason: PreparationFailure) { super(reason); }
}
const fail = (reason: PreparationFailure): never => { throw new PreparationError(reason); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The custodian playbook fields the requirements list reads (AoA's custodian authority profile). */
export interface CustodianPlaybook {
  id: string;
  name: string;
  signature: string | null;
  letterOfAcceptance: string | null;
  medallionRequired: string | null;
  liquidationMethod: string | null;
  returnMethod: string | null;
  watchouts: string | null;
}

function direction(r: TrackerRecord) {
  const v = r.direction?.trim().toLowerCase();
  return v === "in" || v === "incoming" ? "INCOMING" : v === "out" || v === "outgoing" ? "OUTGOING" : "UNKNOWN";
}
function scope(r: TrackerRecord) {
  const v = r.type?.trim().toLowerCase() ?? "";
  return ["full", "full transfer", "full account transfer"].includes(v) ? "FULL"
    : ["partial", "partial transfer", "partial account transfer"].includes(v) ? "PARTIAL" : "UNKNOWN";
}
function realAccount(value: string | null): boolean {
  const compact = value?.trim() ?? "";
  return compact.length >= 5 && compact.length <= 100 && /\d/.test(compact) && !/[*•]/.test(compact)
    && !/^(?:n\/?a|none|null|unknown|pending|tbd|0+)$/i.test(compact) && /^[A-Za-z0-9 ._-]+$/.test(compact);
}

export function receivingFingerprint(r: TrackerRecord): string {
  return hash({ recordId: r.id, receivingAccount: r.apexAccountId, sourceAccountType: r.accountType,
    identityVersion: r.identityVersion, cedarRidgeUserIds: r.cedarRidgeUserIds, clientName: r.clientName });
}

const confirmationValid = (r: TrackerRecord) =>
  Boolean(r.titleConfirmation && r.titleConfirmation.fingerprint === receivingFingerprint(r) && REGISTRATIONS.has(r.titleConfirmation.registration));

export function sourceRevision(r: TrackerRecord): string {
  return hash({ schemaVersion: 1, ruleVersion: TRANSFER_FORM_RULE_VERSION, source: {
    id: r.id, clientName: r.clientName, cedarRidgeUserIds: r.cedarRidgeUserIds, identityVersion: r.identityVersion,
    direction: r.direction, type: r.type, accountType: r.accountType, status: r.status, transferWorkflow: r.transferWorkflow,
    apexAccountId: r.apexAccountId, statementAccountNumber: r.statementAccountNumber, transferringContra: r.transferringContra,
    dtccNumber: r.dtccNumber, custodianId: r.custodianId, mappingSyncedAt: r.mappingSyncedAt, titleConfirmation: r.titleConfirmation,
    assets: r.assets.map((a) => ({ id: a.id, symbol: a.symbol, description: a.description, cusip: a.cusip, expectedQty: a.expectedQty,
      amount: a.amount, assetClass: a.assetClass, includeInTransfer: a.includeInTransfer ?? null })),
  } });
}

function workflows(r: TrackerRecord) {
  if (!r.custodianId) return [];
  const name = r.transferringContra?.trim() || r.custodianName || "Delivering firm";
  return [{
    id: WORKFLOW_ID, name: "Standard brokerage transfer", automated: true, requiresReceivingAccountNumber: false,
    handling: { mode: "CLIENT_DIRECTED" as const, options: ["IN_KIND", "LIQUIDATE"] as ("IN_KIND" | "LIQUIDATE")[] },
    note: `No custodian-specific form rule is configured for ${name}. Brokerage Firm Transfer is selected by default; verify it against the current client request.`,
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST" as const,
  }];
}

function blockers(r: TrackerRecord) {
  const out: { code: string; message: string }[] = [];
  const block = (code: string, message: string) => out.push({ code, message });
  if (direction(r) !== "INCOMING") block("incoming_required", "Preparation requires a confirmed incoming transfer.");
  if (scope(r) === "UNKNOWN") block("scope_required", "Confirm full or partial transfer in the tracker.");
  if (!realAccount(r.apexAccountId) || !realAccount(r.statementAccountNumber)) block("accounts_required", "Both account identifiers must be complete and verified in the tracker.");
  if (!r.custodianId) block("custodian_required", "Link the delivering custodian in the tracker.");
  if (["DRS", "RESIDUAL"].includes(r.transferWorkflow)) block("workflow_unsupported", "This transfer method requires a separate workflow.");
  if (["Canceled", "Purged"].includes(r.status)) block("inactive_transfer", "This transfer is no longer active.");
  if (!workflows(r).length) block("form_unavailable", "No reviewed automated form workflow is available for this custodian.");
  if (r.assets.length > 5000) block("positions_limit", "The position list exceeds the supported preparation limit.");
  if (scope(r) === "PARTIAL") {
    if (r.assets.some((a) => a.includeInTransfer == null)) block("positions_undecided", "Choose Yes or No for every holding in the tracker.");
    if (!r.assets.some((a) => a.includeInTransfer === true)) block("positions_empty", "Include at least one holding in the tracker.");
  }
  const selected = scope(r) === "PARTIAL" ? r.assets.filter((a) => a.includeInTransfer === true) : r.assets;
  if (selected.some((a) => !Number.isFinite(a.expectedQty) || a.expectedQty < 0)) block("positions_invalid", "Review the source holding quantities in the tracker.");
  return out;
}

/** The preparation AoA's transfer-form contract reads. */
export function buildPreparation(r: TrackerRecord, custodian: CustodianPlaybook | null) {
  const valid = confirmationValid(r);
  const c = r.titleConfirmation;
  const requirements: { label: string; value: string }[] = [];
  for (const [label, value] of [
    ["Client signature", custodian?.signature], ["Letter of Acceptance (custodian wording)", custodian?.letterOfAcceptance],
    ["Medallion", custodian?.medallionRequired], ["Liquidation instructions", custodian?.liquidationMethod],
    ["Return method", custodian?.returnMethod], ["Watchouts", custodian?.watchouts],
  ] as const) if (value) requirements.push({ label, value });
  const notices: string[] = [];
  if (r.cedarRidgeUserIds.length > 1) notices.push("Both account holders must sign; generation does not collect signatures.");
  notices.push("Letter of Acceptance wording is separate from the Letter of Authorization section. Confirm the authorization choice explicitly.");
  notices.push("Account type is a source hint only. Confirm the receiving registration against Apex.");
  const blocking = blockers(r);
  if (!valid) blocking.push({ code: "receiving_confirmation", message: "Confirm the exact receiving title and registration against Apex." });
  return {
    schemaVersion: 1 as const, recordId: r.id, sourceRevision: sourceRevision(r), checkedAt: new Date().toISOString(),
    direction: direction(r), scope: scope(r),
    transferMethod: (["ACAT", "MANUAL", "DRS", "RESIDUAL"].includes(r.transferWorkflow) ? r.transferWorkflow
      : r.transferWorkflow === "PAPERWORK" ? "MANUAL" : "UNCLASSIFIED"),
    custodian: r.custodianId ? { id: r.custodianId, name: custodian?.name ?? r.custodianName } : null,
    accounts: {
      receivingMasked: maskIdentifier(r.apexAccountId) ?? "", deliveringMasked: maskIdentifier(r.statementAccountNumber) ?? "",
      receivingTitleSuggestion: c?.title ?? r.clientName, deliveringTitleSuggestion: r.clientName, registrationSuggestion: null,
    },
    confirmation: c ? { id: c.id, title: c.title, registration: c.registration, confirmedBy: c.confirmedBy,
      confirmedAt: c.confirmedAt, valid, source: "AOA" as const } : null,
    workflows: workflows(r),
    positions: r.assets.slice(0, 5000).map((a) => ({ id: a.id, symbol: a.symbol, description: a.description,
      quantity: Number.isFinite(a.expectedQty) ? a.expectedQty : 0, include: a.includeInTransfer ?? null })),
    inheritedTitleReview: /inherit/i.test(r.accountType ?? ""),
    requirements, notices, blockers: blocking,
    documents: [...r.documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 100)
      .map((d) => ({ id: d.id, filename: d.filename, createdBy: d.createdBy, createdAt: d.createdAt, sha256: d.sha256 })),
    ruleVersion: TRANSFER_FORM_RULE_VERSION,
  };
}

type Operation = TrackerRecord["operations"][number];
function replayed(r: TrackerRecord, actor: string, operationId: string, kind: Operation["kind"], requestHash: string): Operation | null {
  const prior = r.operations.find((o) => o.operationId === operationId && o.actorEmail === actor) ?? null;
  if (prior && (prior.kind !== kind || prior.requestHash !== requestHash)) fail("invalid");
  return prior;
}

const historyEntry = (action: string, field: string, oldValue: string | null, newValue: string | null, performedBy: string) =>
  ({ id: randomUUID(), action, field, oldValue, newValue, performedBy, timestamp: new Date().toISOString() });

/** PUT: confirm the receiving title and registration. Changes `r` in place. */
export function confirmTitle(r: TrackerRecord, body: { expectedRevision: string; operationId: string; title: string; registration: string }, actor: string) {
  const requestHash = hash(body);
  if (replayed(r, actor, body.operationId, "CONFIRM_TITLE", requestHash)) return;
  if (sourceRevision(r) !== body.expectedRevision) fail("stale");
  if (!realAccount(r.apexAccountId)) fail("review_required");
  if (!REGISTRATIONS.has(body.registration)) fail("invalid");
  const current = confirmationValid(r) ? r.titleConfirmation : null;
  if (!current || current.title !== body.title || current.registration !== body.registration) {
    r.titleConfirmation = { id: randomUUID().replace(/-/g, ""), title: body.title.trim(), registration: body.registration,
      confirmedBy: actor, confirmedAt: new Date().toISOString(), fingerprint: receivingFingerprint(r) };
    r.history.unshift(historyEntry("transfer-title-confirm", "verifiedApexAccountTitle", current?.title ?? null, r.titleConfirmation.title, actor));
  }
  r.operations.push({ operationId: body.operationId, actorEmail: actor, kind: "CONFIRM_TITLE", requestHash, documentId: null });
}

/** PATCH: set the transfer to full or partial. Changes `r` in place. */
export function changeScope(r: TrackerRecord, body: { expectedRevision: string; operationId: string; scope: "FULL" | "PARTIAL" }, actor: string) {
  const requestHash = hash(body);
  if (replayed(r, actor, body.operationId, "UPDATE_SCOPE", requestHash)) return;
  if (sourceRevision(r) !== body.expectedRevision) fail("stale");
  if (direction(r) !== "INCOMING" || ["DRS", "RESIDUAL"].includes(r.transferWorkflow)) fail("review_required");
  if (scope(r) !== body.scope) {
    const next = body.scope === "FULL" ? "Full" : "Partial";
    r.history.unshift(historyEntry("transfer-scope-update", "type", r.type, next, actor));
    r.type = next;
    r.lastUpdated = new Date().toISOString();
  }
  r.operations.push({ operationId: body.operationId, actorEmail: actor, kind: "UPDATE_SCOPE", requestHash, documentId: null });
}

export interface GenerateBody {
  expectedRevision: string;
  confirmationId: string;
  operationId: string;
  workflowId: string;
  assetInstruction: "IN_KIND" | "LIQUIDATE" | "MIXED";
  positionInstructions?: { positionId: string; assetInstruction: "IN_KIND" | "LIQUIDATE" }[];
  deliveringTitle: string;
  receivingAccountNumber?: string;
  letterOfAuthorizationRequired: boolean;
}

/** POST: generate the transfer request PDF. Changes `r` in place and returns the document id. */
export async function generateForm(r: TrackerRecord, body: GenerateBody, actor: string): Promise<string> {
  const requestHash = hash(body);
  const prior = replayed(r, actor, body.operationId, "GENERATE", requestHash);
  if (prior?.documentId) return prior.documentId;
  if (sourceRevision(r) !== body.expectedRevision) fail("stale");
  if (blockers(r).length || !confirmationValid(r)) fail("review_required");
  if (r.titleConfirmation!.id !== body.confirmationId) fail("stale");
  if (!workflows(r).some((w) => w.id === body.workflowId)) fail("review_required");
  const partial = scope(r) === "PARTIAL";
  const included = r.assets.filter((a) => (partial ? a.includeInTransfer === true : true));
  const instructions = new Map(body.positionInstructions?.map((p) => [p.positionId, p.assetInstruction]));
  if (body.assetInstruction === "MIXED") {
    if (!partial || instructions.size !== included.length || included.some((a) => !instructions.has(a.id))
      || new Set(instructions.values()).size !== 2) fail("invalid");
  } else if (body.positionInstructions !== undefined) {
    fail("invalid");
  }
  if (/inherit/i.test(r.accountType ?? "") && !body.letterOfAuthorizationRequired
    && body.deliveringTitle.trim().toLowerCase() !== r.titleConfirmation!.title.trim().toLowerCase()) fail("review_required");
  const selection = partial ? "Partial transfer" : body.assetInstruction === "LIQUIDATE" ? "Liquidate all assets and transfer as cash" : "Brokerage firm transfer";
  const bytes = await transferRequestPdf(r, {
    deliveringTitle: body.deliveringTitle.trim(), selection, assetInstruction: body.assetInstruction,
    letterOfAuthorizationRequired: body.letterOfAuthorizationRequired,
    positions: included.map((a) => ({ symbol: a.symbol, description: a.description, quantity: a.expectedQty,
      instruction: body.assetInstruction === "MIXED" ? instructions.get(a.id)! : body.assetInstruction })),
  });
  const document = {
    id: randomUUID().replace(/-/g, ""), kind: "TRANSFER_FORM" as const, filename: `${r.clientName}-Apex-CATR.pdf`,
    createdBy: actor, createdAt: new Date().toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"),
    content: Buffer.from(bytes).toString("base64"),
  };
  // Keep the newest ten forms on the record; the store's row has a size limit.
  r.documents = [document, ...r.documents].slice(0, 10);
  r.operations.push({ operationId: body.operationId, actorEmail: actor, kind: "GENERATE", requestHash, documentId: document.id });
  r.history.unshift(historyEntry("transfer-form-generate", "documentId", null, document.id, actor));
  return document.id;
}

interface FormInput {
  deliveringTitle: string;
  selection: string;
  assetInstruction: string;
  letterOfAuthorizationRequired: boolean;
  positions: { symbol: string; description: string; quantity: number; instruction: string }[];
}

async function transferRequestPdf(r: TrackerRecord, input: FormInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Customer account transfer request: ${r.clientName}`);
  doc.setProducer("Always-On-Advice demo");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.14, 0.17);
  const muted = rgb(0.4, 0.42, 0.46);
  let y = 740;
  const line = (label: string, value: string) => {
    page.drawText(label, { x: 48, y, size: 8, font, color: muted });
    page.drawText(value.slice(0, 80), { x: 210, y, size: 10, font, color: ink });
    y -= 18;
  };
  const heading = (text: string) => {
    y -= 6;
    page.drawRectangle({ x: 42, y: y - 4, width: 528, height: 16, color: rgb(0.23, 0.44, 0.63) });
    page.drawText(text, { x: 48, y, size: 9, font: bold, color: rgb(1, 1, 1) });
    y -= 22;
  };
  page.drawText("Customer Account Transfer Request", { x: 48, y, size: 16, font: bold, color: ink });
  y -= 16;
  page.drawText("Portfolio demo of Cedar Ridge Wealth: every person and account is invented. Not a clearing firm form.", { x: 48, y, size: 8, font, color: muted });
  y -= 22;
  heading("A  Receiving account");
  line("Account title", r.titleConfirmation?.title ?? r.clientName);
  line("Registration", r.titleConfirmation?.registration ?? "");
  line("Account number", r.apexAccountId);
  heading("B  Delivering account");
  line("Delivering firm", r.transferringContra?.trim() || r.custodianName);
  line("Clearing number (DTC)", r.dtccNumber ?? "");
  line("Account title", input.deliveringTitle);
  line("Account number", r.statementAccountNumber ?? "");
  heading("C  Transfer instructions");
  line("Transfer type", input.selection);
  line("Asset instruction", input.assetInstruction === "MIXED" ? "Per position (below)" : input.assetInstruction === "LIQUIDATE" ? "Liquidate" : "In kind");
  line("Letter of authorization", input.letterOfAuthorizationRequired ? "Required" : "Not required");
  line("Prepared", new Date().toISOString().slice(0, 10));
  heading("D  Positions");
  for (const p of input.positions.slice(0, 24)) {
    page.drawText(p.symbol.slice(0, 10), { x: 48, y, size: 9, font: bold, color: ink });
    page.drawText(p.description.slice(0, 48), { x: 110, y, size: 9, font, color: ink });
    page.drawText(p.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 }), { x: 400, y, size: 9, font, color: ink });
    page.drawText(p.instruction === "LIQUIDATE" ? "Liquidate" : "In kind", { x: 490, y, size: 9, font, color: ink });
    y -= 14;
  }
  if (input.positions.length > 24) page.drawText(`… and ${input.positions.length - 24} more positions`, { x: 48, y, size: 8, font, color: muted });
  page.drawText("Client signature ______________________________     Date ____________", { x: 48, y: 72, size: 10, font, color: ink });
  return doc.save();
}
