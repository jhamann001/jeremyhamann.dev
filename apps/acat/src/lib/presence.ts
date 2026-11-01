// Aligned with the 30-second heartbeat cadence so a single dropped tick does
// not flip an active teammate to offline.
export const ACTIVE_WINDOW_MS = 90 * 1000;

export type PresenceStatus = "active" | "offline";

export interface PresenceUser {
  email: string;
  name: string | null;
  role: "ADMIN" | "USER" | "ADVISOR";
  lastSeenAt: string | null;
  status: PresenceStatus;
}
