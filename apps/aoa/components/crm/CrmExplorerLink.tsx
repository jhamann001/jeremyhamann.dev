"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * CRM Explorer destinations are database-heavy, RLS-scoped server pages.
 *
 * Next.js prefetches visible links by default. A populated Explorer can render
 * dozens of identity links at once, so default prefetching starts enough
 * interactive transactions to exhaust the bounded Cloud Run Prisma pool before
 * the user clicks anything. Keep navigation explicit: the destination loads on
 * click, never as speculative background work.
 */
export function CrmExplorerLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} prefetch={false} />;
}
