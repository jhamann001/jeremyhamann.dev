"use client";

import { useEffect } from "react";

/** The server already authorized and rendered the canonical identity. */
export function CanonicalCrmRoute({ canonicalId }: { canonicalId: string }) {
  useEffect(() => {
    const pathname = `/crm/${encodeURIComponent(canonicalId)}`;
    if (window.location.pathname === pathname) return;
    window.history.replaceState(window.history.state, "", `${pathname}${window.location.search}${window.location.hash}`);
  }, [canonicalId]);
  return null;
}
