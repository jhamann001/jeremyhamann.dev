import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getAuthenticatedClient } from "@/lib/gcp-auth";
import { mappingAccountSummary } from "@/lib/mapping-account";
import { verifySecurityReconCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";

// Authenticated + live: never cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

function enabled() {
  return (
    process.env.EPIC_ACAT_SECURITY_RECON === "1" &&
    process.env.ROLLOUT_ACAT_SECURITY_RECON === "1"
  );
}

/** Mapping-account search for a transfer: the same upstream call and masked
 * summary as the tracker's browser route `GET /api/asset-mapping/accounts`. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { id } = await params;
  const caller = await verifySecurityReconCaller(request, "search");
  if (!caller) {
    logger.warn({ id, status: 401 }, "machine security recon accounts: unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { allowed } = await rateLimit(
    "machine-acat-security-recon-read",
    caller.email,
    { maxTokens: 120, interval: 60_000 },
  );
  if (!allowed) {
    logger.warn({ id, caller: caller.email, status: 429 }, "machine security recon accounts: rate limited");
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (typeof id !== "string" || id.trim() === "") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 100) {
    return NextResponse.json(
      { error: "Enter a client name or account number (2–100 characters)." },
      { status: 400 },
    );
  }
  try {
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!record) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const base = process.env.GCP_ASSET_MAPPING_URL;
    if (!base) {
      return NextResponse.json({ error: "Asset mapping is not configured." }, { status: 503 });
    }
    const client = await getAuthenticatedClient(base);
    const url = new URL("/api/v1/position-accounts", base);
    url.searchParams.set("q", q);
    const response = await client.request<{ accounts: Record<string, unknown>[]; truncated: boolean }>({
      url: url.toString(),
    });
    if (response.status !== 200 || !Array.isArray(response.data.accounts)) {
      throw new Error("Invalid source account response");
    }
    logger.info(
      { id, caller: caller.email, status: 200, count: response.data.accounts.length },
      "machine security recon accounts: ok",
    );
    return NextResponse.json({
      accounts: response.data.accounts.map(mappingAccountSummary),
      truncated: response.data.truncated === true,
    });
  } catch {
    // Upstream errors can contain the full search URL and auth headers.
    logger.error({ id, caller: caller.email, status: 502 }, "machine security recon accounts: failed");
    return NextResponse.json(
      { error: "Unable to search mapping accounts. Please try again." },
      { status: 502 },
    );
  }
}
