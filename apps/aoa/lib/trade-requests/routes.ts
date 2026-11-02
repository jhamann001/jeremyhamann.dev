export const TRADE_REQUESTS_ROUTES = {
  home: "/trade-requests",
  newRequest: "/trade-requests/new",
  tradingQueue: "/trade-requests/queue",
  drift: "/trade-requests/drift",
  roster: "/trade-requests/roster",
} as const;

export type TradeRequestsView = keyof typeof TRADE_REQUESTS_ROUTES;

export function tradeRequestDetailRoute(id: string): string {
  return `/trade-requests/${encodeURIComponent(id)}`;
}

/** A request opened over the Trading Queue (rendered by the queue's layout, so the queue stays mounted). */
export function queueRequestRoute(id: string): string {
  return `${TRADE_REQUESTS_ROUTES.tradingQueue}/${encodeURIComponent(id)}`;
}

const RESERVED_SEGMENTS = new Set(["queue", "new", "drift", "roster"]);

/** The request id in a request address (tradeRequestDetailRoute or queueRequestRoute), or null for any other path. */
export function requestIdFromPath(pathname: string | null): string | null {
  const path = pathname ?? "";
  const nested = /^\/trade-requests\/queue\/([^/]+)\/?$/.exec(path);
  const top = /^\/trade-requests\/([^/]+)\/?$/.exec(path);
  const raw = nested?.[1] ?? (top && !RESERVED_SEGMENTS.has(top[1]) ? top[1] : null);
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export const TRADE_REQUESTS_API = {
  requests: "/api/trade-requests/requests",
  counts: "/api/trade-requests/counts",
  export: "/api/trade-requests/export",
} as const;

/** Request headers carrying the queue search and cursor (URI-encoded), kept out of the URL. */
export const TRADE_REQUESTS_QUEUE_HEADERS = {
  search: "x-trade-requests-search",
  before: "x-trade-requests-before",
} as const;

// New Request covers new, edit and clone forms; Trading Queue covers the queue
// and any open request.
export function currentWorkspaceView(pathname: string): TradeRequestsView {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === TRADE_REQUESTS_ROUTES.home) return "home";
  if (path === TRADE_REQUESTS_ROUTES.newRequest || path.startsWith(`${TRADE_REQUESTS_ROUTES.newRequest}/`)) return "newRequest";
  if (path === TRADE_REQUESTS_ROUTES.drift) return "drift";
  if (path === TRADE_REQUESTS_ROUTES.roster) return "roster";
  return "tradingQueue";
}
