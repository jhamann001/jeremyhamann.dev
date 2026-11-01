"use client";

import { usePresenceHeartbeat } from "@/hooks/use-presence";

/**
 * Mounts the presence heartbeat globally. Renders nothing; exists so the
 * heartbeat lives at the layout level instead of inside NavRail (which is
 * only present on a subset of pages — anyone on /admin or /mcp/connections
 * would otherwise never write a heartbeat and would silently drop off the
 * team list).
 */
export default function PresenceTracker() {
  usePresenceHeartbeat();
  return null;
}
