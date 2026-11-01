import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getAuthenticatedClient } from "@/lib/gcp-auth";
import { z } from "zod";
import { buildTransferDocument } from "@/lib/transfer-documents";
import { DemoLimitError, documentHolds, holdDemoQuota, holdTransferPositions } from "@/lib/demo/limits";
import {
  isCusipFormat,
  normalizePipelineAccountNumber,
} from "@/lib/asset-mapping";
import { accountNumbersMatch } from "@/lib/parse-asset-mapping-csv";
import type { AssetMappingContext } from "@/lib/types";
import { mappingAccountSummary, type MappingAccount } from "@/lib/mapping-account";

interface PipelinePosition {
  cusip: string;
  symbol: string;
  description: string;
  qty: number;
  assetClass?: string;
  amount?: number;
  includeInTransfer?: boolean | null;
  mapping?: AssetMappingContext;
}

interface PipelineResponse {
  account_number: string;
  custodian?: string;
  account_type?: string;
  client_name?: string;
  positions: PipelinePosition[];
}

interface RawPipelinePosition {
  symbol: string | null;
  description: string | null;
  quantity: number | string | null;
  market_value?: number | string | null;
  asset_type?: string | null;
  transfer_eligible?: string | null;
  transfer_notes?: string | null;
  effective_status?: string | null;
  effective_notes?: string | null;
  transferring?: string | null;
  classification_source?: string;
  notion_check?: string;
}

interface RawPipelineResponse extends Record<string, unknown> {
  account_number: string;
  custodian?: string;
  account_type?: string;
  client_name?: string;
  statement_date?: string | null;
  statement_age_days?: number | string | null;
  is_stale?: boolean | null;
  positions: RawPipelinePosition[];
}

const spreadsheetImportSchema = z
  .object({
    acatId: z.string().trim().min(1).max(100),
    source: z.literal("spreadsheet"),
    sourceAccountNumber: z.string().trim().min(4).max(100),
    filename: z.string().trim().min(1).max(255).optional(),
    positions: z
      .array(
        z
          .object({
            symbol: z.string().trim().max(100),
            description: z.string().trim().max(500),
            cusip: z.string().trim().max(20).default(""),
            qty: z.number().finite(),
            amount: z.number().finite().optional(),
            assetClass: z.string().trim().max(100).optional(),
            includeInTransfer: z.boolean().nullable(),
          })
          .strict()
          .refine(
            (position) =>
              position.symbol || position.cusip || position.description,
            {
              message: "A symbol, CUSIP, or description is required",
            }
          )
      )
      .min(1)
      .max(500),
  })
  .strict();

async function persistPositions(
  acatId: string,
  existingAssets: Array<{
    id: string;
    symbol: string;
    cusip: string | null;
    assetClass: string | null;
    amount: number | null;
  }>,
  positions: PipelinePosition[],
  mappingSource: string,
  mappingSyncedAt?: string,
  sourceAccount?: MappingAccount,
  savedDocument?: ReturnType<typeof buildTransferDocument>
) {
  const updateOps: Array<(db: Prisma.TransactionClient) => Promise<unknown>> = [];
  const createData: Prisma.AssetCreateManyInput[] = [];
  const matchedIds = new Set<string>();

  for (const pos of positions) {
    const existingAsset = existingAssets.find(
      (asset) =>
        (pos.cusip && asset.cusip === pos.cusip) ||
        asset.symbol.toUpperCase() === pos.symbol.toUpperCase() ||
        (pos.cusip && asset.symbol.toUpperCase() === pos.cusip)
    );

    if (existingAsset) {
      matchedIds.add(existingAsset.id);
      updateOps.push((db) =>
        db.asset.update({
          where: { id: existingAsset.id },
          data: {
            expectedQty: pos.qty,
            description: pos.description,
            cusip: pos.cusip || existingAsset.cusip,
            assetClass: pos.assetClass ?? existingAsset.assetClass,
            amount: pos.amount ?? existingAsset.amount,
            ...pos.mapping,
            ...(pos.includeInTransfer !== undefined
              ? { includeInTransfer: pos.includeInTransfer }
              : {}),
          },
        })
      );
      continue;
    }

    createData.push({
      acatRecordId: acatId,
      symbol: pos.symbol,
      description: pos.description,
      cusip: pos.cusip,
      expectedQty: pos.qty,
      actualQty: 0,
      mapStatus: "Pending" as const,
      assetClass: pos.assetClass,
      amount: pos.amount,
      includeInTransfer: pos.includeInTransfer ?? null,
      ...pos.mapping,
    });
  }

  if (mappingSyncedAt !== undefined) {
    // A successful GCP response is the complete expected account. Retain
    // received quantities/notes, but retire expectations absent from the source.
    for (const asset of existingAssets) {
      if (!matchedIds.has(asset.id)) {
        updateOps.push((db) => db.asset.update({
          where: { id: asset.id },
          data: {
            expectedQty: 0, amount: 0,
            mappingTransferStatus: null, mappingTransferNotes: null,
            mappingTransferring: null, mappingStatementDate: null,
            mappingStatementAgeDays: null, mappingStatementIsStale: null,
            mappingSyncedAt,
          },
        }));
      }
    }
  }

  // The transfer's row lock comes first, as in the record PATCH, so the two never wait on each other's
  // locks. Sequential statements on Neon can pass Prisma's 5 s default for a large account.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AcatRecord" WHERE id = ${acatId} FOR UPDATE`;
    await holdTransferPositions(tx, acatId, createData.length);
    await holdDemoQuota(tx, { positions: createData.length, ...(savedDocument ? documentHolds(savedDocument) : {}) });
    for (const update of updateOps) await update(tx);
    if (createData.length > 0) await tx.asset.createMany({ data: createData });
    await tx.acatRecord.update({
      where: { id: acatId },
      data: {
        mappingSource,
        ...(mappingSyncedAt !== undefined ? { mappingSyncedAt } : {}),
        ...(sourceAccount?.id ? { mappingAccountId: sourceAccount.id, mappingAccountSummary: { ...sourceAccount } } : {}),
        ...(mappingSyncedAt !== undefined ? { reconCompletedAt: null } : {}),
        lastUpdated: new Date().toISOString(),
        ...(savedDocument ? { documents: { create: savedDocument } } : {}),
      },
    });
  }, { maxWait: 10_000, timeout: 30_000 });
}

function upstreamErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("response" in error)) return;
  const response = error.response;
  if (!response || typeof response !== "object" || !("status" in response)) return;
  return typeof response.status === "number" ? response.status : undefined;
}

function mapPipelineResponse(raw: RawPipelineResponse, syncedAt: string): PipelineResponse {
  const reportedAge = raw.statement_age_days;
  const age = reportedAge == null || String(reportedAge).trim() === ""
    ? null
    : Number(reportedAge);
  const statement = {
    mappingStatementDate: raw.statement_date?.trim() || null,
    mappingStatementAgeDays: age !== null && Number.isInteger(age) && Math.abs(age) <= 2147483647 ? age : null,
    mappingStatementIsStale: typeof raw.is_stale === "boolean" ? raw.is_stale : null,
    mappingSyncedAt: syncedAt,
  };
  return {
    account_number: raw.account_number,
    custodian: raw.custodian,
    account_type: raw.account_type,
    client_name: raw.client_name,
    positions: raw.positions
      .map((p) => {
        const rawSymbol = (p.symbol ?? "").trim();
        const symbolIsCusip = isCusipFormat(rawSymbol);
        return {
          cusip: symbolIsCusip ? rawSymbol.toUpperCase() : "",
          symbol: rawSymbol,
          description: (p.description ?? "").trim(),
          qty: Number(p.quantity) || 0,
          amount: p.market_value != null ? Number(p.market_value) : undefined,
          assetClass: p.asset_type ?? undefined,
          mapping: {
            ...statement,
            // Effective values already include operator overrides. Preserve
            // empty effective notes (an intentional clearing of engine notes).
            mappingTransferStatus: p.effective_status ?? p.transfer_eligible ?? null,
            mappingTransferNotes: p.effective_notes ?? p.transfer_notes ?? null,
            mappingTransferring: p.transferring?.trim().toUpperCase() === "YES"
              ? true
              : p.transferring?.trim().toUpperCase() === "NO" ? false : null,
          },
        };
      })
      // Ignore empty placeholder rows. The caller rejects unidentified rows
      // with quantity or value before persisting this mapped response.
      .filter((pos) => pos.symbol !== "" || pos.cusip !== ""),
  };
}

/** Outcome of a mapping action. `refused` carries the tracker's own status,
 * message and optional code, byte-for-byte what the browser route returns. */
export type MappingRefusal = { kind: "refused"; status: number; message: string; code?: string };
export type MappingActionResult = { kind: "ok" } | MappingRefusal;

export interface MappingActionRecord {
  id: string;
  assets: Array<{
    id: string;
    symbol: string;
    cusip: string | null;
    assetClass: string | null;
    amount: number | null;
  }>;
  statementAccountNumber: string | null;
  mappingAccountId: string | null;
}

export type SpreadsheetImportInput = z.input<typeof spreadsheetImportSchema>;

function refused(status: number, message: string, code?: string): MappingRefusal {
  return { kind: "refused", status, message, ...(code ? { code } : {}) };
}

/** Save a parsed mapping spreadsheet onto the transfer (browser route lines
 * 322-373 before extraction). */
export async function importAssetMappingSpreadsheet(
  acat: MappingActionRecord,
  body: unknown,
  createdBy: string
): Promise<MappingActionResult> {
  try {
    const parsed = spreadsheetImportSchema.safeParse(body);
    if (!parsed.success) {
      return refused(400, "Invalid asset-mapping spreadsheet data");
    }
    if (!acat.statementAccountNumber) {
      return refused(422, "Add the statement account number before importing a mapping spreadsheet");
    }
    if (!accountNumbersMatch(parsed.data.sourceAccountNumber, acat.statementAccountNumber)) {
      return refused(422, "The spreadsheet account does not match this transfer's statement account");
    }
    await persistPositions(
      acat.id,
      acat.assets,
      parsed.data.positions,
      "Spreadsheet Upload",
      undefined,
      undefined,
      buildTransferDocument({
        kind: "MAPPING_CSV",
        filename: parsed.data.filename ?? "asset-mapping.csv",
        createdBy,
        accountNumber: acat.statementAccountNumber,
        positions: parsed.data.positions.map((position) => ({ ...position, expectedQty: position.qty })),
      })
    );
    return { kind: "ok" };
  } catch (err) {
    return importFailure(err);
  }
}

/** The tracker's refusal for a failed spreadsheet import (route lines 470-476). */
export function importFailure(err: unknown): MappingRefusal {
  if (err instanceof DemoLimitError) return refused(err.status, err.message);
  // Database errors may embed saved CSV rows. Never put client document
  // contents into application logs.
  logger.error({ errorType: err instanceof Error ? err.name : "UnknownError", operation: "spreadsheet import", upstreamStatus: upstreamErrorStatus(err) }, "POST /api/asset-mapping failed");
  return refused(500, "Failed to import the asset-mapping spreadsheet");
}

/** Sync the transfer's positions from the remote asset-mapping service
 * (browser route lines 376-476 before extraction). */
export async function syncAssetMappingFromGcp(
  acat: MappingActionRecord,
  sourceAccountId?: string
): Promise<MappingActionResult> {
  try {
    const GCP_ASSET_MAPPING_URL = process.env.GCP_ASSET_MAPPING_URL;
    if (!GCP_ASSET_MAPPING_URL) {
      return refused(503, "GCP statement-pipeline not configured. Set GCP_ASSET_MAPPING_URL in .env.local");
    }

    const accountId = sourceAccountId ?? acat.mappingAccountId;
    if (!accountId && !acat.statementAccountNumber?.trim()) {
      return refused(422, "Add the statement account number or choose a mapping account to sync.", "MISSING_ACCOUNT_NUMBER");
    }

    const client = await getAuthenticatedClient(GCP_ASSET_MAPPING_URL);
    const pipelineUrl = new URL("/api/v1/positions", GCP_ASSET_MAPPING_URL);
    if (accountId) {
      pipelineUrl.searchParams.set("account_id", accountId);
    } else {
      pipelineUrl.searchParams.set("account_number", normalizePipelineAccountNumber(acat.statementAccountNumber!));
    }

    const gcpRes = await client.request<RawPipelineResponse>({
      url: pipelineUrl.toString(),
    });

    if (gcpRes.status !== 200) {
      logger.error({ status: gcpRes.status }, "statement-pipeline returned error");
      return refused(gcpRes.status, "Failed to fetch positions from statement-pipeline");
    }

    const syncedAt = new Date().toISOString();
    if (!Array.isArray(gcpRes.data.positions)) throw new Error("Invalid source positions response");
    if (!accountId) {
      const normalize = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();
      if (normalize(gcpRes.data.account_number ?? "") !== normalize(acat.statementAccountNumber!)) {
        throw new Error("Source response does not match the requested account");
      }
    }
    const gcpData = mapPipelineResponse(gcpRes.data, syncedAt);
    if (gcpRes.data.positions.some((position) => !position.symbol?.trim() && (Number(position.quantity) !== 0 || Number(position.market_value ?? 0) !== 0))) {
      return refused(422, "The source has positions without security identifiers. Correct the mapping before syncing.", "INVALID_SOURCE_POSITIONS");
    }
    const sourceAccount = mappingAccountSummary(gcpRes.data);
    if (accountId && !z.string().uuid().safeParse(sourceAccount.id).success) throw new Error("Invalid source account response");

    await persistPositions(
      acat.id,
      acat.assets,
      gcpData.positions,
      "GCP Project API",
      syncedAt,
      sourceAccount
    );
    return { kind: "ok" };
  } catch (err) {
    return syncFailure(err);
  }
}

/** Maps a thrown sync error to the tracker's refusal (route lines 449-476). */
export function syncFailure(err: unknown): MappingRefusal {
  if (err instanceof DemoLimitError) return refused(err.status, err.message);
  const status = upstreamErrorStatus(err);
  logger.error({ errorType: err instanceof Error ? err.name : "UnknownError", operation: "GCP sync", upstreamStatus: status }, "POST /api/asset-mapping failed");
  if (status === 404) {
    return refused(404, "This account is not available in asset mapping. Choose a mapping account, verify the statement number, or upload the mapping CSV.", "SOURCE_ACCOUNT_NOT_FOUND");
  }
  if (status === 409) {
    return refused(409, "Choose the source account registration before syncing. The account number alone cannot identify the correct holdings.", "SOURCE_ACCOUNT_SELECTION_REQUIRED");
  }
  if (status === 401 || status === 403) {
    return refused(502, "The asset-mapping service denied the sync request. Upload the mapping CSV or contact an administrator.");
  }
  return refused(500, "Failed to sync asset mapping from GCP. Try the mapping CSV upload instead.");
}
