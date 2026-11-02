import "server-only";
import { auth } from "@/auth";
import { searchHouseholdEmails } from "@/lib/data/household-email-search";
import { isHouseholdHistoryId } from "./household-history-query";
import { normalizeEmailSearchTerm } from "@/lib/email-search/term";
import { NAVIGATION_HEADERS } from "./progressive-page";

// ticket: the search term travels only in a POST body. It is never accepted from
// the URL (navigation memory persists hrefs and request logs record them), never
// echoed in an error, never logged, and responses stay private/no-store.
const MAX_BODY_BYTES = 4096;
const KEYS = new Set(["household", "q", "page", "snapshot"]);

export type HouseholdEmailSearchRequest = { householdId: string; term: string; page: number; snapshot: string | null };

export function parseHouseholdEmailSearchRequest(url: string, contentType: string | null, raw: string): HouseholdEmailSearchRequest {
  if ([...new URL(url).searchParams.keys()].length) throw new Error("search_params_in_url");
  if (!/^application\/json(?:;|$)/i.test(contentType ?? "")) throw new Error("content_type");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("too_large");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error("malformed"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("malformed");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !KEYS.has(key))) throw new Error("unknown_key");
  if (!isHouseholdHistoryId(record.household)) throw new Error("household");
  const term = normalizeEmailSearchTerm(record.q);
  if (!term) throw new Error("term");
  const page = record.page ?? 1;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Error("page");
  const snapshot = record.snapshot ?? null;
  if (snapshot !== null && (typeof snapshot !== "string" || !/^[a-f0-9]{64}$/.test(snapshot))) throw new Error("snapshot");
  if (page > 1 && !snapshot) throw new Error("snapshot");
  return { householdId: record.household, term, page, snapshot };
}

export async function householdEmailSearchResponse(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "household_email_search_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  let query: HouseholdEmailSearchRequest;
  try { query = parseHouseholdEmailSearchRequest(request.url, request.headers.get("content-type"), await request.text()); }
  catch { return Response.json({ error: "invalid_household_email_search" }, { status: 400, headers }); }
  try {
    const result = await searchHouseholdEmails({
      role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null,
    }, query.householdId, query.term, { page: query.page });
    if (!result) return Response.json({ error: "household_unavailable" }, { status: 404, headers });
    if (query.snapshot && query.snapshot !== result.snapshot) return Response.json({ error: "household_email_search_changed" }, { status: 409, headers });
    if (result.page !== query.page) return Response.json({ error: "household_email_search_page_out_of_range" }, { status: 416, headers });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: "household_email_search_unavailable" }, { status: 503, headers });
  }
}
