// Client-safe global-search types + constants. This module MUST NOT import
// anything server-only (no @/lib/rls, no prisma) — it is imported by the
// GlobalSearch client component. The server seam (search.ts) re-exports these
// so `@/lib/data/search` stays the single import surface for server callers and
// tests, while the client imports directly from here to keep Prisma out of the
// browser bundle.

export type SearchResultType = "household" | "client" | "deal" | "transfer";

export type SearchResult = {
  type: SearchResultType;
  id: string; // route id: sf_id for household/client, PK for deal/transfer
  label: string; // primary display (record name)
  sublabel: string | null; // context line (household / stage), may be null
  href: string;
};

export const MIN_QUERY_LENGTH = 2;

export function hrefFor(type: SearchResultType, id: string): string {
  switch (type) {
    case "household":
      return `/households/${id}`;
    case "client":
      return `/client-portrait/${id}`;
    case "deal":
      return `/deals/${id}`;
    case "transfer":
      return `/asset-transfer/${id}`;
  }
}
