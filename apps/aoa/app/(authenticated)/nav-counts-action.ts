"use server";

import { auth } from "@/auth";
import { navCounts, type NavCounts } from "@/lib/data/nav-counts";

/**
 * Load sidebar badge counts after the authenticated shell has painted.
 *
 * This is deliberately fail-soft: badges are navigation metadata, not page
 * content. Authentication and the existing withUserScope RLS boundary remain
 * mandatory, while a database timeout returns null and leaves neutral dots in
 * the sidebar instead of turning every authenticated route into a 500.
 */
export async function getLiveNavCounts(): Promise<NavCounts | null> {
  const session = await auth();
  if (!session?.user) return null;

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;

  try {
    return await navCounts({ role, email });
  } catch {
    // PII-free operational marker. The database client already records the
    // underlying error; do not duplicate session identity in application logs.
    console.error("[nav-counts] unavailable");
    return null;
  }
}
