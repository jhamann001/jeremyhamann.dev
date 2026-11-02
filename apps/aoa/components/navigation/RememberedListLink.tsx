"use client";

import Link from "next/link";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { getBrowserListNavigationMemory } from "@/lib/navigation/list-memory";
import { prepareListHistoryReturn } from "@/lib/navigation/history-entry";
import { safeListHref } from "@/lib/navigation/list-routes";

/** A view switch copies metadata into a NEW occurrence, preserving older Back entries. */
export function RememberedListLink({ scope, href, match, children, active }: {
  scope: string; href: string; match: Record<string, string>; children: ReactNode; active?: boolean;
}) {
  const safe = safeListHref(href) ?? "/households";
  const pathname = safe.split("?")[0];
  const matchKey = JSON.stringify(match);
  const [target, setTarget] = useState(safe);
  useLayoutEffect(() => {
    const criteria = JSON.parse(matchKey) as Record<string, string>;
    setTarget(getBrowserListNavigationMemory()?.latest(scope, pathname, criteria)?.href ?? safe);
  }, [scope, pathname, safe, matchKey]);
  return <Link href={target} prefetch={false} aria-current={active ? "page" : undefined}
    style={{ padding: "5px 12px", fontWeight: active ? 600 : 400 }}
    onClick={event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const memory = getBrowserListNavigationMemory();
      const entry = memory?.latest(scope, pathname, JSON.parse(matchKey) as Record<string, string>);
      if (!entry || entry.href !== target) return;
      const entryId = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
      if (memory?.save(scope, entry.href, entry, entryId)) prepareListHistoryReturn(scope, { href: entry.href, entryId });
    }}>{children}</Link>;
}
