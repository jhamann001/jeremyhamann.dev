import { householdEmailSearchResponse } from "@/lib/navigation/household-email-search-api";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";
// POST only: the search term must never travel in a URL (ticket).
export const POST = (request: Request) => householdEmailSearchResponse(request);
const methodNotAllowed = () => Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...NAVIGATION_HEADERS, Allow: "POST" } });
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
