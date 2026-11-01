import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifySecurityReconCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { applyAcatPatch } from "@/lib/acat-record-write";
import { parseApexFile } from "@/lib/parse-apex-csv";
import { parseAssetMappingCsv } from "@/lib/parse-asset-mapping-csv";
import {
  importAssetMappingSpreadsheet,
  syncAssetMappingFromGcp,
  type MappingActionResult,
} from "@/lib/asset-mapping-actions";
import {
  previewReconCounts,
  reconcile,
  storedReconCounts,
  storedReconRows,
  toMapStatus,
} from "@/lib/security-recon";
import type { Asset } from "@/lib/types";

// Authenticated + live: never cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAPPING_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const REFUSAL_STATUSES = new Set([400, 404, 409, 422, 502, 503]);

function enabled() {
  return (
    process.env.EPIC_ACAT_SECURITY_RECON === "1" &&
    process.env.ROLLOUT_ACAT_SECURITY_RECON === "1"
  );
}

const rowSchema = z.object({
  id: z.string().min(1).max(100),
  symbol: z.string().max(100),
  description: z.string().max(500),
  cusip: z.string().max(20).nullish(),
  actualQty: z.number().finite(),
  amount: z.number().finite().nullish(),
  assetClass: z.string().max(100).nullish(),
  status: z.enum(["Matched", "Mismatch", "Missing", "Unexpected", "Pending", "Expected", "Info"]),
  issue: z.string().max(2000).nullish(),
  notes: z.string().max(5000).nullish(),
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh"), sourceAccountId: z.string().uuid().optional() }),
  z.object({
    action: z.literal("upload"),
    kind: z.enum(["apex", "mapping"]),
    filename: z.string().min(1).max(255),
    text: z.string().max(5_000_000),
  }),
  z.object({
    action: z.literal("save"),
    rows: z.array(rowSchema).max(500),
    apexUploaded: z.boolean(),
    overriddenIds: z.array(z.string().max(100)).max(500),
  }),
]);

async function loadRecord(id: string) {
  return prisma.acatRecord.findUnique({
    where: { id, deletedAt: null },
    include: { assets: true },
  });
}
type LoadedRecord = NonNullable<Awaited<ReturnType<typeof loadRecord>>>;

const assetsOf = (record: LoadedRecord) => record.assets as unknown as Asset[];

function sourceAccountOf(record: LoadedRecord) {
  const raw = record.mappingAccountSummary as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  return {
    id: text("id"),
    clientName: text("clientName"),
    holder: text("holder"),
    registration: text("registration"),
    custodian: text("custodian"),
    accountNumberLast4: typeof raw.accountNumberLast4 === "string" ? raw.accountNumberLast4 : null,
    statementDate: typeof raw.statementDate === "string" ? raw.statementDate : null,
    isHistorical: raw.isHistorical === true,
  };
}

/** The stored reconciliation for one transfer. No statement account number is
 * returned; the linked source account carries last-four digits only. */
function snapshot(record: LoadedRecord) {
  const assets = assetsOf(record);
  return {
    acatId: record.id,
    mappingSource: record.mappingSource,
    apexSource: record.apexSource,
    lastSynced: record.mappingSyncedAt ?? null,
    sourceAccount: sourceAccountOf(record),
    hasStatementAccount: Boolean(record.statementAccountNumber?.trim()),
    positions: storedReconRows(assets),
    counts: storedReconCounts(assets),
  };
}

// Header values must be single-line printable ASCII.
function headerSafe(message: string) {
  return message.replace(/[^\x20-\x7e]/g, "?").slice(0, 500);
}

/** A refused action returns the stored positions unchanged as the whole body;
 * the tracker's own message travels in a response header. */
function refusal(record: LoadedRecord, status: number, message: string) {
  return NextResponse.json(snapshot(record), {
    status,
    headers: { "x-recon-refusal": headerSafe(message) },
  });
}

function internalError() {
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

async function authorize(request: Request, access: "read" | "write", id: string) {
  if (!enabled()) {
    return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) } as const;
  }
  const caller = await verifySecurityReconCaller(request, access);
  if (!caller) {
    logger.warn({ id, status: 401 }, "machine security recon: unauthorized");
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  const { allowed } = await rateLimit(
    access === "read" ? "machine-acat-security-recon-read" : "machine-acat-security-recon-write",
    caller.email,
    access === "read"
      ? { maxTokens: 120, interval: 60_000 }
      : { maxTokens: 30, interval: 60_000, failClosed: true },
  );
  if (!allowed) {
    logger.warn({ id, caller: caller.email, status: 429 }, "machine security recon: rate limited");
    return { ok: false, response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) } as const;
  }
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) } as const;
  }
  return { ok: true, caller } as const;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const gate = await authorize(request, "read", id);
  if (!gate.ok) return gate.response;
  try {
    const record = await loadRecord(id);
    if (!record) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = snapshot(record);
    logger.info(
      { id, caller: gate.caller.email, status: 200, counts: body.counts },
      "machine security recon read: ok",
    );
    return NextResponse.json(body);
  } catch (err) {
    logger.error({ err, id, caller: gate.caller.email, status: 500 }, "machine security recon read: failed");
    return internalError();
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const gate = await authorize(request, "write", id);
  if (!gate.ok) return gate.response;
  const caller = gate.caller.email;
  let action = "unknown";
  try {
    const record = await loadRecord(id);
    if (!record) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      raw = undefined;
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return refusal(record, 400, "Invalid security reconciliation request");
    }
    const body = parsed.data;
    action = body.action;

    // An action either refuses (stored snapshot, tracker status and message),
    // fails (opaque 500), or succeeds (re-read and return the stored snapshot).
    const finish = async (result: MappingActionResult) => {
      if (result.kind === "refused") {
        if (!REFUSAL_STATUSES.has(result.status)) {
          logger.error({ id, caller, action, status: result.status }, "machine security recon: action failed");
          return internalError();
        }
        logger.info({ id, caller, action, status: result.status }, "machine security recon: refused");
        return refusal(record, result.status, result.message);
      }
      const updated = await loadRecord(id);
      if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
      const out = snapshot(updated);
      logger.info({ id, caller, action, status: 200, counts: out.counts }, "machine security recon: ok");
      return NextResponse.json(out);
    };

    if (body.action === "refresh") {
      return await finish(await syncAssetMappingFromGcp(record, body.sourceAccountId));
    }

    if (body.action === "upload") {
      if (!body.filename.toLowerCase().endsWith(".csv")) {
        return refusal(record, 400, "Please upload a .csv file.");
      }
      if (body.kind === "apex") {
        let apex: ReturnType<typeof parseApexFile>;
        try {
          apex = parseApexFile(body.text);
        } catch (err) {
          return refusal(record, 422, err instanceof Error ? err.message : "Failed to parse CSV");
        }
        const rows = reconcile(assetsOf(record), apex.positions);
        const out = {
          ...snapshot(record),
          preview: { apexFormat: apex.format, positions: rows, counts: previewReconCounts(rows) },
        };
        logger.info(
          { id, caller, action, kind: "apex", status: 200, counts: out.preview.counts },
          "machine security recon: preview",
        );
        return NextResponse.json(out);
      }
      if (Buffer.byteLength(body.text) > MAPPING_FILE_LIMIT_BYTES) {
        return refusal(record, 422, "Mapping CSV must be 2 MB or smaller.");
      }
      if (!record.statementAccountNumber) {
        return refusal(record, 422, "Add the statement account number before uploading a mapping CSV.");
      }
      let mapping: ReturnType<typeof parseAssetMappingCsv>;
      try {
        mapping = parseAssetMappingCsv(body.text, record.statementAccountNumber);
      } catch (err) {
        return refusal(record, 422, err instanceof Error ? err.message : "Mapping import failed");
      }
      return await finish(
        await importAssetMappingSpreadsheet(
          record,
          {
            acatId: record.id,
            source: "spreadsheet",
            filename: body.filename,
            sourceAccountNumber: mapping.accountLabel,
            positions: mapping.positions,
          },
          caller,
        ),
      );
    }

    // save: build the patch exactly as the tracker's Save Recon Results does.
    const overridden = new Set(body.overriddenIds);
    const assets = body.rows
      .filter((r) => r.id && !r.id.startsWith("apex-extra-"))
      .map((r) => ({
        id: r.id,
        actualQty: r.actualQty,
        mapStatus: toMapStatus(r.status),
        issue: r.issue ?? null,
        notes: r.notes ?? null,
      }));
    const newAssets = body.rows
      .filter((r) => r.id.startsWith("apex-extra-") && overridden.has(r.id))
      .map((r) => ({
        symbol: r.symbol,
        description: r.description,
        cusip: r.cusip ?? null,
        expectedQty: 0,
        actualQty: r.actualQty,
        mapStatus: toMapStatus(r.status),
        issue: r.issue ?? null,
        notes: r.notes ?? null,
        amount: r.amount ?? null,
        assetClass: r.assetClass ?? null,
      }));
    const result = await applyAcatPatch({
      id,
      body: {
        ...(body.apexUploaded ? { apexSource: "Uploaded" } : {}),
        assets,
        ...(newAssets.length > 0 ? { newAssets } : {}),
      },
      performedBy: caller,
    });
    if (result.kind === "response") {
      const status = result.response.status;
      if (REFUSAL_STATUSES.has(status)) {
        const message = await result.response
          .json()
          .then((payload: { error?: unknown }) => (typeof payload.error === "string" ? payload.error : "Failed to save"))
          .catch(() => "Failed to save");
        logger.info({ id, caller, action, status }, "machine security recon: refused");
        return refusal(record, status, message);
      }
      logger.error({ id, caller, action, status }, "machine security recon: save failed");
      return internalError();
    }
    return await finish({ kind: "ok" });
  } catch (err) {
    logger.error({ err, id, caller, action, status: 500 }, "machine security recon write: failed");
    return internalError();
  }
}
