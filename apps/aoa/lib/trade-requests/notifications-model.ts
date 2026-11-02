// Shared by the bell's AOA routes and the browser. The service is the system of
// record for notifications (ruling D5); AOA only lists and marks them read.

export const BELL_LIST_LIMIT = 100;

export const BELL_COPY = {
  heading: "Trade Requests",
  markAllRead: "Mark all read",
  checking: "Checking Trade Request notifications…",
  unavailable: "Trade Request notifications could not be checked.",
  empty: "No notifications",
} as const;

export const BELL_API = {
  list: "/api/trade-requests/notifications",
  markRead: (id: string) => `/api/trade-requests/notifications/${encodeURIComponent(id)}/read`,
  markAllRead: "/api/trade-requests/notifications/read-all",
} as const;

export type BellNotification = { id: string; message: string; date: string; isRead: boolean };
export type BellNotificationList = { notifications: BellNotification[]; unreadCount: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isNotificationId = (value: string) => UUID.test(value);

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Accepts the service's (or AOA route's) list shape; anything else is a failed load. */
export function parseBellNotifications(value: unknown): BellNotificationList | null {
  if (!record(value)) return null;
  const rows = Array.isArray(value.data) ? value.data : Array.isArray(value.notifications) ? value.notifications : null;
  const unreadCount = value.unreadCount;
  if (!rows || typeof unreadCount !== "number" || !Number.isInteger(unreadCount) || unreadCount < 0) return null;
  const notifications: BellNotification[] = [];
  for (const row of rows.slice(0, BELL_LIST_LIMIT)) {
    if (
      !record(row) || typeof row.id !== "string" || typeof row.message !== "string"
      || typeof row.date !== "string" || Number.isNaN(Date.parse(row.date)) || typeof row.isRead !== "boolean"
    ) return null;
    notifications.push({ id: row.id, message: row.message, date: row.date, isRead: row.isRead });
  }
  return { notifications, unreadCount };
}

// Above the route's worst case (three 30 s attempts plus retry delays), so a
// hung connection ends as a failure instead of holding the refresh guard.
export const BELL_CLIENT_TIMEOUT_MS = 100_000;

// A signed-out request is redirected to sign-in by the middleware; that is a
// failure here, never a successful empty answer.
async function send(url: string, method: "GET" | "PATCH" | "POST"): Promise<{ ok?: unknown; data?: unknown } | null> {
  try {
    const response = await fetch(url, {
      method, cache: "no-store", credentials: "same-origin", redirect: "error", headers: { accept: "application/json" },
      signal: AbortSignal.timeout(BELL_CLIENT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as { ok?: unknown; data?: unknown } | null;
  } catch {
    return null;
  }
}

/** Browser side: the newest notifications for the signed-in person, or null when they could not be loaded. */
export async function fetchBellNotifications(): Promise<BellNotificationList | null> {
  const body = await send(BELL_API.list, "GET");
  return body?.ok === true ? parseBellNotifications(body.data) : null;
}

export async function postBellMarkRead(id: string): Promise<boolean> {
  return (await send(BELL_API.markRead(id), "PATCH"))?.ok === true;
}

export async function postBellMarkAllRead(): Promise<boolean> {
  return (await send(BELL_API.markAllRead, "POST"))?.ok === true;
}
