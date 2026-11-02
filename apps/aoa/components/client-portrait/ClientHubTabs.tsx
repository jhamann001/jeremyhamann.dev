"use client";

import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { resolvePortraitTab, portraitTabHref, replacePortraitTab } from "@/lib/navigation/portrait-tabs";
import styles from "./ClientHubTabs.module.css";

const TABS = [
  { id: "financial", slug: "", label: "Core Financial" },
  { id: "comms", slug: "", label: "Portrait" },
  { id: "contact", slug: "contact", label: "Contact" },
  { id: "dual-view", slug: "dual-view", label: "Dual-View" },
  { id: "reminders", slug: "reminders", label: "Reminders" },
] as const;

// Portrait and Core Financial share already rendered content on the index.
// Keep real links for deep links/new tabs, but switch those panes with native
// history while on the index so no blocking client data read is introduced.
export function ClientHubTabs({ showContact = false }: { showContact?: boolean } = {}) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const search = useSearchParams();
  // A retired identity can replace only the visible pathname after the server
  // renders its survivor. Follow that pathname even if useParams still holds
  // the originally requested identity until the next full route navigation.
  const base = pathname.match(/^\/client-portrait\/[^/]+/)?.[0]
    ?? `/client-portrait/${encodeURIComponent(id)}`;
  const financialActive = resolvePortraitTab(search.get("portraitTab")) === "financial";
  const formRoute = pathname === `${base}/forms` || pathname.startsWith(`${base}/forms/`);

  return (
    <nav className={styles.bar} aria-label="Client hub">
      {TABS.filter(tab => tab.id !== "contact" || showContact).map(({ id: tabId, slug, label }) => {
        const route = slug ? `${base}/${slug}` : base;
        const href = portraitTabHref(route, search, slug ? null : tabId);
        const active = slug
          ? pathname === route || pathname.startsWith(`${route}/`)
          : tabId === "financial"
            ? (pathname === base && financialActive) || formRoute
            : pathname === base && !financialActive;
        return (
          <Link
            key={label}
            href={href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={`${styles.tab} ${active ? styles.active : ""}`.trim()}
            onClick={event => {
              if (slug || pathname !== base || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
              event.preventDefault();
              replacePortraitTab(tabId);
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
