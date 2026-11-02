"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import styles from "./TransferOwnerFilter.module.css";

// Owner filter pills for the transfer board: click Operations or Client Service
// to narrow the lanes to that owner_kind ("which ones are theirs"), or All to
// clear. The FILTER itself is applied server-side (the page reads ?owner and
// filters the rows); these pills just drive the URL param. The pill values must
// stay in sync with the page's allowed set (OPERATIONS / CLIENT_SERVICE — the
// two execution owners; ADVISOR-owned show only under All). Navigational
// (Link-driven), so the active pill carries aria-current, not aria-pressed —
// the deals/tasks filter strips use aria-pressed because those are click-handler
// buttons, not links.

const OWNERS = [
  { href: "/asset-transfer", value: null, label: "All" },
  { href: "/asset-transfer?owner=OPERATIONS", value: "OPERATIONS", label: "Operations" },
  { href: "/asset-transfer?owner=CLIENT_SERVICE", value: "CLIENT_SERVICE", label: "Client Service" },
] as const;

export function TransferOwnerFilter() {
  // Next can hand back a string[] for a repeated param; only a single exact
  // match lights a pill (mirrors the server's whitelist), else All is active.
  const raw = useSearchParams().get("owner");
  const active = raw === "OPERATIONS" || raw === "CLIENT_SERVICE" ? raw : null;
  return (
    <div className={styles.wrap} role="group" aria-label="Filter transfers by owner">
      <span className={styles.label}>Owner</span>
      {OWNERS.map((o) => {
        const isActive = active === o.value;
        return (
          <Link
            key={o.label}
            href={o.href}
            aria-current={isActive ? "page" : undefined}
            className={isActive ? `${styles.pill} ${styles.active}` : styles.pill}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}
