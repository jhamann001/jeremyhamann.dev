import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Client,
  TradeRequest,
  CreateTradeRequestPayload,
  UpdateStatusPayload,
  RunEnginePayload,
} from '@trade-request/shared';
import * as api from '../api/client';
import { extractApiError } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

export function useClients() {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientMap, setClientMap] = useState<Record<string, Client>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isDemo } = useAuth();

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    api
      .fetchClients(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setClients(data);
        const map: Record<string, Client> = {};
        for (const c of data) map[c.id] = c;
        setClientMap(map);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(extractApiError(err, 'Failed to load clients'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [isDemo]);

  return { clients, clientMap, loading, error };
}

export function useTradeRequests() {
  const [requests, setRequests] = useState<TradeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [computingId, setComputingId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [queueSearchInput, setQueueSearchInput] = useState('');
  const [queueSearch, setQueueSearch] = useState('');
  const refreshingRef = useRef(false);
  const paginatingRef = useRef(false);
  const hasDataRef = useRef(false);
  const { isDemo } = useAuth();

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const id = setTimeout(() => setQueueSearch(queueSearchInput), 300);
    return () => clearTimeout(id);
  }, [queueSearchInput]);

  const refresh = useCallback(async () => {
    if (refreshingRef.current || paginatingRef.current) return;
    refreshingRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!hasDataRef.current) setLoading(true);
    try {
      const q = queueSearch.trim() || undefined;
      const result = await api.fetchRequests(undefined, controller.signal, q);
      if (controller.signal.aborted || !mountedRef.current) return;
      setRequests((prev) => {
        if (
          prev.length === result.data.length &&
          prev.every((r, i) => r.id === result.data[i].id && r.updatedAt === result.data[i].updatedAt)
        ) {
          return prev;
        }
        return result.data;
      });
      setNextCursor(result.nextCursor);
      setError(null);
      hasDataRef.current = true;
    } catch (err: unknown) {
      if (controller.signal.aborted || !mountedRef.current) return;
      const msg = extractApiError(err, 'Failed to load requests');
      setError(msg);
    } finally {
      if (mountedRef.current) setLoading(false);
      refreshingRef.current = false;
    }
  }, [queueSearch, isDemo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const POLL_INTERVAL_MS = 30_000;
    const id = setInterval(() => {
      if (!refreshingRef.current && !document.hidden) {
        refresh();
      }
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (!document.hidden && !refreshingRef.current) refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || paginatingRef.current || refreshingRef.current) return;
    paginatingRef.current = true;
    setLoadingMore(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const q = queueSearch.trim() || undefined;
      const result = await api.fetchRequests(nextCursor, controller.signal, q);
      if (controller.signal.aborted || !mountedRef.current) return;
      setRequests((prev) => [...prev, ...result.data]);
      setNextCursor(result.nextCursor);
    } catch (err: unknown) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setError(extractApiError(err, 'Failed to load more requests'));
    } finally {
      setLoadingMore(false);
      paginatingRef.current = false;
    }
  }, [nextCursor, loadingMore, queueSearch]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      // The aborted fetch no longer counts as running, so a remount (React's development double-mount)
      // starts its own instead of skipping it and leaving the queue empty until the next poll.
      refreshingRef.current = false;
      paginatingRef.current = false;
    };
  }, []);

  const create = useCallback(async (payload: CreateTradeRequestPayload) => {
    const created = await api.createRequest(payload);
    if (mountedRef.current) setRequests((prev) => [created, ...prev]);
    return created;
  }, []);

  const update = useCallback(async (id: string, payload: CreateTradeRequestPayload) => {
    const updated = await api.updateRequest(id, payload);
    if (mountedRef.current) setRequests((prev) => prev.map((r) => (r.id === id ? updated : r)));
    return updated;
  }, []);

  const updateStatus = useCallback(async (id: string, payload: UpdateStatusPayload) => {
    const updated = await api.updateRequestStatus(id, payload);
    if (mountedRef.current) setRequests((prev) => prev.map((r) => (r.id === id ? updated : r)));
    return updated;
  }, []);

  const runEngineForRequest = useCallback(async (id: string, payload: RunEnginePayload) => {
    setComputingId(id);
    try {
      const updated = await api.runEngine(id, payload);
      if (mountedRef.current) setRequests((prev) => prev.map((r) => (r.id === id ? updated : r)));
      return updated;
    } finally {
      if (mountedRef.current) setComputingId(null);
    }
  }, []);

  return {
    requests,
    loading,
    error,
    computingId,
    create,
    update,
    updateStatus,
    runEngineForRequest,
    refresh,
    loadMore,
    loadingMore,
    hasMore: nextCursor != null && nextCursor !== '',
    queueSearchInput,
    setQueueSearchInput,
  };
}
