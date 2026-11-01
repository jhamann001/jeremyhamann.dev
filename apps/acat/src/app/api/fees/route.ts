import { NextRequest, NextResponse } from "next/server";
import { createFeeCreditRow, feeStoreConfigured, listFeeCreditRows } from "@/lib/fee-credit-store";
import { demoLimitMessage } from "@/lib/demo/limits";
import { personaSignInEnabled } from "@/lib/demo/personas";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NOT_CONFIGURED = {
  error: "Fee Store DB not configured. Set FEE_STORE_API_KEY, FEE_STORE_DB_URL, and FEE_STORE_FEES_TABLE_ID in .env.local",
};

// The reimbursement log moved to Operations Tools, so an unset Fee Store store is the expected state for a read, not
// a failure. The records drawer (FeesTab) reads this on every open, and Cloud Run records any 5xx request at ERROR
// severity, so the read answers 200 with an empty log. A configured store that fails still forwards its status, and
// POST with the store unset still answers 503 (nothing is created).
const EMPTY_LOG: unknown[] = [];

export async function GET(request: NextRequest) {
  if (!feeStoreConfigured()) return NextResponse.json(EMPTY_LOG);
  const { searchParams } = new URL(request.url);
  const listed = await listFeeCreditRows({
    clientName: searchParams.get("clientName"),
    accountNumber: searchParams.get("accountNumber"),
  });
  if (!listed.ok) {
    if (listed.reason === "not_configured") return NextResponse.json(EMPTY_LOG);
    if (listed.reason === "upstream") {
      return NextResponse.json({ error: "Failed to fetch fee records from Fee Store DB" }, { status: listed.status });
    }
    return NextResponse.json({ error: "Failed to connect to Fee Store DB" }, { status: 500 });
  }
  return NextResponse.json(listed.body);
}

export async function POST(request: NextRequest) {
  if (!feeStoreConfigured()) return NextResponse.json(NOT_CONFIGURED, { status: 503 });
  try {
    const body = await request.json();
    const created = await createFeeCreditRow(body);
    if (!created.ok) {
      if (created.reason === "invalid") return NextResponse.json({ error: created.error }, { status: 400 });
      if (created.reason === "not_configured") return NextResponse.json(NOT_CONFIGURED, { status: 503 });
      if (created.reason === "upstream") {
        if (created.status === 429 && personaSignInEnabled()) {
          return NextResponse.json({ error: demoLimitMessage("feeCredits") }, { status: 429 });
        }
        return NextResponse.json({ error: "Failed to create fee record in Fee Store DB" }, { status: created.status });
      }
      return NextResponse.json({ error: "Failed to connect to Fee Store DB" }, { status: 500 });
    }
    return NextResponse.json(created.body, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to connect to Fee Store DB" }, { status: 500 });
  }
}
