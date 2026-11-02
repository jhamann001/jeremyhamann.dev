"use server";

import { auth } from "@/auth";
import { globalSearch, type SearchResult } from "@/lib/data/search";

// Global-search server action — the app's data-to-client idiom (see
// loadReviewClients in asset-mapping-review/actions.ts). Identity ALWAYS from
// auth(), NEVER the client. One RLS-scoped seam call. Fails closed to [] on no
// session or any error (never throws to the client, never leaks a stack).
export async function globalSearchAction(
  query: string,
): Promise<SearchResult[]> {
  const session = await auth();
  if (!session?.user) return [];
  const identity = {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
  try {
    return await globalSearch(identity, query);
  } catch (err) {
    // Server-side only (never reaches the client); log the real error for
    // observability while still failing closed to [].
    console.error("[global-search] query_failed", err);
    return [];
  }
}
