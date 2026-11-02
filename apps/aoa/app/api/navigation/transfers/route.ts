import { auth } from "@/auth";
import { getTransferDirectory, searchTransferDirectory } from "@/lib/data/transfer-directory";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";
import { fetchAcatList, AcatListError } from "@/lib/data/acat-status";
import { buildAcatChipMap, filterAcatChipMapForVisibleRows } from "@/lib/data/acat-lane";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  let scope = "";
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": scope } });
  try {
    const session = await auth(); scope = session?.navigationScope ?? "";
    if (!session?.user) return respond({ error: "unauthorized" }, 401);
    const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
    const params = new URL(request.url).searchParams;
    const mode = params.get("mode");
    if (params.getAll("mode").length > 1 || (mode && !["search", "chips"].includes(mode))) return respond({ error: "invalid_transfer_query" }, 400);
    params.delete("mode");
    if (mode === "search") {
      if ([...params.keys()].some(key => key !== "q") || params.getAll("q").length !== 1 || (params.get("q")?.length ?? 0) > 256 || /[\u0000-\u001f\u007f]/.test(params.get("q") ?? "")) return respond({ error: "invalid_transfer_search" }, 400);
      return respond(await searchTransferDirectory(identity, params.get("q") ?? ""));
    }
    let query;
    try { query = parseTransferBoardQuery(params, true); } catch { return respond({ error: "invalid_transfer_query" }, 400); }
    const result = await getTransferDirectory(identity, query);
    if (query.snapshot && query.snapshot !== result.snapshot) return respond({ error: "transfer_board_changed" }, 409);
    if (query.page > result.pageCount) return respond({ error: "transfer_page_out_of_range" }, 416);
    if (mode === "chips") {
      // Optional enrichment is requested only after cards paint, never blocks a
      // list page, and exposes chips only for freshly authorized page rows.
      try { return respond({ chips: filterAcatChipMapForVisibleRows(buildAcatChipMap(await fetchAcatList()), result.rows) }); }
      catch (error) { if (!(error instanceof AcatListError)) throw error; return respond({ chips: {} }); }
    }
    return respond(result);
  } catch { return respond({ error: "transfer_board_unavailable" }, 503); }
}
