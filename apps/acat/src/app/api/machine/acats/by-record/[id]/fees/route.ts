import { NextResponse } from "next/server";
import { localDateString } from "@/lib/acat-operational-defaults";
import {
  applySelectedFeeRules,
  readTransferFee,
  saveTransferFeeFields,
  type TransferFeeRead,
} from "@/lib/acat-record-write";
import {
  createdFeeId,
  feeActionSchema,
  feeContractEnabled,
  feeLogRows,
  parseChargedAmount,
  toHttpFee,
  type FeeLogRow,
  type TransferFee,
} from "@/lib/acat-fee-contract";
import { createFeeCreditRow, deleteFeeCreditRow, feeStoreConfigured, listFeeCreditRows } from "@/lib/fee-credit-store";
import { logger } from "@/lib/logger";
import { verifyFeeCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Snapshot = { fee: TransferFee | null; log: FeeLogRow[] | null };

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

async function readLog(row: TransferFeeRead): Promise<FeeLogRow[] | null> {
  const listed = await listFeeCreditRows({ clientName: row.clientName, accountNumber: row.apexAccountId });
  if (!listed.ok) return null;
  return feeLogRows(listed.body);
}

async function snapshot(id: string): Promise<Snapshot> {
  const row = await readTransferFee(id);
  if (!row) return { fee: null, log: null };
  return { fee: toHttpFee(row), log: await readLog(row) };
}

async function linkFailure(id: string, createdId: string, preFee: TransferFee) {
  let stored: TransferFeeRead | null;
  try {
    stored = await readTransferFee(id);
  } catch {
    logger.error({ id, status: 500 });
    return NextResponse.json({ error: "internal_error", fee: preFee, log: null }, { status: 500 });
  }
  if (createdId && stored?.feeCreditRequestId === createdId) {
    const again = await snapshot(id);
    return NextResponse.json(again, { status: 201 });
  }
  if (!createdId) {
    const again = stored ? { fee: toHttpFee(stored), log: await readLog(stored) } : { fee: preFee, log: null };
    return NextResponse.json({ error: "log_row_retained", ...again }, { status: 502 });
  }
  const removed = await deleteFeeCreditRow(createdId);
  const after = await snapshot(id);
  if (removed.ok) {
    return NextResponse.json({ error: "credit_request_id_not_stored", fee: preFee, log: after.log }, { status: 502 });
  }
  logger.error({ id, createdId, status: 502 });
  return NextResponse.json({ error: "log_row_retained", fee: preFee, log: after.log }, { status: 502 });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!feeContractEnabled()) return notFound();
  const caller = await verifyFeeCaller(request, "read");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = await rateLimit("machine-acat-fee-read", caller.email, { maxTokens: 120, interval: 60_000 });
  if (!limited.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { id } = await params;
  const row = await readTransferFee(id);
  if (!row) return notFound();
  const listed = await listFeeCreditRows({ clientName: row.clientName, accountNumber: row.apexAccountId });
  if (!listed.ok && listed.reason === "not_configured") {
    // The reimbursement log moved to Operations Tools, so an unset tracker store is the expected state, not a
    // failure. Answer 200 with the stored fee and no log: a 5xx here is recorded at ERROR severity on every
    // drawer open. A store that is set but fails still answers 502 below.
    logger.info({ id, caller: caller.email, status: 200, log: "not_configured" });
    return NextResponse.json({ fee: toHttpFee(row), log: null });
  }
  if (!listed.ok) {
    return NextResponse.json({ error: "log_unavailable", fee: toHttpFee(row), log: null }, { status: 502 });
  }
  logger.info({ id, caller: caller.email, status: 200 });
  return NextResponse.json({ fee: toHttpFee(row), log: feeLogRows(listed.body) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!feeContractEnabled()) return notFound();
  const caller = await verifyFeeCaller(request, "write");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = await rateLimit("machine-acat-fee-write", caller.email, { maxTokens: 60, interval: 60_000, failClosed: true });
  if (!limited.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    const current = await snapshot(id);
    return NextResponse.json({ error: "refused", ...current }, { status: 400 });
  }
  const parsed = feeActionSchema.safeParse(raw);
  if (!parsed.success) {
    const current = await snapshot(id);
    return NextResponse.json({ error: "refused", ...current }, { status: 400 });
  }

  const row = await readTransferFee(id);
  if (!row) return notFound();
  const before = await snapshot(id);

  try {
    if (parsed.data.action === "save") {
      const saved = await saveTransferFeeFields(id, parsed.data.fields, caller.email);
      if (!saved.ok) return NextResponse.json({ error: "refused", fee: saved.fee, log: before.log }, { status: 400 });
      logger.info({ id, caller: caller.email, status: 200 });
      return NextResponse.json(await snapshot(id));
    }

    if (parsed.data.action === "apply") {
      const applied = await applySelectedFeeRules(id, parsed.data.feeRuleIds, caller.email);
      if (!applied.ok && applied.reason === "not_found") return notFound();
      if (!applied.ok && applied.reason === "no_rules") {
        return NextResponse.json({ error: "no_rules", fee: applied.fee, log: before.log }, { status: 400 });
      }
      if (!applied.ok) return NextResponse.json({ error: "refused", fee: applied.fee, log: before.log }, { status: 400 });
      logger.info({ id, caller: caller.email, status: 200 });
      return NextResponse.json(await snapshot(id));
    }

    if (parseChargedAmount(row.feeAmount) <= 0) {
      return NextResponse.json({ error: "refused", ...before }, { status: 400 });
    }
    if (!feeStoreConfigured()) {
      return NextResponse.json({ error: "log_not_configured", fee: before.fee, log: null }, { status: 503 });
    }
    const created = await createFeeCreditRow({
      clientName: row.clientName,
      feeAmount: parseChargedAmount(row.feeAmount),
      accountNumber: row.apexAccountId,
      apexRequest: row.feeApexTicket || undefined,
    });
    if (!created.ok && created.reason === "invalid") {
      return NextResponse.json({ error: "refused", ...before }, { status: 400 });
    }
    if (!created.ok && created.reason === "unreadable") {
      return NextResponse.json({ error: "log_row_retained", fee: before.fee, log: null }, { status: 502 });
    }
    if (!created.ok) {
      const again = await snapshot(id);
      return NextResponse.json({ error: "log_failed", fee: again.fee, log: again.log }, { status: 502 });
    }
    const createdId = createdFeeId(created.body);
    try {
      const linked = await saveTransferFeeFields(
        id,
        { feeCreditRequestId: createdId, feeRequestSubmitted: row.feeRequestSubmitted || localDateString() },
        caller.email,
      );
      if (!linked.ok) return linkFailure(id, createdId, toHttpFee(row));
    } catch {
      return linkFailure(id, createdId, toHttpFee(row));
    }
    logger.info({ id, caller: caller.email, status: 201 });
    return NextResponse.json(await snapshot(id), { status: 201 });
  } catch {
    logger.error({ id, status: 500 });
    return NextResponse.json({ error: "internal_error", ...before }, { status: 500 });
  }
}
