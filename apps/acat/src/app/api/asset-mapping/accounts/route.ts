import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedClient } from "@/lib/gcp-auth";
import { mappingAccountSummary } from "@/lib/mapping-account";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const acatId = searchParams.get("acatId");
  const q = searchParams.get("q")?.trim() ?? "";
  if (!acatId || q.length < 2 || q.length > 100) {
    return NextResponse.json({ error: "Enter a client name or account number (2–100 characters)." }, { status: 400 });
  }
  try {
    const record = await prisma.acatRecord.findUnique({ where: { id: acatId, deletedAt: null }, select: { id: true } });
    if (!record) return NextResponse.json({ error: "ACAT not found" }, { status: 404 });
    const base = process.env.GCP_ASSET_MAPPING_URL;
    if (!base) return NextResponse.json({ error: "Asset mapping is not configured." }, { status: 503 });
    const client = await getAuthenticatedClient(base);
    const url = new URL("/api/v1/position-accounts", base);
    url.searchParams.set("q", q);
    const response = await client.request<{ accounts: Record<string, unknown>[]; truncated: boolean }>({ url: url.toString() });
    if (response.status !== 200 || !Array.isArray(response.data.accounts)) throw new Error("Invalid source account response");
    return NextResponse.json({ accounts: response.data.accounts.map(mappingAccountSummary), truncated: response.data.truncated === true });
  } catch {
    // Upstream errors can contain the full search URL and auth headers.
    logger.error("Mapping account search failed");
    return NextResponse.json({ error: "Unable to search mapping accounts. Please try again." }, { status: 502 });
  }
}
