/**
 * Icon per Admin nav entry, shared by the sidebar's Admin section (md+) and the Account sheet's Admin
 * block (phones) so the same entry cannot wear two different icons on the two surfaces
 * (docs/MOBILE_FIRST.md §2: "one derivation, two surfaces").
 *
 * Typed as a total `Record` over `AdminNavItem["key"]` rather than a ternary: adding an admin page
 * without choosing an icon is a typecheck failure here, where it used to be a silent fallback to the
 * icon of whichever branch the ternary landed in.
 */
import type { LucideIcon } from "lucide-react";
import { BarChart3, ClipboardCheck, Flag, KeyRound, MailWarning, MailX, MessageSquareQuote, Send, Timer, Users, Webhook } from "lucide-react";
import type { AdminNavItem, OverflowNavItem } from "@/components/shell/nav-items";

export const ADMIN_NAV_ICONS: Readonly<Record<AdminNavItem["key"], LucideIcon>> = {
  macros: MessageSquareQuote,
  users: Users,
  intake: MailWarning,
  // --- Wave B ---
  sla: Timer,
  webhooks: Webhook,
  "api-tokens": KeyRound,
  suppression: MailX,
  flags: Flag,
};

/**
 * The same, for the two non-admin overflow entries the Account sheet shows above the Admin block
 * (`navOverflowFor`). They already have icons in the md+ sidebar — `BarChart3` and `ClipboardCheck` —
 * and this map is what stops the phone from picking different ones.
 */
export const OVERFLOW_NAV_ICONS: Readonly<Record<OverflowNavItem["key"], LucideIcon>> = {
  reports: BarChart3,
  reviews: ClipboardCheck,
  outbox: Send,
};
