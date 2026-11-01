import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockDirectory, resolveClientIdentities, replaceAcatRecordClients } from "@/lib/client-directory";
import { acatClientLinksSelection } from "@/lib/acat-identity-dto";
import { allowsPendingAccount } from "@/lib/client-identity-policy";
import { identityError, requireIdentityOperator } from "@/lib/client-identity-http";
import {
  createAcatSchema,
  updateAcatSchema,
  UPDATE_ACAT_ALLOWED_FIELDS,
  updateAssetSchema,
  createAssetSchema,
  formatZodError,
  requestedClientIds,
  boundedArray,
} from "@/lib/validators";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { resolveCustodianForContra } from "@/lib/custodian-resolve";
import { holdDemoQuota, holdTransferPositions } from "@/lib/demo/limits";
import { custodianProjectionEnabled } from "@/lib/custodian-admin";
import {
  AcatRecord,
  Asset,
  isResidualCreditTransfer,
  selectApplicableFees,
  type CustodianFee,
} from "@/lib/types";
import {
  RECON_AUTO_COMPLETE_THRESHOLD,
  hasApexUpload,
  hasGcpPositions,
  getReconRate,
} from "@/lib/acat-derivations";
import { redactAcatForMachine } from "@/lib/mcp/redaction";
import { normalizeStatementAmountSign } from "@/lib/format";
import {
  defaultResidualFollowUpDate,
  defaultFeeCharged,
  isDrsTransfer,
  isOutgoingTransfer,
  isResidualTransfer,
} from "@/lib/acat-operational-defaults";
import { selectedRuleFee, toHttpFee, type TransferFee } from "@/lib/acat-fee-contract";

type PersistedAcat = Parameters<typeof redactAcatForMachine>[0] & {
  clientLinks?: { cedarRidgeUserId: string; client: { canonicalName: string } }[];
  identitySetIds?: string[];
  cedarRidgeUserId?: string | null;
};

export type AcatWriteResult =
  | { kind: "response"; response: NextResponse }
  | { kind: "record"; record: PersistedAcat };

/**
 * Construct an in-memory `AcatRecord` shape representing what the DB row
 * will look like AFTER the PATCH transaction commits. Used by the
 * recon-auto-complete heuristic so it operates on post-write state.
 *
 * Only includes the subset of fields the derivation helpers actually
 * inspect (status, sources, assets). Anything else falls through from
 * the existing row.
 */
function simulatePostPatchRecord(
  existing: { assets: { id: string; mapStatus: string; expectedQty: number; actualQty: number }[]; status: string; apexSource: string; mappingSource: string; reconCompletedAt: string | null },
  data: Record<string, unknown>,
  assetUpdates: { id: string; actualQty?: number; mapStatus?: "Mapped" | "Unmapped" | "Pending" | "Expected" }[],
  newAssets: { mapStatus?: "Mapped" | "Unmapped" | "Pending" | "Expected"; expectedQty?: number; actualQty?: number }[]
): AcatRecord {
  const updateById = new Map(assetUpdates.map((au) => [au.id, au]));
  const mergedExisting: Asset[] = existing.assets.map((a) => {
    const upd = updateById.get(a.id);
    return {
      id: a.id,
      symbol: "",
      description: "",
      expectedQty: a.expectedQty,
      actualQty: upd?.actualQty ?? a.actualQty,
      mapStatus: (upd?.mapStatus ?? a.mapStatus) as Asset["mapStatus"],
    };
  });
  const synthesisedNew: Asset[] = newAssets.map((na, idx) => ({
    id: `__pending_${idx}`,
    symbol: "",
    description: "",
    expectedQty: na.expectedQty ?? 0,
    actualQty: na.actualQty ?? 0,
    mapStatus: (na.mapStatus ?? "Unmapped") as Asset["mapStatus"],
  }));

  return {
    id: "",
    clientName: "",
    apexAccountId: "",
    status: ((data.status as AcatRecord["status"]) ?? existing.status) as AcatRecord["status"],
    apexSource: (data.apexSource as string) ?? existing.apexSource,
    mappingSource: (data.mappingSource as string) ?? existing.mappingSource,
    reconCompletedAt: existing.reconCompletedAt,
    lastUpdated: "",
    crmDealId: "",
    custodianId: "",
    custodianName: "",
    acatDate: "",
    slackAlerted: false,
    assets: [...mergedExisting, ...synthesisedNew],
  };
}

export function confirmedFeeDecision(input: {
  projectionEnabled: boolean;
  projectionRevision: number | null;
  feeAmountAlreadySet: boolean;
  feeChargedIsNo: boolean;
}): "legacy" | "skip" | "fill" {
  if (!input.projectionEnabled) return "legacy";
  if (input.projectionRevision === null) return "skip";
  if (input.feeAmountAlreadySet || input.feeChargedIsNo) return "skip";
  return "fill";
}

function assignScheduleFees(
  fees: CustodianFee[],
  accountType: string | null | undefined,
  transferType: string | null | undefined,
  direction: string | null | undefined,
): { feeAmount: string | null; feeMemo: string; feeCharged: string } | null {
  const summary = selectApplicableFees(fees, accountType, transferType, direction);
  if (summary.fees.length === 0) return null;
  const feeMemo = summary.fees
    .map((f) => {
      const value = f.amount != null ? `$${f.amount.toFixed(2)}` : (f.amountText ?? "?");
      return `${f.feeType}: ${value}`;
    })
    .join(" + ");
  return {
    feeAmount: summary.total > 0 ? `$${summary.total.toFixed(2)}` : null,
    feeMemo,
    feeCharged: summary.total > 0 || summary.hasUnknownAmount ? "Yes" : "No",
  };
}

// Upper bounds on one PATCH's position lists, well above a real account (the largest
// mapping the app accepts is 500 positions).
const MAX_ASSET_UPDATES = 1000;
const MAX_NEW_ASSETS = 500;

export async function applyAcatCreate({
  body,
  performedBy,
}: {
  body: unknown;
  performedBy: string | null;
}): Promise<AcatWriteResult> {
    const parsed = createAcatSchema.safeParse(body);
    if (!parsed.success) {
      return {
        kind: "response",
        response: NextResponse.json(
          { error: formatZodError(parsed.error) },
          { status: 400 }
        ),
      };
    }

    const d = parsed.data;
    const selectedIds = requestedClientIds(d);
    if (!selectedIds.length) {
      return { kind: "response", response: identityError("IDENTITY_REQUIRED", "Search for and select a Cedar Ridge client", 400) };
    }
    const operator = performedBy ? null : await requireIdentityOperator();
    if (operator instanceof NextResponse) return { kind: "response", response: operator };
    // Workflow selection is enough to classify a residual, including API callers.
    // Normalize before computing fee and monitoring defaults.
    if (d.transferWorkflow === "RESIDUAL") d.type = "Residual Credit";
    const transferWorkflow =
      d.type === "Residual Credit" ? "RESIDUAL" : d.transferWorkflow || "UNCLASSIFIED";
    const monitorOutgoing = isOutgoingTransfer(d) && !isResidualTransfer(d);
    const custodian = await resolveCustodianForContra(d.transferringContra);
    const data = {
        clientName: d.clientName.trim(),
        acatTransferId: d.acatTransferId || undefined,
        accountType: d.accountType || undefined,
        additionalResources: d.additionalResources || undefined,
        apexAccountId: d.apexAccountId.trim(),
        apexCompletionDate: d.apexCompletionDate || undefined,
        apexTicket: d.apexTicket || undefined,
        associatedControlNumber: d.associatedControlNumber,
        controlNumber: d.controlNumber || undefined,
        dtccNumber: d.dtccNumber,
        direction: d.direction || undefined,
        crwEe: d.crwEe || undefined,
        feeAmount: d.feeAmount || undefined,
        feeCharged: d.feeCharged?.trim() || defaultFeeCharged({ ...d, transferWorkflow }),
        feeMemo: d.feeMemo || undefined,
        feeRequestCompleted: d.feeRequestCompleted || undefined,
        feeRequestSubmitted: d.feeRequestSubmitted || undefined,
        feeApexTicket: d.feeApexTicket || undefined,
        feeCreditRequestId: d.feeCreditRequestId || undefined,
        methodRequested: d.methodRequested || undefined,
        transferWorkflow,
        notes: d.notes || undefined,
        opsSubmissionDateToApex: d.opsSubmissionDateToApex || undefined,
        originalClientRequestDate: d.originalClientRequestDate || undefined,
        residualMonitoringRequired:
          d.residualMonitoringRequired ?? monitorOutgoing,
        residualFollowUpDate:
          d.residualFollowUpDate ||
          (monitorOutgoing ? defaultResidualFollowUpDate() : undefined),
        crmTicket: d.crmTicket || undefined,
        rejectionReason: d.rejectionReason || undefined,
        statementAccountNumber: d.statementAccountNumber || undefined,
        statementAmount:
          d.statementAmount == null
            ? undefined
            : normalizeStatementAmountSign(d.statementAmount, d.direction),
        status: d.status || "AcatReceived",
        transferringContra: d.transferringContra || undefined,
        tradeRequestId: d.tradeRequestId || undefined,
        tradeRequestUrl: d.tradeRequestUrl || undefined,
        tradeInstructions: d.tradeInstructions || undefined,
        type: d.type || undefined,
        wealthAdvisor: d.wealthAdvisor || undefined,
        lastUpdated: new Date().toISOString(),

        crmDealId: d.crmDealId || d.crmTicket || "",
        custodianId: custodian?.id ?? null,
        custodianName: custodian?.name ?? "",
        acatDate:
          d.acatDate ||
          d.originalClientRequestDate ||
          new Date().toISOString().split("T")[0],
        // The only "completion" date we track now is apexCompletionDate
        // (the date Apex reports the transfer settled). The legacy
        // completedDate column was dropped in ticket — it duplicated
        // apexCompletionDate.
        slackAlerted: false,
        mappingSource: "GCP Project API",
        apexSource: "Pending Upload",
      } satisfies Prisma.AcatRecordUncheckedCreateInput;
    const projectionEnabled = custodianProjectionEnabled();
    let projectionRevision: number | null = null;
    let scheduleFees: CustodianFee[] = [];
    if (projectionEnabled && custodian) {
      try {
        const row = await prisma.custodian.findUnique({
          where: { id: custodian.id },
          select: { projectionRevision: true, fees: true },
        });
        projectionRevision = row?.projectionRevision ?? null;
        scheduleFees = row?.fees ?? [];
      } catch (feeErr) {
        logger.warn(
          { err: feeErr },
          "confirmed fee fill failed; letting create proceed"
        );
      }
    }
    const createFeeDecision = confirmedFeeDecision({
      projectionEnabled,
      projectionRevision,
      feeAmountAlreadySet: Boolean(d.feeAmount),
      feeChargedIsNo: d.feeCharged?.trim() === "No",
    });
    if (createFeeDecision === "fill") {
      const filled = assignScheduleFees(scheduleFees, d.accountType, d.type, d.direction);
      if (filled) {
        if (filled.feeAmount) data.feeAmount = filled.feeAmount;
        data.feeMemo = filled.feeMemo;
        data.feeCharged = filled.feeCharged;
      }
    }
    const record = selectedIds.length
      ? await prisma.$transaction(async (tx) => {
          await lockDirectory(tx);
          await holdDemoQuota(tx, { transfers: 1 });
          const identity = await resolveClientIdentities(tx, {
            cedarRidgeUserIds: selectedIds, apexAccountId: d.apexAccountId.trim(),
            allowPendingAccount: allowsPendingAccount(data.status),
          });
          const created = await tx.acatRecord.create({ data: { ...data,
            clientName: identity.canonicalName,
          }, include: { assets: true } });
          const linked = await replaceAcatRecordClients(tx, { recordId: created.id,
            cedarRidgeUserIds: identity.cedarRidgeUserIds, expectedIdentityVersion: created.identityVersion });
          await tx.auditLog.create({ data: { acatRecordId: created.id, action: "identity-create",
            field: "cedarRidgeUserIds", newValue: JSON.stringify(identity.cedarRidgeUserIds), performedBy: performedBy ?? operator?.email,
          } });
          await tx.auditLog.create({ data: { acatRecordId: created.id, action: "identity-create-provenance",
            field: "cedarRidgeUserIds", performedBy: performedBy ?? operator?.email,
            newValue: JSON.stringify({ snapshotId: identity.snapshotId, freshnessBasis: identity.freshnessBasis, evidenceDigest: identity.evidenceDigest,
              cedarRidgeUserIds: identity.cedarRidgeUserIds, beforeVersion: created.identityVersion, afterVersion: linked.identityVersion }),
          } });
          return tx.acatRecord.findUniqueOrThrow({ where: { id: created.id },
            include: { assets: true, clientLinks: acatClientLinksSelection } });
        })
      : await prisma.acatRecord.create({ data, include: { assets: true, clientLinks: acatClientLinksSelection } });

    return { kind: "record", record: record as unknown as PersistedAcat };
}

export async function applyAcatPatch({
  id,
  body,
  performedBy,
}: {
  id: string;
  body: {
    assets?: unknown;
    newAssets?: unknown;
    [key: string]: unknown;
  };
  performedBy: string | null;
}): Promise<AcatWriteResult> {
    const {
      assets: rawAssets,
      newAssets: rawNewAssets,
      ...fields
    } = body;

    const parsed = updateAcatSchema.safeParse(fields);
    if (!parsed.success) {
      return {
        kind: "response",
        response: NextResponse.json(
          { error: formatZodError(parsed.error) },
          { status: 400 }
        ),
      };
    }

    const txResult = await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await tx.$queryRaw`SELECT id FROM "AcatRecord" WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.acatRecord.findUnique({
        where: { id, deletedAt: null },
        include: { assets: true, clientLinks: acatClientLinksSelection },
      });
      if (!existing) {
        return NextResponse.json(
          { error: "ACAT record not found" },
          { status: 404 }
        );
      }

      const identityChanged = ["clientName", "apexAccountId", "acatTransferId"].some((field) => {
        const next = parsed.data[field as "clientName" | "apexAccountId" | "acatTransferId"];
        return next !== undefined && next !== existing[field as "clientName" | "apexAccountId" | "acatTransferId"];
      });
      if (identityChanged && parsed.data.expectedIdentityVersion !== undefined &&
          parsed.data.expectedIdentityVersion !== existing.identityVersion) {
        return identityError("IDENTITY_CONFLICT", "This record changed. Reload it before editing its identity.", 409);
      }
      const linkedIds = existing.clientLinks.map((link) => link.cedarRidgeUserId);
      let identityValidation: Awaited<ReturnType<typeof resolveClientIdentities>> | null = null;
      if (linkedIds.length) {
        if (parsed.data.clientName !== undefined && parsed.data.clientName !== existing.clientName) {
          return identityError("IDENTITY_RELINK_REQUIRED", "Use Change client to update a linked client's saved name", 400);
        }
        if (identityChanged && parsed.data.expectedIdentityVersion === undefined) {
          return identityError("IDENTITY_CONFLICT", "Reload this record before editing its identity", 409);
        }
        const account = parsed.data.apexAccountId !== undefined ? parsed.data.apexAccountId.trim() : existing.apexAccountId;
        const effectiveStatus = parsed.data.status ?? existing.status;
        if (identityChanged || (parsed.data.status !== undefined && !account.trim() && !allowsPendingAccount(effectiveStatus))) {
          identityValidation = await resolveClientIdentities(tx, { cedarRidgeUserIds: linkedIds, apexAccountId: account,
            allowPendingAccount: allowsPendingAccount(effectiveStatus) });
        }
      } else if (parsed.data.apexAccountId !== undefined && !parsed.data.apexAccountId.trim()) {
        return identityError("INVALID_REQUEST", "Apex account number is required for an unlinked record", 400);
      }
      if (parsed.data.apexAccountId !== undefined) parsed.data.apexAccountId = parsed.data.apexAccountId.trim();

      // Save the coupled type in the same transaction and audit trail as the
      // workflow change, before any fee or monitoring defaults are evaluated.
      if (parsed.data.transferWorkflow === "RESIDUAL") {
        parsed.data.type = "Residual Credit";
      }

      // Validate the asset payloads up front so an attacker can't smuggle
      // arbitrary fields (e.g. `expectedQty: 0`, `acatRecordId: "OTHER"`)
      // through the loose destructure below. `.strict()` on each schema
      // rejects unknown keys.
      const assetUpdatesParsed = boundedArray(updateAssetSchema, MAX_ASSET_UPDATES)
        .safeParse(Array.isArray(rawAssets) ? rawAssets : []);
      if (!assetUpdatesParsed.success) {
        return NextResponse.json(
          { error: formatZodError(assetUpdatesParsed.error) },
          { status: 400 }
        );
      }
      const newAssetsParsed = boundedArray(createAssetSchema, MAX_NEW_ASSETS)
        .safeParse(Array.isArray(rawNewAssets) ? rawNewAssets : []);
      if (!newAssetsParsed.success) {
        return NextResponse.json(
          { error: formatZodError(newAssetsParsed.error) },
          { status: 400 }
        );
      }

      const data: Record<string, unknown> = {
        lastUpdated: new Date().toISOString(),
      };
      const auditEntries: {
        acatRecordId: string;
        action: string;
        field: string;
        oldValue: string | null;
        newValue: string | null;
        performedBy: string | null;
      }[] = [];

      for (const field of UPDATE_ACAT_ALLOWED_FIELDS) {
        let newVal = (parsed.data as Record<string, unknown>)[field];
        if (newVal === undefined) continue;
        // crmDealId is `String @default("")` (NOT NULL) in Prisma — coerce
        // an explicit `null` (user cleared the field) back to "" so the write
        // succeeds against the existing column.
        if (field === "crmDealId" && newVal === null) newVal = "";
        if (field === "statementAmount" && typeof newVal === "number") {
          newVal = normalizeStatementAmountSign(
            newVal,
            parsed.data.direction !== undefined ? parsed.data.direction : existing.direction
          );
        }
        const oldVal = existing[field as keyof typeof existing];
        if (String(oldVal ?? "") !== String(newVal ?? "")) {
          data[field] = newVal;
          auditEntries.push({
            acatRecordId: id,
            action: "update",
            field,
            oldValue: oldVal != null ? String(oldVal) : null,
            newValue: newVal != null ? String(newVal) : null,
            performedBy,
          });
        }
      }

      if (existing.mappingAccountId && ["statementAccountNumber", "clientName", "accountType", "custodianName"].some((field) => field in data)) {
        data.mappingAccountId = null;
        data.mappingAccountSummary = Prisma.DbNull;
        auditEntries.push({ acatRecordId: id, action: "update", field: "mappingAccountId", oldValue: existing.mappingAccountId, newValue: null, performedBy });
      }

      const effectiveShape = {
        direction: parsed.data.direction !== undefined ? parsed.data.direction : existing.direction,
        type: parsed.data.type !== undefined ? parsed.data.type : existing.type,
        transferWorkflow: parsed.data.transferWorkflow !== undefined
          ? parsed.data.transferWorkflow
          : existing.transferWorkflow,
      };
      const becomingOutgoingTransfer =
        (parsed.data.direction !== undefined || parsed.data.type !== undefined) &&
        isOutgoingTransfer(effectiveShape);
      const feeDefault = defaultFeeCharged(effectiveShape);
      const feeAmountAfter = parsed.data.feeAmount !== undefined
        ? parsed.data.feeAmount
        : existing.feeAmount;
      const applyFeeDefault =
        isDrsTransfer(effectiveShape)
          ? !feeAmountAfter?.trim()
          : parsed.data.direction !== undefined || parsed.data.type !== undefined;

      // DRS defaults to no fee, including previously unanswered records.
      // Otherwise preserve the existing full-outgoing fee default on reclassification.
      // Never overwrite a saved answer or an explicit answer in this PATCH.
      if (
        applyFeeDefault &&
        feeDefault !== undefined &&
        parsed.data.feeCharged === undefined &&
        !existing.feeCharged?.trim()
      ) {
        data.feeCharged = feeDefault;
        auditEntries.push({
          acatRecordId: id,
          action: "update",
          field: "feeCharged",
          oldValue: existing.feeCharged ?? null,
          newValue: feeDefault,
          performedBy,
        });
      }

      // Direction or type changes that create a non-residual ACAT Out opt the
      // record into monitoring and seed a one-week review date unless the user
      // supplied different values.
      if (becomingOutgoingTransfer && !isResidualTransfer(effectiveShape)) {
        if (
          parsed.data.residualMonitoringRequired === undefined &&
          !existing.residualMonitoringRequired
        ) {
          data.residualMonitoringRequired = true;
          auditEntries.push({
            acatRecordId: id,
            action: "update",
            field: "residualMonitoringRequired",
            oldValue: String(existing.residualMonitoringRequired),
            newValue: "true",
            performedBy,
          });
        }
        if (
          parsed.data.residualFollowUpDate === undefined &&
          !existing.residualFollowUpDate?.trim()
        ) {
          const followUpDate = defaultResidualFollowUpDate();
          data.residualFollowUpDate = followUpDate;
          auditEntries.push({
            acatRecordId: id,
            action: "update",
            field: "residualFollowUpDate",
            oldValue: existing.residualFollowUpDate ?? null,
            newValue: followUpDate,
            performedBy,
          });
        }
      }

      // Changing an existing positive transfer to Out also normalizes its saved
      // amount even when statementAmount was not part of this PATCH.
      if (
        parsed.data.direction?.trim().toLowerCase() === "out" &&
        parsed.data.statementAmount === undefined &&
        typeof existing.statementAmount === "number" &&
        existing.statementAmount > 0
      ) {
        const normalized = -Math.abs(existing.statementAmount);
        data.statementAmount = normalized;
        auditEntries.push({
          acatRecordId: id,
          action: "update",
          field: "statementAmount",
          oldValue: String(existing.statementAmount),
          newValue: String(normalized),
          performedBy,
        });
      }

      // When the contra text itself is edited, re-resolve the linked custodian
      // so the FK (`custodianId`) and denormalized `custodianName` follow the
      // new contra instead of drifting. Uses the same shared resolver as
      // POST /api/acats. A cleared contra (empty/null) resolves to no custodian.
      if (parsed.data.transferringContra !== undefined) {
        const c = await resolveCustodianForContra(parsed.data.transferringContra, tx);
        data.custodianId = c?.id ?? null;
        data.custodianName = c?.name ?? "";
      }

      // Auto-apply custodian fee schedule whenever the record is (or is
      // becoming) Completed with no fee already recorded. Runs server-side so
      // the fill happens regardless of how the status or feeCharged value was
      // changed (drawer edit, table inline, future bulk action). Skips when
      // the user explicitly set feeCharged=No, when a feeAmount is already
      // present, for DRS (the ACAT schedule does not apply by default), or when
      // no custodian/matching schedule can be found.
      //
      // The whole block is best-effort — any lookup failure is logged but must
      // not break the primary record update. We lost the PATCH entirely in one
      // incident when the CustodianFee table was missing; never again.
      try {
        const newStatus = (parsed.data as { status?: string }).status;
        const incomingFeeAmount = (parsed.data as { feeAmount?: string | null }).feeAmount;
        const incomingFeeCharged = (parsed.data as { feeCharged?: string | null }).feeCharged;
        const effectiveStatus = newStatus !== undefined ? newStatus : existing.status;
        const feeAmountAfter = incomingFeeAmount !== undefined ? incomingFeeAmount : existing.feeAmount;
        const feeChargedAfter = incomingFeeCharged !== undefined ? incomingFeeCharged : existing.feeCharged;
        const effectiveTransferType =
          (parsed.data as { type?: string | null }).type !== undefined
            ? (parsed.data as { type?: string | null }).type
            : existing.type;
        const shouldAutoApply =
          effectiveStatus === "Completed" &&
          !isDrsTransfer(effectiveShape) &&
          !isResidualCreditTransfer(effectiveTransferType) &&
          !feeAmountAfter &&
          feeChargedAfter !== "No";

        // When this PATCH also re-resolves the contra, the fresh custodianId is
        // in `data` — use it so fees follow the NEW custodian, not the stale one.
        const effectiveCustodianId =
          parsed.data.transferringContra !== undefined
            ? (data.custodianId as string | null)
            : existing.custodianId;

        const projectionEnabled = custodianProjectionEnabled();
        let projectionCustodian: { projectionRevision: number | null; fees: CustodianFee[] } | null = null;
        if (projectionEnabled && effectiveCustodianId) {
          await tx.$executeRaw`SAVEPOINT acat_fee_lookup`;
          try {
            const result = await tx.custodian.findUnique({
              where: { id: effectiveCustodianId }, include: { fees: true },
            });
            await tx.$executeRaw`RELEASE SAVEPOINT acat_fee_lookup`;
            projectionCustodian = result;
          } catch (error) {
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT acat_fee_lookup`;
            await tx.$executeRaw`RELEASE SAVEPOINT acat_fee_lookup`;
            throw error;
          }
        }
        const patchFeeDecision = confirmedFeeDecision({
          projectionEnabled,
          projectionRevision: projectionCustodian?.projectionRevision ?? null,
          feeAmountAlreadySet: Boolean(feeAmountAfter),
          feeChargedIsNo: feeChargedAfter === "No",
        });
        const accountType = (data.accountType as string | undefined) ?? existing.accountType;
        const transferType = (data.type as string | undefined) ?? existing.type;
        const direction = (data.direction as string | undefined) ?? existing.direction;
        if (
          patchFeeDecision === "fill" &&
          projectionCustodian &&
          !isDrsTransfer(effectiveShape) &&
          !isResidualCreditTransfer(effectiveTransferType)
        ) {
          const filled = assignScheduleFees(projectionCustodian.fees, accountType, transferType, direction);
          if (filled) {
            if (filled.feeAmount) data.feeAmount = filled.feeAmount;
            data.feeMemo = filled.feeMemo;
            data.feeCharged = filled.feeCharged;
            auditEntries.push({
              acatRecordId: id,
              action: "fee-auto-apply",
              field: "feeAmount",
              oldValue: existing.feeAmount != null ? String(existing.feeAmount) : null,
              newValue: filled.feeAmount,
              performedBy,
            });
          }
        } else if (patchFeeDecision === "legacy" && shouldAutoApply && effectiveCustodianId) {
          // A failed SQL lookup aborts a PostgreSQL transaction even when JS
          // catches it. Preserve this existing best-effort feature with a
          // savepoint while keeping identity validation and writes atomic.
          await tx.$executeRaw`SAVEPOINT acat_fee_lookup`;
          const custodian = await (async () => {
            try {
              const result = await tx.custodian.findUnique({
                where: { id: effectiveCustodianId }, include: { fees: true },
              });
              await tx.$executeRaw`RELEASE SAVEPOINT acat_fee_lookup`;
              return result;
            } catch (error) {
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT acat_fee_lookup`;
              await tx.$executeRaw`RELEASE SAVEPOINT acat_fee_lookup`;
              throw error;
            }
          })();
          if (custodian && custodian.fees.length > 0) {
            const summary = selectApplicableFees(
              custodian.fees,
              accountType,
              transferType,
              direction
            );
            if (summary.fees.length > 0) {
              const memo = summary.fees
                .map((f) => {
                  const value = f.amount != null ? `$${f.amount.toFixed(2)}` : (f.amountText ?? "?");
                  return `${f.feeType}: ${value}`;
                })
                .join(" + ");
              const amountStr = summary.total > 0 ? `$${summary.total.toFixed(2)}` : null;
              const chargedStr = summary.total > 0 || summary.hasUnknownAmount ? "Yes" : "No";

              if (amountStr) data.feeAmount = amountStr;
              data.feeMemo = memo;
              data.feeCharged = chargedStr;

              auditEntries.push({
                acatRecordId: id,
                action: "fee-auto-apply",
                field: "feeAmount",
                oldValue: existing.feeAmount != null ? String(existing.feeAmount) : null,
                newValue: amountStr,
                performedBy,
              });
            }
          }
        }
      } catch (feeErr) {
        logger.warn(
          { err: feeErr, acatId: id },
          "fee auto-apply failed; letting main update proceed"
        );
      }

      const assetUpdates = assetUpdatesParsed.data;
      const newAssets = newAssetsParsed.data;

      // ticket: After we've computed the asset writes, decide whether the
      // recon has crossed the auto-complete threshold (>= 90% matched with
      // both GCP positions and a Apex CSV present). We simulate the
      // post-write asset state in memory so the stamp reflects what the
      // DB will look like AFTER the transaction commits — not the stale
      // pre-write snapshot.
      //
      // The client (SecurityReconTab) can also send `reconCompletedAt`
      // directly, e.g. to clear it when ops manually backs out an override.
      // A client-provided value (already filtered into `data` by the
      // allow-list loop above) always wins over the heuristic.
      const reconStampExplicit = "reconCompletedAt" in data;
      if (!reconStampExplicit && (assetUpdates.length > 0 || newAssets.length > 0 || data.apexSource !== undefined)) {
        const simulated = simulatePostPatchRecord(existing, data, assetUpdates, newAssets);
        const wasComplete = !!existing.reconCompletedAt;
        const shouldComplete =
          hasGcpPositions(simulated) &&
          hasApexUpload(simulated) &&
          getReconRate(simulated) >= RECON_AUTO_COMPLETE_THRESHOLD;
        if (shouldComplete && !wasComplete) {
          const stamp = new Date().toISOString();
          data.reconCompletedAt = stamp;
          auditEntries.push({
            acatRecordId: id,
            action: "recon-auto-complete",
            field: "reconCompletedAt",
            oldValue: null,
            newValue: stamp,
            performedBy,
          });
        } else if (!shouldComplete && wasComplete) {
          // A row override or backed-out upload dragged the rate below the
          // threshold — un-stamp so the records page surfaces the
          // needs-review flag again.
          data.reconCompletedAt = null;
          auditEntries.push({
            acatRecordId: id,
            action: "recon-auto-uncomplete",
            field: "reconCompletedAt",
            oldValue: existing.reconCompletedAt ?? null,
            newValue: null,
            performedBy,
          });
        }
      }

      const ownedAssetIds = new Set(existing.assets.map((a) => a.id));
      const unauthorized = assetUpdates.filter((au) => !ownedAssetIds.has(au.id));
      if (unauthorized.length > 0) {
        return NextResponse.json(
          { error: `Assets do not belong to this ACAT record: ${unauthorized.map((a) => a.id).join(", ")}` },
          { status: 403 }
        );
      }

      // Drop the non-unique `acatRecordId` filter from the update's where clause.
      // Prisma's `update` accepts only a unique-where, and some driver/client
      // combos treat an extra non-unique filter as a silent no-op instead of a
      // validation error. Since we already enforced ownership via
      // `unauthorized` above, matching by `id` alone is safe.
      const assetOps = assetUpdates.map((au) =>
        tx.asset.update({
          where: { id: au.id },
          data: {
            ...(au.actualQty !== undefined ? { actualQty: au.actualQty } : {}),
            ...(au.mapStatus !== undefined ? { mapStatus: au.mapStatus } : {}),
            ...(au.issue !== undefined ? { issue: au.issue } : {}),
            ...(au.notes !== undefined ? { notes: au.notes } : {}),
          },
        })
      );

      // Materialize new positions the user opted to keep from the recon
      // screen — typically Apex-only "Unexpected" rows the GCP sync didn't
      // know about. The route, not the client, is the source of the
      // acatRecordId binding so a client can't graft assets onto someone
      // else's ACAT.
      await holdTransferPositions(tx, id, newAssets.length);
      await holdDemoQuota(tx, { positions: newAssets.length });
      const assetCreateOps = newAssets.map((na) =>
        tx.asset.create({
          data: {
            acatRecordId: id,
            symbol: na.symbol,
            description: na.description ?? "",
            cusip: na.cusip ?? null,
            expectedQty: na.expectedQty ?? 0,
            actualQty: na.actualQty ?? 0,
            mapStatus: na.mapStatus ?? "Unmapped",
            issue: na.issue ?? null,
            notes: na.notes ?? null,
            amount: na.amount ?? null,
            assetClass: na.assetClass ?? null,
          },
        })
      );

      // Order the transaction so asset writes commit BEFORE the final read, and
      // the returned `updated` record includes the freshly-written `actualQty`
      // / `mapStatus` / `issue` values. Previously the `acatRecord.update` with
      // `include: { assets: true }` ran first, returning the pre-write asset
      // rows — the response body misled clients (including our SWR cache) into
      // thinking nothing had changed.
      await Promise.all([...assetOps, ...assetCreateOps]);
      if (auditEntries.length > 0) await tx.auditLog.createMany({ data: auditEntries });
      const updated = await tx.acatRecord.update({
        where: { id }, data,
        include: { assets: true, clientLinks: acatClientLinksSelection, custodian: { omit: { requiresManualReview: true } } },
      });
      if (identityValidation && updated.identityVersion !== existing.identityVersion) {
        await tx.auditLog.create({ data: {
          acatRecordId: id, action: "identity-update-provenance", field: "cedarRidgeUserIds", performedBy,
          newValue: JSON.stringify({ snapshotId: identityValidation.snapshotId,
            freshnessBasis: identityValidation.freshnessBasis, evidenceDigest: identityValidation.evidenceDigest,
            cedarRidgeUserIds: identityValidation.cedarRidgeUserIds,
            beforeVersion: existing.identityVersion, afterVersion: updated.identityVersion }),
        } });
      }

      logger.info(
        {
          acatId: id,
          assetUpdateCount: assetUpdates.length,
          assetCreateCount: newAssets.length,
          fieldUpdateCount: Object.keys(data).length - 1, // minus lastUpdated
          performedBy,
        },
        "PATCH /api/acats/[id] applied"
      );

      return updated;
    });
    if (txResult instanceof NextResponse) {
      return { kind: "response", response: txResult };
    }
    return { kind: "record", record: txResult as unknown as PersistedAcat };
}

export async function applyAcatRestore({
  id,
  reason,
  performedBy,
}: {
  id: string;
  reason: string | null;
  performedBy: string | null;
}): Promise<NextResponse> {
  const existing = await prisma.acatRecord.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json(
      { error: "ACAT record not found" },
      { status: 404 }
    );
  }
  if (existing.deletedAt === null) {
    return NextResponse.json(
      { error: "ACAT record is not deleted" },
      { status: 409 }
    );
  }

  await prisma.$transaction([
    prisma.acatRecord.update({
      where: { id },
      data: { deletedAt: null },
    }),
    prisma.auditLog.create({
      data: {
        acatRecordId: id,
        action: "RESTORE",
        newValue: reason,
        performedBy,
      },
    }),
  ]);

  logger.info(
    { acatId: id, restoredBy: performedBy, reason },
    "ACAT restored"
  );

  return NextResponse.json({ success: true });
}

export type AcatDeleteResult =
  | { kind: "not_found" }
  | { kind: "record"; record: PersistedAcat };

/**
 * ticket: soft-delete one live transfer for a trusted machine caller. One
 * transaction locks and reads the live row, stamps `deletedAt`, writes the
 * existing `DELETE` audit entry with the caller's service-account email and
 * the validated reason, and returns the stored removed row. A missing or
 * already-removed transfer writes nothing.
 */
export async function applyAcatDelete({
  id,
  reason,
  performedBy,
}: {
  id: string;
  reason: string;
  performedBy: string;
}): Promise<AcatDeleteResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AcatRecord" WHERE id = ${id} FOR UPDATE`;
    const existing = await tx.acatRecord.findUnique({
      where: { id, deletedAt: null },
      include: { assets: true },
    });
    if (!existing) return null;
    await tx.acatRecord.update({ where: { id }, data: { deletedAt: new Date() } });
    await tx.auditLog.create({
      data: { acatRecordId: id, action: "DELETE", newValue: reason, performedBy },
    });
    return tx.acatRecord.findUniqueOrThrow({ where: { id }, include: { assets: true } });
  });
  if (!result) return { kind: "not_found" };
  logger.info({ acatId: id, deletedBy: performedBy }, "ACAT soft-deleted by trusted machine caller");
  return { kind: "record", record: result as unknown as PersistedAcat };
}

export type TransferFeeRead = TransferFee & { clientName: string; apexAccountId: string };

export async function readTransferFee(id: string): Promise<TransferFeeRead | null> {
  const row = await prisma.acatRecord.findUnique({ where: { id, deletedAt: null } });
  if (!row) return null;
  const source = row as unknown as Partial<TransferFee> & { clientName?: string | null; apexAccountId?: string | null };
  return {
    ...toHttpFee(source),
    clientName: source.clientName ?? "",
    apexAccountId: source.apexAccountId ?? "",
  };
}

export async function saveTransferFeeFields(
  id: string,
  fields: Partial<TransferFee>,
  performedBy: string | null,
): Promise<
  | { ok: true; fee: TransferFee }
  | { ok: false; reason: "not_found"; fee: null }
  | { ok: false; reason: "refused"; fee: TransferFee; status: number }
> {
  const before = await readTransferFee(id);
  if (!before) return { ok: false, reason: "not_found", fee: null };
  const fee = toHttpFee(before);
  const result = await applyAcatPatch({ id, body: fields, performedBy });
  if (result.kind === "response") {
    return { ok: false, reason: "refused", fee, status: result.response.status };
  }
  return { ok: true, fee: toHttpFee(result.record as unknown as Partial<TransferFee>) };
}

export async function applySelectedFeeRules(
  id: string,
  feeRuleIds: string[],
  performedBy: string | null,
) {
  const row = await prisma.acatRecord.findUnique({
    where: { id, deletedAt: null },
    include: { custodian: { include: { fees: true } } },
  });
  if (!row) return { ok: false as const, reason: "not_found" as const, fee: null };
  const fee = toHttpFee(row as unknown as Partial<TransferFee>);
  const rules = row.custodian?.fees ?? [];
  if (!row.custodian || rules.length === 0) return { ok: false as const, reason: "no_rules" as const, fee };
  const kept = rules.filter((rule) => feeRuleIds.includes(rule.id));
  if (kept.length !== new Set(feeRuleIds).size) return { ok: false as const, reason: "refused" as const, fee };
  return saveTransferFeeFields(id, selectedRuleFee(kept), performedBy);
}
