import "server-only";
import { createHash } from "node:crypto";
import { WINDOW_PAGE_LIMIT, WindowPageError, type WindowPage, parseWindowPageParams } from "@/lib/navigation/window-page";

export type CrmWindowRequest = ReturnType<typeof parseWindowPageParams>;

export function crmWindowLimit(request: CrmWindowRequest): number {
  if (!Number.isSafeInteger(request.firstPage) || request.firstPage < 1 || request.firstPage > 1_000_000
    || ![100, 200].includes(request.pageSize)
    || !Number.isSafeInteger(request.loaded) || request.loaded < 0 || request.loaded > WINDOW_PAGE_LIMIT
    || request.loaded % request.pageSize !== 0 || request.loaded + request.pageSize > WINDOW_PAGE_LIMIT
    || (request.loaded === 0 ? request.snapshot !== null : !/^[a-f0-9]{64}$/.test(request.snapshot ?? ""))) {
    throw new WindowPageError("changed");
  }
  if (request.restoreRows !== undefined) {
    if (request.loaded !== 0 || request.snapshot !== null
      || !Number.isSafeInteger(request.restoreRows) || request.restoreRows < request.pageSize
      || request.restoreRows > WINDOW_PAGE_LIMIT || request.restoreRows % request.pageSize !== 0) {
      throw new WindowPageError("changed");
    }
    return request.restoreRows;
  }
  return Math.min(WINDOW_PAGE_LIMIT, request.loaded + request.pageSize);
}

/** Full rendered rows, current RLS and deterministic window/filter settings.
 * Unseen-row edits alone do not invalidate rows the browser has never loaded.
 * Counts are refreshed independently and never replaced with estimates. */
export function buildCrmWindow<Row, Meta>(request: CrmWindowRequest, rows: Row[], total: number,
  binding: unknown[], meta: Meta): WindowPage<Row, Meta> {
  const limit = crmWindowLimit(request);
  if (rows.length > limit || rows.length < request.loaded) throw new WindowPageError("changed");
  const digest = (prefix: Row[]) => createHash("sha256")
    .update(JSON.stringify(["crm-loaded-window-v1", request.firstPage, request.pageSize, binding, prefix])).digest("hex");
  if (request.loaded > 0 && digest(rows.slice(0, request.loaded)) !== request.snapshot) throw new WindowPageError("changed");
  return {
    rows: rows.slice(request.loaded), firstPage: request.firstPage, pageSize: request.pageSize,
    loaded: rows.length, snapshot: digest(rows),
    hasMore: (request.firstPage - 1) * request.pageSize + rows.length < total, meta,
  };
}
