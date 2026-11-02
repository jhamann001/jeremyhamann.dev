/** Only the mounted component holds these records. Persisted navigation is metadata-only. */
export type ProgressivePage<Row, Meta = Record<string, never>> = {
  rows: Row[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  snapshot: string;
  meta: Meta;
};

export class ProgressivePageError extends Error {
  constructor(public readonly kind: "changed" | "unauthorized" | "unavailable") { super(kind); }
}

const ENDPOINT = /^\/api\/navigation\/(?:clients|crm|crm-duplicates|audit|reporting|deals|transfers|household-tasks|household-email|household-activity)$/;
export const NAVIGATION_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-AOA-Navigation-Scope": "" };
export const validSnapshot = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32,64}$/.test(value);

export function parseProgressivePageParams(params: URLSearchParams, defaultSize = 100) {
  const number = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (params.getAll(key).length > 1 || (raw !== null && (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max))) {
      throw new Error("invalid_list_page");
    }
    return raw === null ? fallback : Number(raw);
  };
  const page = number("page", 1, 1_000_000);
  const pageSize = number("pageSize", defaultSize, 200);
  const snapshot = params.get("snapshot");
  if (params.getAll("snapshot").length > 1 || (snapshot !== null && !validSnapshot(snapshot))) throw new Error("invalid_snapshot");
  return { page, pageSize, snapshot };
}

export function appendProgressiveRows<Row>(current: Row[], next: Row[], idKey: keyof Row): Row[] {
  const ids = new Set<string>();
  for (const row of [...current, ...next]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ProgressivePageError("changed");
    const id = row[idKey];
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/.test(id) || ids.has(id)) throw new ProgressivePageError("changed");
    ids.add(id);
  }
  return [...current, ...next];
}

export async function fetchProgressivePage<Row, Meta>(
  endpoint: string, page: number, pageSize: number, snapshot: string | null,
  signal: AbortSignal, expectedScope: string, idKey: keyof Row, fetcher: typeof fetch = fetch,
): Promise<ProgressivePage<Row, Meta>> {
  const url = new URL(endpoint, "https://navigation.invalid");
  if (!endpoint.startsWith("/api/navigation/") || url.origin !== "https://navigation.invalid" || !ENDPOINT.test(url.pathname) || url.hash) {
    throw new ProgressivePageError("changed");
  }
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  if (snapshot) url.searchParams.set("snapshot", snapshot); else url.searchParams.delete("snapshot");
  try { parseProgressivePageParams(url.searchParams); } catch { throw new ProgressivePageError("changed"); }
  signal.throwIfAborted();
  const response = await fetcher(`${url.pathname}?${url.searchParams}`, {
    signal, cache: "no-store", credentials: "same-origin", redirect: "error",
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new ProgressivePageError("unauthorized");
  const responseScope = response.headers.get("X-AOA-Navigation-Scope");
  if ((response.ok || responseScope !== null) && (responseScope !== expectedScope ||
    (responseScope !== "" && !/^[a-f0-9]{64}$/.test(responseScope ?? "")))) throw new ProgressivePageError("unauthorized");
  if (response.status === 409 || response.status === 416) throw new ProgressivePageError("changed");
  if (!response.ok) throw new ProgressivePageError("unavailable");
  let result: ProgressivePage<Row, Meta>;
  try { result = await response.json(); } catch { signal.throwIfAborted(); throw new ProgressivePageError("unavailable"); }
  signal.throwIfAborted();
  if (!result || !Array.isArray(result.rows) || result.page !== page || result.pageSize !== pageSize ||
    !Number.isSafeInteger(result.total) || result.total < 0 ||
    result.pageCount !== Math.max(1, Math.ceil(result.total / pageSize)) || page > result.pageCount ||
    result.rows.length !== Math.max(0, Math.min(pageSize, result.total - (page - 1) * pageSize)) ||
    !validSnapshot(result.snapshot) || (snapshot !== null && snapshot !== result.snapshot) ||
    result.meta === null || typeof result.meta !== "object" || Array.isArray(result.meta)) throw new ProgressivePageError("changed");
  appendProgressiveRows([], result.rows, idKey);
  return result;
}
