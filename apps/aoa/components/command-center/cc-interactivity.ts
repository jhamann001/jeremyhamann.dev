import type { PillTone } from "@/components/ui";
import type { SignalRole } from "@/lib/mock/command-center";

// Pure helpers for the Command Center P2 interactivity (ticket). Kept free
// of React/DOM so they are unit-testable (test/cc-interactivity.test.ts),
// mirroring the status-tone.ts / format.ts pattern.

// Mockup `sigRoleColor` (index.html:3702): Advisor=green, Client Service=blue
// (abbreviated "CS" on the pill), Operations=amber, All=gray.
const ROLE_BADGE: Record<SignalRole, { tone: PillTone; label: string }> = {
  Advisor: { tone: "green", label: "Advisor" },
  "Client Service": { tone: "blue", label: "CS" },
  Operations: { tone: "amber", label: "Operations" },
  All: { tone: "gray", label: "All" },
};

/** Role-tinted badge spec for a signal row; unknown roles fall back gray. */
export function signalRoleBadge(role: SignalRole | string): {
  tone: PillTone;
  label: string;
} {
  return ROLE_BADGE[role as SignalRole] ?? { tone: "gray", label: String(role) };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-07-09" → "Jul 9" (mockup fmtDue, :2781). Empty/invalid → "". */
export function fmtSnoozeDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "";
  return `${month} ${Number(m[3])}`;
}

/** ISO date `days` ahead of `from` (mockup default: +7 days, :3677). */
export function defaultSnoozeDate(from: Date, days = 7): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** A snooze date must parse and not be in the past (both ISO yyyy-mm-dd). */
export function isValidSnoozeDate(iso: string, todayIso: string): boolean {
  return fmtSnoozeDate(iso) !== "" && iso >= todayIso;
}
