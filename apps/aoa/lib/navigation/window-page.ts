import { appendProgressiveRows } from "./progressive-page";

/** Only mounted components retain records; navigation storage remains metadata-only. */
export type WindowPage<Row, Meta = Record<string, never>> = {
  rows: Row[];
  firstPage: number;
  pageSize: number;
  /** Cumulative row count in this window, not a population total. */
  loaded: number;
  snapshot: string;
  hasMore: boolean;
  meta: Meta;
};

export const WINDOW_PAGE_LIMIT = 5_000;
const ENDPOINT = /^\/api\/navigation\/(?:audit\/rows|crm\/window|crm-duplicates\/window)$/;
const validSnapshot = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export class WindowPageError extends Error {
  constructor(public readonly kind: "changed" | "unauthorized" | "unavailable") { super(kind); }
}

export function parseWindowPageParams(params: URLSearchParams, defaultSize = 100) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key);
    if (params.getAll(key).length > 1 || (raw !== null && (!/^(?:0|[1-9]\d{0,6})$/.test(raw)
      || Number(raw) < min || Number(raw) > max))) throw new Error("invalid_window_page");
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid_window_page");
    return value;
  };
  const firstPage = number("page", 1, 1, 1_000_000);
  const pageSize = number("pageSize", defaultSize, 100, 200);
  // Both divide the fixed window exactly, so a numbered next-window URL cannot
  // skip a fractional page at the 5,000-row boundary.
  if (pageSize !== 100 && pageSize !== 200) throw new Error("invalid_window_page_size");
  const loaded = number("loaded", 0, 0, WINDOW_PAGE_LIMIT);
  // A continuation begins only after a complete chunk. A short terminal chunk
  // has no continuation, and a full window moves to the next numbered URL.
  if (loaded % pageSize !== 0 || loaded + pageSize > WINDOW_PAGE_LIMIT) throw new Error("invalid_window_loaded");
  const snapshot = params.get("snapshot");
  if (params.getAll("snapshot").length > 1 || (loaded === 0 ? snapshot !== null : !validSnapshot(snapshot))) {
    throw new Error("invalid_window_snapshot");
  }
  const restoreRows = params.has("restoreRows") ? number("restoreRows", pageSize, pageSize, WINDOW_PAGE_LIMIT) : undefined;
  if (restoreRows !== undefined && (loaded !== 0 || snapshot !== null || restoreRows % pageSize !== 0)) {
    throw new Error("invalid_window_restore");
  }
  return { firstPage, pageSize, loaded, snapshot, ...(restoreRows === undefined ? {} : { restoreRows }) };
}

export function appendWindowRows<Row>(current: Row[], next: Row[], idKey: keyof Row): Row[] {
  try { return appendProgressiveRows(current, next, idKey); }
  catch { throw new WindowPageError("changed"); }
}

export async function fetchWindowPage<Row, Meta>(
  endpoint: string, firstPage: number, pageSize: number, loaded: number, snapshot: string | null,
  signal: AbortSignal, expectedScope: string, idKey: keyof Row, fetcher: typeof fetch = fetch,
  restoreRows?: number,
): Promise<WindowPage<Row, Meta>> {
  let url: URL;
  try { url = new URL(endpoint, "https://navigation.invalid"); }
  catch { throw new WindowPageError("changed"); }
  if (!endpoint.startsWith("/api/navigation/") || url.origin !== "https://navigation.invalid"
    || !ENDPOINT.test(url.pathname) || url.hash) throw new WindowPageError("changed");
  url.searchParams.set("page", String(firstPage));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("loaded", String(loaded));
  if (snapshot !== null) url.searchParams.set("snapshot", snapshot); else url.searchParams.delete("snapshot");
  if (restoreRows !== undefined) url.searchParams.set("restoreRows", String(restoreRows)); else url.searchParams.delete("restoreRows");
  try { parseWindowPageParams(url.searchParams); } catch { throw new WindowPageError("changed"); }
  signal.throwIfAborted();
  const response = await fetcher(`${url.pathname}?${url.searchParams}`, {
    signal, cache: "no-store", credentials: "same-origin", redirect: "error",
  });
  if ([401, 403, 404].includes(response.status)) throw new WindowPageError("unauthorized");
  const responseScope = response.headers.get("X-AOA-Navigation-Scope");
  if ((response.ok || responseScope !== null) && (responseScope !== expectedScope
    || (responseScope !== "" && !/^[a-f0-9]{64}$/.test(responseScope ?? "")))) throw new WindowPageError("unauthorized");
  if ([409, 416].includes(response.status)) throw new WindowPageError("changed");
  if (!response.ok) throw new WindowPageError("unavailable");
  let result: WindowPage<Row, Meta>;
  try { result = await response.json(); }
  catch { signal.throwIfAborted(); throw new WindowPageError("unavailable"); }
  signal.throwIfAborted();
  const capacity = Math.min(restoreRows ?? pageSize, WINDOW_PAGE_LIMIT - loaded);
  if (!result || !Array.isArray(result.rows) || result.firstPage !== firstPage || result.pageSize !== pageSize
    || !Number.isSafeInteger(result.loaded) || result.loaded !== loaded + result.rows.length
    || result.loaded > WINDOW_PAGE_LIMIT || typeof result.hasMore !== "boolean"
    || result.rows.length > capacity || (result.hasMore && result.rows.length !== capacity)
    || (capacity === 0 && result.rows.length !== 0) || !validSnapshot(result.snapshot)
    || (result.rows.length > 0 && snapshot === result.snapshot)
    || result.meta === null || typeof result.meta !== "object" || Array.isArray(result.meta)) {
    throw new WindowPageError("changed");
  }
  appendWindowRows([], result.rows, idKey);
  return result;
}

/** Rebuild the remembered range in one fresh, bounded RLS read; never reuse stored rows. */
export async function rebuildWindowPage<Row, Meta>(
  endpoint: string, firstPage: number, pageSize: number, rememberedPages: number,
  signal: AbortSignal, expectedScope: string, idKey: keyof Row, fetcher: typeof fetch = fetch,
): Promise<WindowPage<Row, Meta>> {
  if (!Number.isSafeInteger(rememberedPages) || rememberedPages < 1) throw new WindowPageError("changed");
  if (pageSize !== 100 && pageSize !== 200) throw new WindowPageError("changed");
  const wantedPages = Math.min(rememberedPages, WINDOW_PAGE_LIMIT / pageSize);
  return fetchWindowPage<Row, Meta>(endpoint, firstPage, pageSize, 0, null, signal, expectedScope, idKey, fetcher,
    wantedPages * pageSize);
}
