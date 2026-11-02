// Browser fetch layer for the security reconciliation section (ticket).
// Client-safe. Every call has a timeout; a thrown error, an abort, a body that
// is not JSON (an expired session redirects to sign-in HTML), or an unexpected
// shape becomes one retryable failure, so the section never shows a half-read
// grid.

import {
  RECON_ACCOUNTS_FAILURE,
  RECON_UNAVAILABLE,
  parseAccountsEnvelope,
  parseReconEnvelope,
  type ReconAccountsResult,
  type ReconActionBody,
  type ReconResult,
} from "@/lib/data/acat-security-recon-contract";

export const RECON_READ_TIMEOUT_MS = 15_000;
export const RECON_ACCOUNTS_TIMEOUT_MS = 20_000;
export const RECON_POST_TIMEOUT_MS = 60_000;

const base = (recordId: string) => `/api/acat-security-recon/${encodeURIComponent(recordId)}`;

async function send(
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: init.body,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

const UNAVAILABLE: ReconResult = { ok: false, refused: false, reason: RECON_UNAVAILABLE, retryable: true };

export async function fetchRecon(recordId: string, signal?: AbortSignal): Promise<ReconResult> {
  try {
    const { status, body } = await send(base(recordId), { method: "GET" }, RECON_READ_TIMEOUT_MS, signal);
    return parseReconEnvelope(status, body);
  } catch {
    return UNAVAILABLE;
  }
}

export async function postRecon(recordId: string, body: ReconActionBody): Promise<ReconResult> {
  try {
    const res = await send(base(recordId), { method: "POST", body: JSON.stringify(body) }, RECON_POST_TIMEOUT_MS);
    return parseReconEnvelope(res.status, res.body);
  } catch {
    return UNAVAILABLE;
  }
}

export async function fetchReconAccounts(recordId: string, query: string): Promise<ReconAccountsResult> {
  try {
    const url = `${base(recordId)}/accounts?${new URLSearchParams({ q: query })}`;
    const { status, body } = await send(url, { method: "GET" }, RECON_ACCOUNTS_TIMEOUT_MS);
    return parseAccountsEnvelope(status, body);
  } catch {
    return { ok: false, reason: RECON_ACCOUNTS_FAILURE, retryable: true };
  }
}
