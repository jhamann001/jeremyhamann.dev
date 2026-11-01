"use client";

import useSWR from "swr";
import { ClientDirectoryStatus } from "@/lib/client-identity-contract";
import { jsonFetcher } from "@/lib/fetcher";

async function fetchStatus(url: string): Promise<ClientDirectoryStatus> {
  const result = await jsonFetcher<ClientDirectoryStatus>(url);
  if (typeof result?.enabled !== "boolean" || typeof result?.writeEligible !== "boolean") {
    throw new Error("Client directory status is unavailable.");
  }
  return result;
}

export function useClientIdentityStatus() {
  const { data, error, isLoading, mutate } = useSWR<ClientDirectoryStatus>(
    "/api/clients/status",
    fetchStatus,
    { refreshInterval: 30_000, dedupingInterval: 5_000, shouldRetryOnError: false }
  );
  return {
    status: data ?? null,
    loading: isLoading,
    error: error ? "Client directory status is unavailable. Try again." : null,
    refresh: () => mutate(),
  };
}
