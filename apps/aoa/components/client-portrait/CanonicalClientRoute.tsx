"use client";

import { useEffect } from "react";

/** Preserve retired contact links while replacing the visible URL with the
 * human-selected Client Portrait survivor after the canonical data renders. */
export function CanonicalClientRoute({ canonicalId }: { canonicalId: string }) {
  useEffect(() => {
    const canonicalPath = `/client-portrait/${encodeURIComponent(canonicalId)}`;
    if (window.location.pathname === canonicalPath) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${canonicalPath}${window.location.search}${window.location.hash}`,
    );
  }, [canonicalId]);
  return null;
}
