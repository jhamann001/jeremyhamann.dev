import "server-only";
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

/** Static codes only: provider bodies, URLs, tokens and exceptions must not escape. */
export class ProviderReadError extends Error {
  constructor(public readonly code: string) { super(code); }
}

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

/** Callers build fixed-origin, read-only API URLs; redirects are never followed. */
export async function readProviderJson(url: URL, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await serviceFetch(url, {
      ...init, cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderReadError(response.status === 401 || response.status === 403
        ? "provider_access_denied" : response.status === 404
          ? "provider_job_not_found" : "provider_unavailable");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > MAX_BYTES) {
      await response.body?.cancel();
      throw new ProviderReadError("provider_response_too_large");
    }
    if (!response.body) throw new ProviderReadError("provider_invalid_response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new ProviderReadError("provider_response_too_large");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    try { return JSON.parse(text) as unknown; }
    catch { throw new ProviderReadError("provider_invalid_response"); }
  } catch (error) {
    if (error instanceof ProviderReadError) throw error;
    throw new ProviderReadError(controller.signal.aborted ? "provider_timeout" : "provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function safeTimezone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80 || !/^[A-Za-z0-9_/+-]+$/.test(value)) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return value; }
  catch { return null; }
}

export function safeCron(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 160) return null;
  const numeric = value.replace(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)\b/gi, "0");
  return /^[0-9*?,/\- ]+$/.test(numeric) && value.trim().split(/\s+/).length >= 5
    && value.trim().split(/\s+/).length <= 6 ? value.trim() : null;
}

export function providerErrorCode(error: unknown): string {
  return error instanceof ProviderReadError ? error.code : "provider_unavailable";
}
