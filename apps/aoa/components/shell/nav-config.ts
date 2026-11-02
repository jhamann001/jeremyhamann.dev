import type { ComponentType, SVGProps } from "react";
import type { Role } from "@prisma/client";
import {
  IconCommandCenter,
  IconHouseholds,
  IconClientPortrait,
  IconAssetTransfer,
  IconAcat,
  IconAssetMapping,
  IconTradeRequests,
  IconDeals,
  IconTasks,
  IconAuditLog,
  IconRelationships,
  IconReporting,
  IconOutbox,
} from "@/components/icons";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import { canViewAssetMapping } from "@/lib/data/asset-map-review-authz";
import { canUseTradeRequestsWorkspace } from "@/lib/trade-requests/access";

export type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  requiredRoles?: Role[];
  // CRM explorer stays absent until the default-off identity-read flag is
  // explicitly enabled in the deployed environment.
  requiresCrmIdentityReads?: boolean;
  requiresCrmRelationships?: boolean;
  requiresCrmReporting?: boolean;
  // Shown without CRM reporting while ASSET_TRANSFER_WORKSPACE is on, for its mailing report.
  shownByAssetTransferWorkspace?: boolean;
  requiresDataHealth?: boolean;
  requiresOperationsTools?: boolean;
  // Client Transfers (ticket) stays absent until both advisor-list flags are on.
  requiresAdvisorList?: boolean;
  // The public demo's Outbox (lib/demo/outbox.ts): present only in the demo, for every role.
  requiresDemo?: boolean;
  // When true, the item links OUT to a standalone app (opens a new tab) rather
  // than routing internally — see components/shell/Sidebar.tsx (ticket).
  external?: boolean;
  // In-app address that replaces `href` while the epic release
  // epic-aoa-asset-mapping-workspace is on (ticket); see resolveNavItem.
  inAppHref?: string;
  // Set when a release other than the asset-mapping one moves this entry to
  // inAppHref; see resolveNavItem.
  inAppRelease?: "tradeRequestsWorkspace";
};
export type NavGroup = { label: string; items: NavItem[] };

// Visibility matrix (enforced server-side in Sidebar.tsx):
//   Firm / Operations / Workflow  → visible to ALL authenticated roles (no requiredRoles).
//   Admin → CRM Explorer/Audit Log → ADMIN + OPERATIONS only (requiredRoles below).
// Kept intentionally minimal: only the sensitive Admin group is gated; per-screen
// role narrowing within the other groups is deferred to the phase that builds each
// real screen (B–E), where there is actual behavior to gate.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Firm",
    items: [
      { label: "Command Center", href: "/command-center", icon: IconCommandCenter },
      { label: "Households", href: "/households", icon: IconHouseholds },
      { label: "Client Portrait", href: "/client-portrait", icon: IconClientPortrait },
      {
        label: "Relationships",
        href: "/relationships",
        icon: IconRelationships,
        requiredRoles: ["ADMIN", "OPERATIONS"],
        requiresCrmRelationships: true,
      },
      { label: "Asset Transfer", href: "/asset-transfer", icon: IconAssetTransfer },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        label: "Operations Tools",
        href: "/operations",
        icon: IconAuditLog,
        requiredRoles: ["ADMIN", "OPERATIONS"],
        requiresOperationsTools: true,
      },
      // In-app ACAT Tracking page (transfer-centric step 2) — the home for
      // un-linked/residual tracker ACATs now that the board is transfer-centric.
      // Firm-wide ACATs have no per-book scope, so this is gated to ADMIN/
      // OPERATIONS (matches the page's canSeeUnlinkedAcats gate). The full
      // standalone tracker is still reachable via the "Open full tracker ↗" link
      // on the page itself (EXTERNAL_APPS.acatTracking).
      { label: "ACAT Tracking", href: "/acat-tracking", icon: IconAcat, requiredRoles: ["ADMIN", "OPERATIONS"] },
      // ticket: the tracker's redacted advisor list. Visible while both flags are
      // on; the page itself asks the tracker whether this person is an advisor or
      // admin and returns 404 for everyone else.
      { label: "Client Transfers", href: "/client-transfers", icon: IconAcat, requiresAdvisorList: true },
      { label: "Asset Mapping", href: EXTERNAL_APPS.assetMapping, icon: IconAssetMapping, external: true, inAppHref: "/asset-mapping" },
      { label: "Trade Requests", href: EXTERNAL_APPS.tradeRequests, icon: IconTradeRequests, external: true, inAppHref: "/trade-requests", inAppRelease: "tradeRequestsWorkspace" },
      { label: "Deals", href: "/deals", icon: IconDeals },
    ],
  },
  {
    label: "Workflow",
    items: [
      { label: "Tasks", href: "/tasks", icon: IconTasks },
      // ticket: Smart Nudges navigation is temporarily hidden; its route remains available.
    ],
  },
  {
    label: "Intelligence",
    items: [
      {
        label: "Reporting",
        href: "/reporting",
        icon: IconReporting,
        requiredRoles: ["ADMIN", "OPERATIONS"],
        requiresCrmReporting: true,
        shownByAssetTransferWorkspace: true,
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        label: "CRM Explorer",
        href: "/crm",
        icon: IconRelationships,
        requiredRoles: ["ADMIN", "OPERATIONS"],
        requiresCrmIdentityReads: true,
      },
      // Admin-only; enforced in Sidebar by requiredRoles (see matrix above).
      {
        label: "Data Health",
        href: "/data-health",
        icon: IconAuditLog,
        requiredRoles: ["ADMIN", "OPERATIONS"],
        requiresDataHealth: true,
      },
      { label: "Audit Log", href: "/audit-log", icon: IconAuditLog, requiredRoles: ["ADMIN", "OPERATIONS"] },
      { label: "Outbox", href: "/outbox", icon: IconOutbox, requiresDemo: true },
    ],
  },
];

// The in-app address admits the asset-mapping view roles (Admin, Operations,
// Advisor, Client Service; app/(authenticated)/asset-mapping/page.tsx). Viewer has
// no asset-mapping screen and no entry, in either release state (ticket).
// Trade Requests: while its release is off the entry is today's external link
// for every role; while on, only ADMIN, OPERATIONS and ADVISOR get it, in-app.
export function resolveNavItem(
  item: NavItem,
  { assetMappingWorkspace, tradeRequestsWorkspace = false, assetTransferWorkspace = false, role }: {
    assetMappingWorkspace: boolean; tradeRequestsWorkspace?: boolean; assetTransferWorkspace?: boolean; role: string;
  },
): NavItem | null {
  // Mailing keeps its existing authenticated access; each report retains its own server gate.
  if (item.href === "/reporting" && assetTransferWorkspace) return { ...item, requiredRoles: undefined };
  if (!item.inAppHref) return item;
  if (item.inAppRelease === "tradeRequestsWorkspace") {
    if (!tradeRequestsWorkspace) return item;
    if (!canUseTradeRequestsWorkspace(role)) return null;
    return { ...item, href: item.inAppHref, external: false };
  }
  if (!canViewAssetMapping(role)) return null;
  if (!assetMappingWorkspace) return item;
  return { ...item, href: item.inAppHref, external: false };
}
