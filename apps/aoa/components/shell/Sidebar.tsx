"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { NAV_GROUPS, resolveNavItem } from "./nav-config";
import { useSidebarCounts, validNavCounts, validAcatCount } from "./useSidebarCounts";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import styles from "./Sidebar.module.css";

export function Sidebar({
  role,
  counts,
  scope = "",
  crmIdentityReads = false,
  crmRelationships = false,
  crmReporting = false,
  dataHealth = false,
  operationsTools = false,
  advisorList = false,
  assetMappingWorkspace = false,
  tradeRequestsWorkspace = false,
  assetTransferWorkspace = false,
  demo = false,
}: {
  role: string;
  counts?: Record<string, number>;
  scope?: string;
  crmIdentityReads?: boolean;
  crmRelationships?: boolean;
  crmReporting?: boolean;
  dataHealth?: boolean;
  operationsTools?: boolean;
  advisorList?: boolean;
  assetMappingWorkspace?: boolean;
  tradeRequestsWorkspace?: boolean;
  assetTransferWorkspace?: boolean;
  demo?: boolean;
}) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navigationId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMobileMenuOpen(false); }, [pathname]);
  const navigation = useSidebarCounts("/api/navigation/badges", scope, true, validNavCounts);
  const acat = useSidebarCounts("/api/navigation/acat-count", scope, canSeeUnlinkedAcats(role), validAcatCount);
  const liveCounts: Record<string, number> | undefined = navigation.value ? {
    "/households": navigation.value.households,
    "/client-portrait": navigation.value.clients,
    "/deals": navigation.value.openDeals,
    "/asset-transfer": navigation.value.activeTransfers,
    "/crm": navigation.value.crmOpenExceptions,
  } : counts;

  return (
    <aside className={styles.sidebar} onKeyDown={event => {
      if (event.key !== "Escape" || !mobileMenuOpen) return;
      event.preventDefault();
      setMobileMenuOpen(false);
      menuButton.current?.focus();
    }}>
      <div className={styles.brand} aria-label="Cedar Ridge Wealth — Always-On Advice">
        <div className={styles.logo} aria-hidden="true">
          <span className={styles.logoE}>c</span>
        </div>
        <div>
          <div className={styles.name}>
            cedarridge<span>.ai</span>
          </div>
          <div className={styles.tag}>ALWAYS-ON ADVICE</div>
        </div>
        <button
          ref={menuButton}
          type="button"
          className={styles.menuButton}
          aria-expanded={mobileMenuOpen}
          aria-controls={navigationId}
          onClick={() => setMobileMenuOpen(open => !open)}
        >
          {mobileMenuOpen ? "Close menu" : "Menu"}
        </button>
      </div>
      <nav id={navigationId} aria-label="Main navigation" className={`${styles.navigation} ${mobileMenuOpen ? styles.navigationOpen : ""}`.trim()}>
        {NAV_GROUPS.map((group) => {
          // Hide an item when it declares requiredRoles and the caller's role isn't listed.
          const items = group.items
            .map((item) => resolveNavItem(item, { assetMappingWorkspace, tradeRequestsWorkspace, assetTransferWorkspace, role }))
            .filter((item) => item !== null)
            .filter(
              (item) =>
                !item.requiredRoles ||
                item.requiredRoles.includes(role as (typeof item.requiredRoles)[number]),
            )
            .filter((item) => !item.requiresCrmIdentityReads || crmIdentityReads)
            .filter((item) => !item.requiresCrmRelationships || crmRelationships)
            .filter((item) => !item.requiresCrmReporting || crmReporting || (assetTransferWorkspace && item.shownByAssetTransferWorkspace))
            .filter((item) => !item.requiresOperationsTools || operationsTools)
            .filter((item) => !item.requiresAdvisorList || advisorList)
            .filter((item) => !item.requiresDemo || demo);
          const enabledItems = items.filter(
            (item) => !item.requiresDataHealth || dataHealth,
          );
          if (enabledItems.length === 0) return null; // drop an empty group (e.g. Admin for non-Ops/Admin)
          return (
            <div key={group.label}>
              <div className={styles.navLabel}>{group.label}</div>
              {enabledItems.map((item) => {
                const Icon = item.icon;
                // External items never match the current pathname (their href is
                // an absolute URL), so they're never the active route.
                const active = pathname === item.href || (assetTransferWorkspace && pathname.startsWith(`${item.href}/`));
                // ACAT count is fetched after paint (external tracker); the rest
                // come from the shell's local-DB counts.
                const count =
                  item.href === "/acat-tracking"
                    ? acat.value?.count
                    : liveCounts?.[item.href];
                const badgeState = item.href === "/acat-tracking" ? acat.status : navigation.status;
                const hasCount = ["/acat-tracking", "/households", "/client-portrait", "/deals", "/asset-transfer", "/crm"].includes(item.href);
                if (item.external) {
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.item}
                    >
                      <Icon />
                      <span className={styles.itemLabel}>{item.label}</span>
                      <span className={styles.num} aria-label="opens in a new tab">
                        ↗
                      </span>
                    </a>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    className={`${styles.item} ${active ? styles.active : ""}`.trim()}
                  >
                    <Icon />
                    <span className={styles.itemLabel}>{item.label}</span>
                    <span className={styles.num} title={count === undefined && hasCount
                      ? badgeState === "unavailable" ? "Count unavailable" : "Count loading" : undefined}>
                      {count ?? (hasCount ? badgeState === "unavailable" ? "!" : "…" : "·")}
                    </span>
                  </Link>
                );
              })}
            </div>
          );
        })}
        {navigation.status === "unavailable" || acat.status === "unavailable" ?
          <button type="button" className={styles.retryCounts} onClick={() => {
            if (navigation.status === "unavailable") navigation.retry();
            if (acat.status === "unavailable") acat.retry();
          }}>Retry unavailable counts</button> : null}
      </nav>
    </aside>
  );
}
