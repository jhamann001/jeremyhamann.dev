import { useState, useEffect, useCallback } from 'react';
import type { AccountExclusion } from '../api/client';
import * as api from '../api/client';
import {
  extractApiError,
  type ApplyAccountExclusionsBatchPayload,
  type ApplyAccountExclusionsBatchResult,
} from '../api/client';

interface UseAccountExclusionsResult {
  exclusions: AccountExclusion[];
  loading: boolean;
  error: string | null;
  applyBatch: (payload: ApplyAccountExclusionsBatchPayload) => Promise<ApplyAccountExclusionsBatchResult>;
  refresh: () => Promise<void>;
}

export function useAccountExclusions(accountId: string | null): UseAccountExclusionsResult {
  const [exclusions, setExclusions] = useState<AccountExclusion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!accountId) {
        setExclusions([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await api.fetchAccountExclusions(accountId, signal);
        if (signal?.aborted) return;
        setExclusions(list);
      } catch (err) {
        if (signal?.aborted) return;
        setError(extractApiError(err, 'Failed to load account exclusions'));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch(controller.signal);
    return () => controller.abort();
  }, [fetch]);

  const applyBatch = useCallback(
    async (payload: ApplyAccountExclusionsBatchPayload): Promise<ApplyAccountExclusionsBatchResult> => {
      if (!accountId) throw new Error('No account selected');
      const result = await api.applyAccountExclusionsBatch(accountId, payload);
      setExclusions(result.exclusions);
      return result;
    },
    [accountId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await fetch();
  }, [fetch]);

  return { exclusions, loading, error, applyBatch, refresh };
}
