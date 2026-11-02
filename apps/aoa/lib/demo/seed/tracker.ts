// Demo seed part: the Transfer Tracker's records and the custodian library. AoA is the source of truth for the
// delivering firms; in production the library came over from the tracker once (the custodian snapshot import,
// keeping the tracker's custodian ids) and every save since is an authority revision the tracker confirms. The
// seed leaves the library as that import left it, then writes the tracker demo's plan (tracker-plan.ts) into the
// tracker stand-in: one record per transfer (kind "acat") and the Cedar Ridge client directory (kind "client").
// Story transfers also carry their receiving-title confirmation and the transfer form, made by the stand-in's own
// preparation code, so the drawer's paperwork reads as it does in the tracker demo.

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CUSTODIAN_AUTHORITY_SAVE } from "@/lib/audit";
import {
  IMPORT_IDENTITY, canonicalJson, feeDigest, profileDigest, sha256Hex, type CustodianSnapshot, type CustodianSnapshotCustodian,
} from "@/lib/data/custodian-snapshot-import";
import { PreparationError, confirmTitle, generateForm, sourceRevision } from "../stand-ins/tracker-forms";
import type { TrackerRecord } from "../stand-ins/tracker-model";
import { actAsWrite, insertWrite, runInOrder, type Write } from "./batch";
import { addBusinessDays } from "./calendar";
import type { SeedContext, TrackerStoryRecord } from "./context";
import { accountOwners } from "./people";
import { DUPLICATE_FIRM, TRACKER_ACCOUNT_TYPE, firmCustodianId, money, planDemoTransfers, type DemoFirm, type PlannedTransfer } from "./tracker-plan";
import { ownerNames, trackerDirectory, trackerSeed, trackerStaff } from "./tracker-records";
import { demoCuid, seededInt, type Universe } from "./universe";

// The receiving registration each universe account type confirms as (the stand-in's registration list).
const REGISTRATION: Record<string, string> = {
  "joint-taxable": "Joint tenants with rights of survivorship",
  individual: "Individual",
  trust: "Trust",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "SEP IRA",
  "roth-ira": "Roth IRA",
};

const hex = (key: string, length = 32) => createHash("sha256").update(`demo-tracker:${key}`).digest("hex").slice(0, length);

// --- the custodian library ---

/** The firm's library card as the tracker exported it for the import (CustodianSnapshotCustodian). */
function snapshotCustodian(firm: DemoFirm, transfersToDate: number, importedAt: string): CustodianSnapshotCustodian {
  const id = firmCustodianId(firm);
  return {
    id,
    name: firm.name,
    reviewStatus: firm.review,
    acatFeeAmount: firm.fees.find((fee) => fee.transferType === "FULL")?.amount ?? firm.fees[0]?.amount ?? 0,
    transferType: firm.transferType,
    documentationStatus: firm.documentation,
    dtcNumber: firm.dtc,
    receivingAccountNumber: firm.receivingAccountNumber ?? null,
    signature: firm.signature ?? null,
    letterOfAcceptance: firm.letterOfAcceptance ?? null,
    medallionRequired: firm.medallionRequired ?? null,
    liquidationMethod: firm.liquidationMethod ?? null,
    returnMethod: firm.returnMethod ?? null,
    watchouts: firm.watchouts ?? null,
    paperworkOnFile: firm.paperworkOnFile ?? null,
    transfersToDate,
    avgProcessingDays: firm.avgDays,
    contactEmail: null,
    contactMethod: null,
    contactDetails: null,
    fees: firm.fees.map((fee, i) => ({
      id: `${id}-fee-${i + 1}`,
      feeType: fee.feeType,
      accountType: fee.accountType ?? "ANY",
      transferType: fee.transferType ?? "ANY",
      direction: fee.direction ?? "ANY",
      amount: fee.amount,
      amountText: fee.amountText ?? null,
      notes: fee.notes ?? null,
      documentation: fee.documentation ?? null,
      createdAt: importedAt,
      updatedAt: importedAt,
    })),
    feeScheduleDocuments: [],
  };
}

/** A one-page summary of a firm's published transfer fees (the tracker demo's fee-schedule-pdf.ts). */
async function feeSchedulePdf(firm: DemoFirm): Promise<Uint8Array> {
  const ink = rgb(0.12, 0.14, 0.17);
  const muted = rgb(0.4, 0.42, 0.46);
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(`${firm.name} transfer fee summary (demo)`);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);
  page.drawText(firm.name, { x: 54, y: 730, size: 18, font: bold, color: ink });
  page.drawText("Transfer fee summary", { x: 54, y: 708, size: 12, font: regular, color: ink });
  const source = [...new Set(firm.fees.map((f) => f.documentation).filter(Boolean))].join("; ");
  page.drawText(`Source: ${source}`, { x: 54, y: 690, size: 9, font: regular, color: muted });
  page.drawLine({ start: { x: 54, y: 676 }, end: { x: 558, y: 676 }, thickness: 1, color: ink });
  page.drawText("Service", { x: 54, y: 656, size: 9, font: bold, color: ink });
  page.drawText("Fee", { x: 470, y: 656, size: 9, font: bold, color: ink });
  let y = 636;
  for (const f of firm.fees) {
    page.drawText(f.feeType + (f.accountType === "IRA" ? " (IRA)" : ""), { x: 54, y, size: 10, font: regular, color: ink });
    page.drawText(f.amount != null ? money(f.amount) : f.amountText ?? "Ask", { x: 470, y, size: 10, font: regular, color: ink });
    page.drawLine({ start: { x: 54, y: y - 7 }, end: { x: 558, y: y - 7 }, thickness: 0.5, color: rgb(0.78, 0.8, 0.83) });
    y -= 24;
  }
  y -= 12;
  for (const note of ["Fees are charged to the account when assets leave the firm.", "Check the firm's current published schedule before relying on an amount."]) {
    page.drawText(note, { x: 54, y, size: 8.5, font: regular, color: muted });
    y -= 14;
  }
  page.drawText("Summary sheet made for a portfolio demo from the firm's published fees. Not a document from the firm.", {
    x: 54, y: 40, size: 7.5, font: regular, color: rgb(0.7, 0.13, 0.13),
  });
  return document.save({ useObjectStreams: false });
}

/** One move of the library's revision pointer, as the save's update of the state row makes it, dated with the import
 *  rather than the time the seed runs. */
const authorityState = (column: "accepted_revision" | "confirmed_revision", revision: number, at: Date): Write => ({
  sql: `UPDATE app.custodian_authority_state SET ${column} = ($1->>'revision')::bigint, updated_at = ($1->>'at')::timestamptz WHERE id = 1`,
  params: { revision, at },
});

/**
 * The library as the one-time import left it: each firm saved as one authority revision (profile, fee rules,
 * change-log event, audit row), each revision confirmed by the tracker, and the import's evidence. Then the
 * tracker demo's fee-schedule summaries, uploaded later by the operations lead.
 */
async function seedCustodianLibrary(ctx: SeedContext, firms: DemoFirm[], transfers: PlannedTransfer[]) {
  const { owner, today } = ctx;
  const { reviewer } = trackerStaff(ctx.universe);
  const transfersToDate = new Map<string, number>();
  for (const t of transfers) transfersToDate.set(t.firm.name, (transfersToDate.get(t.firm.name) ?? 0) + 1);
  const importedAt = ctx.at(addBusinessDays(today, -125), "custodian-import");
  const snapshot: CustodianSnapshot = {
    schemaVersion: 1,
    custodians: firms.map((f) => snapshotCustodian(f, transfersToDate.get(f.name) ?? 0, importedAt.toISOString())),
  };
  const snapshotSha256 = sha256Hex(Buffer.from(canonicalJson(snapshot)));

  // The writes go in the order the import made them, one firm after another (runInOrder), so the row-change trail and
  // the audit log number their rows as the import's did; each firm's change-log event carries the card as saved.
  const runId = demoCuid(`custodian-import:${snapshotSha256}`);
  const writes: Write[] = [
    // The import's identity, so the row-change trail names it as the import did.
    actAsWrite("ADMIN", IMPORT_IDENTITY.email),
    insertWrite("app.custodian_snapshot_import", [{ id: runId, snapshot_sha256: snapshotSha256, created_at: importedAt }]),
  ];
  let fees = 0;
  for (const [index, c] of snapshot.custodians.entries()) {
    const revision = index + 1;
    const profile = {
      id: c.id, name: c.name, acat_fee_amount: c.acatFeeAmount, avg_processing_days: c.avgProcessingDays,
      contact_email: null, contact_method: null, contact_details: null, review_status: c.reviewStatus,
      transfer_type: c.transferType, documentation_status: c.documentationStatus, dtc_number: c.dtcNumber,
      receiving_account_number: c.receivingAccountNumber, signature: c.signature, letter_of_acceptance: c.letterOfAcceptance,
      medallion_required: c.medallionRequired, liquidation_method: c.liquidationMethod, return_method: c.returnMethod,
      watchouts: c.watchouts, paperwork_on_file: c.paperworkOnFile, transfers_to_date: c.transfersToDate,
      revision, created_at: importedAt, updated_at: importedAt,
    };
    const rules = c.fees.map((fee) => ({
      id: fee.id, custodian_id: c.id, fee_type: fee.feeType, account_type: fee.accountType, transfer_type: fee.transferType,
      direction: fee.direction, amount: fee.amount, amount_text: fee.amountText, notes: fee.notes,
      documentation: fee.documentation, revision, created_at: importedAt, updated_at: importedAt,
    }));
    fees += rules.length;
    // The change-log event carries the saved card, as saveCustodianAuthority's custodianSnapshot writes it: the
    // profile and its live fee rules by id, as the database returns them (bigints as strings).
    const card = (row: object) => ({
      ...row, retired_at: null, revision: String(revision), created_at: importedAt.toISOString(), updated_at: importedAt.toISOString(),
    });
    const payload = {
      ...card(profile), merged_into_id: null,
      fee_rules: [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(card),
    };
    writes.push(
      insertWrite("app.custodian_profile", [profile]),
      ...(rules.length ? [insertWrite("app.custodian_fee_rule", rules)] : []),
      insertWrite("app.custodian_authority_event", [{
        revision, kind: "CUSTODIAN_SAVE", custodian_id: c.id, payload, actor_email: IMPORT_IDENTITY.email, created_at: importedAt,
      }]),
      insertWrite('audit."AuditLog"', [{
        at: importedAt, actorEmail: IMPORT_IDENTITY.email, actorRole: IMPORT_IDENTITY.role, action: CUSTODIAN_AUTHORITY_SAVE,
        entityType: "custodian", entityId: c.id,
        detail: JSON.stringify({ revision: String(revision), created: true, feeRules: c.fees.length, retiredFeeRules: 0 }),
      }]),
      // Accepted by the save, then confirmed by the tracker's copy.
      authorityState("accepted_revision", revision, importedAt),
      authorityState("confirmed_revision", revision, importedAt),
      insertWrite("app.custodian_snapshot_import_item", [
        { kind: "custodian", originalId: c.id, ...profileDigest(c) },
        ...c.fees.map((fee) => ({ kind: "fee_rule", originalId: fee.id, ...feeDigest(fee) })),
      ].map(({ kind, originalId, byteCount, checksum }) => ({
        id: demoCuid(`custodian-import-item:${kind}:${originalId}`), import_id: runId, kind, original_id: originalId,
        authority_id: originalId, revision, confirmed: true, byte_count: byteCount, checksum,
      }))),
    );
  }
  await owner.$transaction((tx) => runInOrder(tx, writes), { maxWait: 20_000, timeout: 120_000 });

  const documents: Prisma.CustodianFeeScheduleDocumentCreateManyInput[] = [];
  for (const firm of firms.filter((f) => f.feeSummary)) {
    const bytes = await feeSchedulePdf(firm);
    documents.push({
      id: `fsd-${firm.prefix.toLowerCase()}`,
      custodianId: firmCustodianId(firm),
      filename: `${firm.prefix.toLowerCase()}-fee-schedule.pdf`,
      contentType: "application/pdf",
      content: Buffer.from(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      createdBy: reviewer,
      createdAt: ctx.at(addBusinessDays(today, -seededInt(`${firm.name}:fee-doc`, 20, 120)), `${firm.name}:fee-doc`),
    });
  }
  await owner.custodianFeeScheduleDocument.createMany({ data: documents });
  return { custodians: snapshot.custodians.length, fees, documents: documents.length };
}

// --- transfer paperwork on the story records ---

/**
 * The receiving-title confirmation and the transfer form for a story transfer the tracker demo gives a form,
 * made with the stand-in's own preparation code and dated the day the form went out.
 */
async function addTransferForm(
  r: TrackerRecord, t: PlannedTransfer, universe: Universe, actor: string, at: SeedContext["at"], now: Date,
): Promise<boolean> {
  const owners = accountOwners(universe, t.account);
  const formAt = at(t.submissionDay ?? t.requestDay, `${t.id}:TRANSFER_FORM`);
  const confirmedAt = new Date(formAt.getTime() - 6 * 60_000);
  const partial = t.type === "Partial";
  try {
    confirmTitle(r, {
      expectedRevision: sourceRevision(r), operationId: `${t.id}:seed-confirm`,
      title: `${ownerNames(owners)} - ${TRACKER_ACCOUNT_TYPE[t.account.type]}`, registration: REGISTRATION[t.account.type] ?? "Individual",
    }, actor);
    // The confirmation's stable id and its own time before the form names it, so the form request's hash is the same on
    // every seed.
    Object.assign(r.titleConfirmation!, { id: hex(`${t.id}:confirmation`), confirmedAt: confirmedAt.toISOString() });
    await onSeedClock(now, () => generateForm(r, {
      expectedRevision: sourceRevision(r), confirmationId: r.titleConfirmation!.id, operationId: `${t.id}:seed-form`,
      workflowId: "default-brokerage-firm-transfer",
      assetInstruction: partial ? "MIXED" : "IN_KIND",
      ...(partial ? {
        positionInstructions: r.assets.map((a) => ({
          positionId: a.id, assetInstruction: a.mappingTransferStatus === "Liquidate" ? "LIQUIDATE" as const : "IN_KIND" as const,
        })),
      } : {}),
      deliveringTitle: ownerNames(owners),
      letterOfAuthorizationRequired: t.firm.letterOfAcceptance === "Required",
    }, actor));
  } catch (error) {
    if (error instanceof PreparationError) return false;
    throw error;
  }
  // Stable ids, and the form's own day instead of the seed's clock.
  const document = r.documents[0];
  const documentId = hex(`${t.id}:form`);
  for (const op of r.operations) if (op.documentId === document.id) op.documentId = documentId;
  for (const entry of r.history) {
    if (entry.action === "transfer-title-confirm") Object.assign(entry, { id: `${t.id}-h-confirm`, timestamp: confirmedAt.toISOString() });
    if (entry.action === "transfer-form-generate") Object.assign(entry, { id: `${t.id}-h-form`, newValue: documentId, timestamp: formAt.toISOString() });
  }
  r.history.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const safeName = r.clientName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  Object.assign(document, { id: documentId, filename: `${safeName}-Apex-CATR.pdf`, createdAt: formAt.toISOString() });
  return true;
}

/**
 * Runs `fn` with the clock reading `now`: the stand-in's form code stamps the PDF it makes (its creation date, the
 * "Prepared" line) with the time, and on the seed's clock the same seed makes the same bytes.
 */
async function onSeedClock<T>(now: Date, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const at = now.getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(at);
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return at;
    }
  } as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// --- the part ---

export async function seedTracker(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe, now } = ctx;
  const plan = planDemoTransfers(universe, now);
  const seed = trackerSeed(universe, plan, now, ctx.at);
  const byId = new Map(seed.records.map((r) => [r.id, r]));
  const { operator } = trackerStaff(universe);

  const library = await seedCustodianLibrary(ctx, plan.firms, plan.transfers);

  let forms = 0;
  for (const t of plan.transfers) {
    if (t.storyId && t.documents.includes("TRANSFER_FORM") && await addTransferForm(byId.get(t.id)!, t, universe, operator, ctx.at, now)) forms++;
  }

  const directory = trackerDirectory(universe);
  await ctx.standIns("tracker", [
    ...seed.records.map((r, i) => ({ kind: "acat", id: r.id, doc: r, position: i + 1 })),
    ...directory.map((c, i) => ({ kind: "client", id: c.cedarRidgeUserId, doc: c, position: i + 1 })),
  ]);

  const stories = new Map<string, TrackerStoryRecord>();
  for (const t of plan.transfers) {
    if (!t.storyId) continue;
    const r = byId.get(t.id)!;
    stories.set(t.storyId, {
      storyId: t.storyId, trackerId: r.id, acatTransferId: r.acatTransferId, controlNumber: r.controlNumber, status: r.status,
      custodianId: r.custodianId, custodianName: r.custodianName, requestDay: t.requestDay, submissionDay: t.submissionDay,
      completionDay: t.completionDay,
    });
  }
  ctx.shared.tracker = {
    stories,
    custodianIds: new Map(plan.firms.map((f) => [f.name, firmCustodianId(f)])),
    records: seed.records.length,
  };

  return {
    custodians: library.custodians,
    feeRules: library.fees,
    feeScheduleDocuments: library.documents,
    records: seed.records.length,
    assets: seed.records.reduce((n, r) => n + r.assets.length, 0),
    historyEntries: seed.records.reduce((n, r) => n + r.history.length, 0),
    feeCredits: seed.feeCredits.length,
    reviews: seed.reviews,
    transferForms: forms,
    directoryClients: directory.length,
    directoryAccounts: new Set(directory.flatMap((c) => c.accounts.map((a) => a.investmentAccountId))).size,
    duplicateFirmRecords: seed.records.filter((r) => r.custodianName === DUPLICATE_FIRM).length,
  };
}
