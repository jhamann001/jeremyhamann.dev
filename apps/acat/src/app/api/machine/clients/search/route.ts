import { NextResponse } from "next/server";
import { verifyAcatReadCaller } from "@/lib/machine-auth";
import { searchClients } from "@/lib/client-directory";
import { clientSearchSchema, formatZodError } from "@/lib/validators";
import { directoryErrorResponse, identityError, IDENTITY_RESPONSE_HEADERS } from "@/lib/client-identity-http";
import { rateLimit } from "@/lib/rate-limit-redis";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SEARCH_LIMIT = { maxTokens: 60, interval: 60_000 };

export async function GET(request: Request) {
  const caller = await verifyAcatReadCaller(request, "clients");
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: IDENTITY_RESPONSE_HEADERS });
  }
  const { allowed } = await rateLimit("machine-client-search", caller.email, SEARCH_LIMIT);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: IDENTITY_RESPONSE_HEADERS });
  }
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit");
  const parsed = clientSearchSchema.safeParse({
    query: url.searchParams.get("query") ?? "",
    ...(limit ? { limit: Number(limit) } : {}),
  });
  if (!parsed.success) return identityError("INVALID_REQUEST", formatZodError(parsed.error), 400);
  try {
    const result = await searchClients(parsed.data.query, parsed.data.limit);
    return NextResponse.json(result, { headers: IDENTITY_RESPONSE_HEADERS });
  } catch (error) {
    return directoryErrorResponse(error) ?? identityError("DIRECTORY_UNAVAILABLE", "Client search is temporarily unavailable", 503);
  }
}
