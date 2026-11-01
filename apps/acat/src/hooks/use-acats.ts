"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import { AcatRecord } from "@/lib/types";

export const POLL_INTERVAL_MS = 30 * 1000;

export interface UseAcatsOptions {
  pollIntervalMs?: number;
  includeDeleted?: boolean;
}

export interface UseAcatsResult {
  acats: AcatRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches the ACAT list with SWR. Preserves the original public API shape and
 * both call styles (numeric poll-interval overload + options object) so
 * existing callers and tests keep working unchanged.
 *
 * Cross-user freshness is delivered by the global SWRConfig defaults
 * (revalidateOnFocus, revalidateOnReconnect) plus the `refreshInterval` passed
 * here. Writes elsewhere in the app can also call SWR's `mutate(key)` against
 * the same URL to trigger an immediate refresh for the acting user.
 */
export function useAcats(
  optionsOrPollMs: UseAcatsOptions | number = {}
): UseAcatsResult {
  const options: UseAcatsOptions =
    typeof optionsOrPollMs === "number"
      ? { pollIntervalMs: optionsOrPollMs }
      : optionsOrPollMs;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const includeDeleted = options.includeDeleted === true;

  const key = includeDeleted ? "/api/acats?includeDeleted=true" : "/api/acats";

  const { data, error, isLoading, mutate } = useSWR<AcatRecord[]>(key, {
    refreshInterval: pollIntervalMs,
  });

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const acats = useMemo(() => data ?? [], [data]);
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : null;

  return {
    acats,
    loading: isLoading,
    error: errorMessage,
    refresh,
  };
}
