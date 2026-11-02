"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { WorkspaceView } from "@/lib/navigation/transfer-query";
import { getBrowserListNavigationMemory } from "@/lib/navigation/list-memory";
import { detailHref } from "./view-helpers";

/** AC-3: remember the view and its filters so the detail page's back link returns to them. */
export function WorkspaceRecordLink({ scope, listHref, transferId, from, className, ariaLabel, children }: {
  scope: string; listHref: string; transferId: string; from: WorkspaceView; className?: string; ariaLabel?: string; children: ReactNode;
}) {
  const href = detailHref(transferId, from);
  return (
    <Link href={href} prefetch={false} className={className} aria-label={ariaLabel} data-list-row-id={transferId}
      onClick={() => {
        const memory = getBrowserListNavigationMemory();
        if (!memory) return;
        const position = { firstPage: 1, lastPage: 1, anchorId: transferId, anchorOffset: 0, scrollTop: Math.max(0, Math.round(window.scrollY)) };
        if (!memory.save(scope, listHref, position)) return;
        memory.rememberReturn(scope, `/asset-transfer/${transferId}`, listHref);
        memory.rememberReturn(scope, href, listHref);
      }}>
      {children}
    </Link>
  );
}
