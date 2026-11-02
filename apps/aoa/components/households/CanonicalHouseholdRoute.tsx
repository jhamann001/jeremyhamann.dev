"use client";

import { useEffect } from "react";

/**
 * Keep a retired household URL usable while replacing it with the selected
 * canonical route after hydration. The server has already rendered the
 * canonical household data, so a native history replacement avoids a second
 * request and the transient App Router render failure caused by redirecting
 * from the streamed server component.
 */
export function CanonicalHouseholdRoute({ canonicalId }: { canonicalId: string }) {
  useEffect(() => {
    const canonicalPath = `/households/${encodeURIComponent(canonicalId)}`;
    if (window.location.pathname === canonicalPath) return;

    window.history.replaceState(
      window.history.state,
      "",
      `${canonicalPath}${window.location.search}${window.location.hash}`,
    );
  }, [canonicalId]);

  return null;
}
