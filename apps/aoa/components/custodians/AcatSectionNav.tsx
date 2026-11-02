"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import type { AcatWorkspaceView } from "@/lib/data/acat-workspace-contract";
import styles from "./AcatSectionNav.module.css";

// URL-backed views share one role-gated workspace and sidebar destination.
export function AcatSectionNav({ current, onNavigate }: {
  current: AcatWorkspaceView; onNavigate?: (view: AcatWorkspaceView) => void;
}) {
  const click = (view: AcatWorkspaceView) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(view);
  };
  return <nav className={styles.nav} aria-label="ACAT workspace">
    <Link href="/acat-tracking?view=library" onClick={click("library")} prefetch={false} scroll={false} aria-current={current === "library" ? "page" : undefined}>
      Custodian Library
    </Link>
  </nav>;
}
