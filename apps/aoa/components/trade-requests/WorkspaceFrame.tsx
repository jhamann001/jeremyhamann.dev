"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import { TRADE_REQUESTS_ROUTES, currentWorkspaceView, type TradeRequestsView } from "@/lib/trade-requests/routes";
import type { WorkspaceSections } from "@/lib/trade-requests/workspace-sections";
import { NewRequestDraftProvider } from "./form/NewRequestDraft";
import { TradeRequestsQueueProvider } from "./queue/QueueProvider";
import styles from "./WorkspaceFrame.module.css";

const LINKS: Array<{ view: TradeRequestsView; label: string }> = [
  { view: "home", label: TRADE_REQUESTS_COPY.home },
  { view: "newRequest", label: TRADE_REQUESTS_COPY.newRequest },
  { view: "tradingQueue", label: TRADE_REQUESTS_COPY.tradingQueue },
];

// Client boundary for the workspace: state that must survive switching between
// its views (queue pages, the New Request draft) belongs here. `sections` adds
// the Drift and Roster pills (ticket); their pages re-check on every request.
export function WorkspaceFrame({ children, sections }: { children: React.ReactNode; sections?: WorkspaceSections }) {
  const current = currentWorkspaceView(usePathname() ?? TRADE_REQUESTS_ROUTES.home);
  const links = [
    ...LINKS,
    ...(sections?.drift ? [{ view: "drift" as const, label: TRADE_REQUESTS_COPY.drift }] : []),
    ...(sections?.roster ? [{ view: "roster" as const, label: TRADE_REQUESTS_COPY.roster }] : []),
  ];
  // At phone width the pill bar scrolls sideways; bring the current pill into view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (links.length === LINKS.length) return;
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const bar = nav.getBoundingClientRect();
    const pill = active.getBoundingClientRect();
    if (pill.left < bar.left || pill.right > bar.right) nav.scrollLeft += pill.left - bar.left - (bar.width - pill.width) / 2;
  }, [current, links.length]);
  return (
    <div className={styles.frame}>
      <nav ref={navRef} className={styles.nav} aria-label={TRADE_REQUESTS_COPY.workspaceNavLabel}>
        {links.map(({ view, label }) => (
          <Link key={view} href={TRADE_REQUESTS_ROUTES[view]} prefetch={false}
            aria-current={current === view ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
      <TradeRequestsQueueProvider>
        <NewRequestDraftProvider>{children}</NewRequestDraftProvider>
      </TradeRequestsQueueProvider>
    </div>
  );
}
