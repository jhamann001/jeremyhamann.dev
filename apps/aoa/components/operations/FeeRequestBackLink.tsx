"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getBrowserListNavigationMemory, type ListNavigationReturnTarget } from "@/lib/navigation/list-memory";
import { getHouseholdHistoryReturnTarget, prepareListHistoryReturn } from "@/lib/navigation/history-entry";

/**
 * Use only the remembered origin for this exact request and authorized scope.
 * Never call history.back(): a long history can still belong to another site.
 * Replace returns to the list without creating a detail/list Back-button loop.
 */
export function FeeRequestBackLink({
  scope,
  detailHref,
  fallback = "/operations/fee-requests",
  className,
  children = "← Back to requests",
}: {
  scope: string;
  detailHref?: string;
  fallback?: "/operations/fee-requests";
  className?: string;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const detail = detailHref ?? pathname;
  const safeFallback = fallback === "/operations/fee-requests" ? fallback : "/operations/fee-requests";
  const [origin, setOrigin] = useState<{ scope: string; detail: string; href: string } | null>(null);
  const boundOrigin = useRef<{ scope: string; detail: string; target: ListNavigationReturnTarget } | null>(null);
  const href = origin?.scope === scope && origin.detail === detail ? origin.href : safeFallback;

  const resolveOrigin = useCallback(() => {
    const memory = getBrowserListNavigationMemory();
    const latest = memory?.returnTarget(scope, detail) ?? null;
    // Internal detail-filter URL replacements may rebuild framework history
    // state while keeping this component mounted. Retain its already validated
    // origin, rather than rebinding to another visit's newer request mapping.
    const candidate = boundOrigin.current?.scope === scope && boundOrigin.current.detail === detail
      ? boundOrigin.current.target : latest;
    // Legacy/no-history callers still get their safe URL-only fallback. Token-
    // aware entries bind to the exact detail history occurrence, including when
    // the same household was later opened from another query.
    const target = candidate?.entryId === null ? candidate : getHouseholdHistoryReturnTarget(scope, detail, candidate);
    if (!target || !memory?.read(scope, target.href, target.entryId ?? undefined)) return null;
    boundOrigin.current = { scope, detail, target };
    return target;
  }, [scope, detail]);

  useLayoutEffect(() => {
    setOrigin({ scope, detail, href: resolveOrigin()?.href ?? safeFallback });
  }, [scope, detail, safeFallback, resolveOrigin]);

  return (
    <Link
      href={href}
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
