"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getBrowserListNavigationMemory, type ListNavigationReturnTarget } from "@/lib/navigation/list-memory";
import { getHouseholdHistoryReturnTarget, prepareListHistoryReturn } from "@/lib/navigation/history-entry";
import { safeListHref } from "@/lib/navigation/list-routes";

/**
 * Use only the remembered origin for this exact household and authorized scope.
 * Never call history.back(): a long history can still belong to another site.
 * Replace returns to the list without creating a detail/list Back-button loop.
 */
export function ListBackLink({
  scope,
  detailHref,
  canonicalHref,
  fallback = "/households",
  className,
  children = "‹ Back to results",
}: {
  scope: string;
  detailHref?: string;
  canonicalHref?: string;
  fallback: string;
  className?: string;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const detail = detailHref ?? pathname;
  const safeFallback = safeListHref(fallback) ?? "/households";
  const [origin, setOrigin] = useState<{ scope: string; detail: string; href: string } | null>(null);
  const boundOrigin = useRef<{ scope: string; detail: string; target: ListNavigationReturnTarget } | null>(null);
  const href = origin?.scope === scope && origin.detail === detail ? origin.href : safeFallback;

  const resolveOrigin = useCallback(() => {
    const memory = getBrowserListNavigationMemory();
    const latest = memory?.returnTarget(scope, detail) ?? null;
    // Internal detail-filter URL replacements may rebuild framework history
    // state while keeping this component mounted. Retain its already validated
    // origin, rather than rebinding to another visit's newer household mapping.
    const candidate = boundOrigin.current?.scope === scope && boundOrigin.current.detail === detail
      ? boundOrigin.current.target : latest;
    // Legacy/no-history callers still get their safe URL-only fallback. Token-
    // aware entries bind to the exact detail history occurrence, including when
    // the same household was later opened from another query.
    const historyDetail = canonicalHref && pathname === canonicalHref ? canonicalHref : detail;
    const target = candidate?.entryId === null ? candidate : getHouseholdHistoryReturnTarget(scope, historyDetail, candidate);
    if (!target || !memory?.read(scope, target.href, target.entryId ?? undefined)) return null;
    if (canonicalHref && canonicalHref !== detail) memory.rememberReturn(scope, canonicalHref, target.href, target.entryId ?? undefined);
    boundOrigin.current = { scope, detail, target };
    return target;
  }, [scope, detail, canonicalHref, pathname]);

  useLayoutEffect(() => {
    setOrigin({ scope, detail, href: resolveOrigin()?.href ?? safeFallback });
  }, [scope, detail, safeFallback, resolveOrigin]);

  return (
    <Link
      href={href}
      prefetch={false}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
          return;
        }
        // Recheck at click time; TTL expiry or a scope change invalidates origin.
        const remembered = resolveOrigin();
        if (remembered?.entryId) prepareListHistoryReturn(scope, remembered);
        event.preventDefault();
        router.replace(remembered?.href ?? safeFallback, { scroll: !remembered });
      }}
    >
      {children}
    </Link>
  );
}
