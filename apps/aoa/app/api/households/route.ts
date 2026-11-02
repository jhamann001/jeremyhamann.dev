import { auth } from "@/auth";
import { getHouseholdDirectory } from "@/lib/data/households";
import { parseHouseholdDirectoryQuery } from "@/lib/navigation/household-query";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  // A different tab can replace the shared login without remounting this list.
  // Return only the public fingerprint, including on errors, so the browser can
  // discard old-login metadata even when both logins see identical content.
  const headers = {
    ...NO_STORE_HEADERS,
    "X-AOA-Navigation-Scope": session.navigationScope ?? "",
  };

  let query;
  try {
    query = parseHouseholdDirectoryQuery(new URL(request.url).searchParams);
  } catch {
    return Response.json({ error: "invalid_household_query" }, { status: 400, headers });
  }

  try {
    // Never accept identity/book scope from the URL or a previously cached page.
    // Each append authenticates again and enters a fresh RLS-scoped transaction.
    const directory = await getHouseholdDirectory(
      {
        role: (session.user as { role?: string }).role ?? "VIEWER",
        email: session.user.email ?? null,
      },
      query.filters,
      query.page,
      query.pageSize,
    );
    if (query.snapshot !== null && query.snapshot !== directory.snapshot) {
      return Response.json(
        { error: "household_directory_changed" },
        { status: 409, headers },
      );
    }
    // The data seam clamps legacy numbered page links. Progressive callers must
    // never mistake a clamped final page for the requested next page.
    if (directory.page !== query.page) {
      return Response.json(
        { error: "household_page_out_of_range" },
        { status: 416, headers },
      );
    }
    return Response.json({ ...directory, queryKey: query.queryKey }, { headers });
  } catch {
    // Driver messages, SQL, search text, source IDs and client data stay private.
    return Response.json(
      { error: "household_directory_unavailable" },
      { status: 503, headers },
    );
  }
}
