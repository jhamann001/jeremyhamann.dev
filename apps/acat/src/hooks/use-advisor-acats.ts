"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import type { AdvisorAcatRecord } from "@/lib/advisor-redaction";

// ticket: Advisor mirror of `useAcats`, intentionally separate so:
//  1. The wire shape is `AdvisorAcatRecord` (already redacted on the
//     server). The UI never imports the full AcatRecord type and so
//     can't accidentally render PII even if a future change leaks it.
//  2. The cache key is unique to the advisor surface; toggling an
//     ADMIN user between /advisor and /records can't poison the other
//     view's cache.

export const ADVISOR_POLL_INTERVAL_MS = 60 * 1000;

export interface UseAdvisorAcatsResult {
  acats: AdvisorAcatRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAdvisorAcats(): UseAdvisorAcatsResult {
  const { data, error, isLoading, mutate } = useSWR<AdvisorAcatRecord[]>(
    "/api/advisor/acats",
    { refreshInterval: ADVISOR_POLL_INTERVAL_MS }
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const acats = useMemo(() => data ?? [], [data]);
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : null;

  return { acats, loading: isLoading, error: errorMessage, refresh };
}
