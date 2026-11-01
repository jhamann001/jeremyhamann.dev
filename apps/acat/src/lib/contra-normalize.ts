/**
 * Pure, dependency-free contra-name normalization.
 *
 * IMPORTANT: This module must NOT import `@/lib/prisma` (or anything
 * server-only). It is imported by the `"use client"` `ContraCombobox`
 * component as well as by the server-side `custodian-resolve` module, so it
 * has to be safe to bundle into client code.
 *
 * `normalizeContra` produces a comparison key: trimmed, internal whitespace
 * collapsed, casefolded. `ALIAS` maps a normalized key to the canonical
 * display name we want to snap variants onto.
 */

/**
 * Comparison-normalize a contra name: trim, drop periods (so "J.P." and
 * trailing "Inc." punctuation collapse onto their unpunctuated variants),
 * collapse internal runs of whitespace to a single space, and lowercase.
 * Returns "" for null/undefined. This is a comparison key only — never a
 * display value.
 */
export function normalizeContra(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .trim()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Known contra-name variants → canonical display name. Keys are already in
 * normalized form (see `normalizeContra`). Kept in sync with the resolver
 * (`custodian-resolve`) and the
 * cleanup script (`scripts/cleanup-custodian-dupes`).
 */
export const ALIAS: Record<string, string> = {
  etrade: "E*Trade",
  "j p morgan": "J.P. Morgan",
  "american enterprise investment services inc": "Ameriprise Financial Services",
  "sparrow advisors": "Sparrow Growth Funds",
  drivewealth: "DriveWealth",
};
