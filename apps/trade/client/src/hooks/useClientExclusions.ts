import { useState, useEffect, useCallback } from 'react';
import type { ClientExclusion } from '@trade-request/shared';
import * as api from '../api/client';
import {
  extractApiError,
  type ApplyClientExclusionsBatchPayload,
  type ApplyClientExclusionsBatchResult,
} from '../api/client';

interface UseClientExclusionsResult {
  exclusions: ClientExclusion[];
  loading: boolean;
  error: string | null;
  applyBatch: (payload: ApplyClientExclusionsBatchPayload) => Promise<ApplyClientExclusionsBatchResult>;
  refresh: () => Promise<void>;
}

/**
 * Fetches and mutates a single client's standing exclusion list. Pass
 * `null` for clientId to skip the fetch (e.g. when no client is selected
 * yet, or while the modal is between tab switches).
 *
 * The hook owns the SERVER-SIDE list. Per-tab staging (pending adds/
 * removes that the user is composing before clicking Apply) is owned by
 * the modal, NOT this hook — see plan §v3.3, which lifts pending state
 * to the modal so it survives tab switches in households.
 *
 * `applyBatch` is the only write surface. It POSTs the entire batch
 * atomically and replaces local `exclusions` with whatever the server
 * returned (server is source of truth). Callers handle clearing their
 * own pending state on success.
 */
export function useClientExclusions(clientId: string | null): UseClientExclusionsResult {
  const [exclusions, setExclusions] = useState<ClientExclusion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!clientId) {
        setExclusions([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await api.fetchClientExclusions(clientId, signal);
        if (signal?.aborted) return;
        setExclusions(list);
      } catch (err) {
        if (signal?.aborted) return;
        setError(extractApiError(err, 'Failed to load exclusions'));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch(controller.signal);
    return () => controller.abort();
  }, [fetch]);

  const applyBatch = useCallback(
    async (payload: ApplyClientExclusionsBatchPayload): Promise<ApplyClientExclusionsBatchResult> => {
      if (!clientId) throw new Error('No client selected');
      const result = await api.applyClientExclusionsBatch(clientId, payload);
      // Replace local state with the authoritative post-commit list. Skipping
      // optimistic merging keeps the hook simpler and matches the all-or-nothing
      // server semantic: either everything in the batch landed or none of it
      // did, and we never want a partial local state.
      setExclusions(result.exclusions);
      return result;
    },
    [clientId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await fetch();
  }, [fetch]);

  return { exclusions, loading, error, applyBatch, refresh };
}
