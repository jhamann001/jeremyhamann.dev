import { createHash } from "node:crypto";

/** Stable object-key order; arrays retain order because record order is reviewed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("NON_CANONICAL_VALUE");
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeKey(value: string | null): string {
  return (value ?? "").trim().toUpperCase();
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
