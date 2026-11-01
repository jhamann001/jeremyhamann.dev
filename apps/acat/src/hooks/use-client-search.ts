"use client";

import { useEffect, useState } from "react";
import {
  CLIENT_SEARCH_MAX_LENGTH,
  CLIENT_SEARCH_MAX_RESULTS,
  CLIENT_SEARCH_MIN_LENGTH,
  ClientSearchResponse,
} from "@/lib/client-identity-contract";

export const CLIENT_SEARCH_DEBOUNCE_MS = 250;

interface SearchState {
  query: string;
  loading: boolean;
  data: ClientSearchResponse | null;
  error: string | null;
}

/** Search terms stay in the request body and never become a URL/cache key. */
export function useClientSearch(query: string, enabled = true) {
  const term = query.trim();
  const valid = enabled && term.length >= CLIENT_SEARCH_MIN_LENGTH && term.length <= CLIENT_SEARCH_MAX_LENGTH;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SearchState>({ query: "", loading: false, data: null, error: null });

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(async () => {
      setState({ query: term, loading: true, data: null, error: null });
      try {
        const response = await fetch("/api/clients/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ query: term, limit: CLIENT_SEARCH_MAX_RESULTS }),
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Client search is unavailable. Try again.");
        if (!Array.isArray(body.items) || !body.directory) throw new Error("Client search is unavailable. Try again.");
        if (current) setState({ query: term, loading: false, data: body, error: null });
      } catch (error) {
        if (current) setState({ query: term, loading: false, data: null, error: error instanceof Error ? error.message : "Client search is unavailable. Try again." });
      }
    }, CLIENT_SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, valid, attempt]);

  const matches = valid && state.query === term;
  return {
    items: matches ? state.data?.items ?? [] : [],
    hasMore: matches && state.data?.hasMore === true,
    directory: matches ? state.data?.directory ?? null : null,
    loading: valid && (!matches || state.loading),
    error: matches ? state.error : null,
    retry: () => setAttempt((value) => value + 1),
  };
}
