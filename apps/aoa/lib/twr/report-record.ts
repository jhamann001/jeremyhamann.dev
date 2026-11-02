import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import warehouseManifest from "@/warehouse/cards.manifest.json";
import {
  PERFORMANCE_REPORT_CALCULATED_ACCOUNT,
  PERFORMANCE_REPORT_CALCULATED_HOUSEHOLD,
  writeAudit,
} from "@/lib/audit";
import { withUserScope, type Identity } from "@/lib/rls";
import type { TwrResult } from "@/lib/twr/engine";
import { isRouterPrefetch } from "@/lib/twr/report-audit";
import type { RiskFreeWindow } from "@/lib/twr/risk-free-rate";

export const PERFORMANCE_REPORT_SNAPSHOT_VERSION = 1;
export const PERFORMANCE_METHODOLOGY_VERSION = "1.9";

type HouseholdMemberSnapshot = {
  accountLast4: string | null;
  endingValue: number;
  weightPct: number;
  sinceInceptionTwr: number | null;
  costBasisExcluded?: boolean;
};

export type PerformanceReportCalculationInput = {
  reportId: string;
  scope: "account" | "household";
  entityId: string;
  reportDate: string;
  result: TwrResult;
  rf: RiskFreeWindow | null;
  account?: {
    accountLast4: string | null;
    accountType: string | null;
  };
  householdMembers?: HouseholdMemberSnapshot[];
};

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite report snapshot value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  throw new Error("unsupported report snapshot value");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function reportSnapshotSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sourceCommitSha(): string {
  const sha = process.env.AOA_SOURCE_COMMIT_SHA ?? "unknown";
  if (process.env.NODE_ENV === "production" && !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("AOA_SOURCE_COMMIT_SHA is missing or invalid");
  }
  return sha;
}

export function buildPerformanceReportSnapshot(
  input: PerformanceReportCalculationInput,
): Record<string, unknown> {
  const commit = sourceCommitSha();
  return {
    snapshotVersion: PERFORMANCE_REPORT_SNAPSHOT_VERSION,
    methodologyVersion: PERFORMANCE_METHODOLOGY_VERSION,
    sourceCommitSha: commit,
    report: {
      reportId: input.reportId,
      scope: input.scope,
      reportDate: input.reportDate,
      asOf: input.result.asOf,
    },
    provenance: {
      warehouse: {
        manifestCapturedAt: warehouseManifest.capturedAt,
        databaseId: warehouseManifest.databaseId,
        collectionId: warehouseManifest.collection.id,
        cards: warehouseManifest.cards.map((card) => ({
          id: card.id,
          name: card.name,
          sqlSha256: card.sqlSha256,
        })),
      },
      riskFreeRate: input.rf,
    },
    subject:
      input.scope === "account"
        ? { account: input.account ?? null }
        : { members: input.householdMembers ?? [] },
    calculation: input.result,
  };
}

/**
 * Store an immutable successful-CALCULATION snapshot and its searchable event.
 * The write is fail-closed: if persistence fails, the report is not returned.
 * Both rows share one transaction, so an event can never point at a missing
 * snapshot and a snapshot can never be orphaned from the event trail.
 */
export async function recordPerformanceReportCalculation(
  identity: Identity,
  input: PerformanceReportCalculationInput,
): Promise<{ payloadSha256: string } | null> {
  // Match the authorized-attempt prefetch posture: no phantom evidence row for
  // a router-prefetched response. Current report entry points do not prefetch.
  if (await isRouterPrefetch()) return null;

  const payload = buildPerformanceReportSnapshot(input);
  const payloadSha256 = reportSnapshotSha256(payload);
  const action =
    input.scope === "account"
      ? PERFORMANCE_REPORT_CALCULATED_ACCOUNT
      : PERFORMANCE_REPORT_CALCULATED_HOUSEHOLD;

  await withUserScope(identity, async (tx) => {
    await tx.performanceReportRecord.create({
      data: {
        reportId: input.reportId,
        actorEmail: identity.email ?? null,
        actorRole: identity.role ?? null,
        scope: input.scope,
        entityId: input.entityId,
        reportDate: input.reportDate,
        asOf: input.result.asOf,
        snapshotVersion: PERFORMANCE_REPORT_SNAPSHOT_VERSION,
        methodologyVersion: PERFORMANCE_METHODOLOGY_VERSION,
        sourceCommitSha: sourceCommitSha(),
        payloadSha256,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    await writeAudit(tx, identity, {
      action,
      entityType: "performance_report",
      entityId: input.entityId,
      detail: {
        reportId: input.reportId,
        phase: "calculation_complete",
        snapshotVersion: PERFORMANCE_REPORT_SNAPSHOT_VERSION,
        methodologyVersion: PERFORMANCE_METHODOLOGY_VERSION,
        sourceCommitSha: sourceCommitSha(),
        reportDate: input.reportDate,
        asOf: input.result.asOf,
        payloadSha256,
      },
    });
  });

  return { payloadSha256 };
}
