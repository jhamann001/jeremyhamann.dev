"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { HouseholdEmail } from "@/lib/data/types";
import type { HouseholdHistoryPage } from "@/lib/data/household-history";
import { utcDateLabel } from "@/lib/display-date";
import { householdHistoryLocation } from "@/lib/navigation/household-history-query";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import { Card, CardHeader, CardBody, Button } from "@/components/ui";
import { EmailSearchInput, EmailSearchResults, EmailEnvelopeDetails, Highlighted, useEmailSearch } from "./EmailSearch";
import type { EmailSearchRow } from "@/lib/email-search/controller";
import styles from "./EmailCard.module.css";

// Records live only in the mounted paged card. Only the open row ID and scroll
// metadata survive navigation; email bodies are always freshly authorized.
const EMPTY_META = { openCount: 0, completedCount: 0 };

const SNIPPET_LEN = 120;

// First ~120 chars of the body with whitespace collapsed and an ellipsis when
// truncated. Empty body → em-dash placeholder.
function snippet(body: string | null): string {
  const clean = (body ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "—";
  return clean.length > SNIPPET_LEN ? `${clean.slice(0, SNIPPET_LEN)}…` : clean;
}

// Minimal slide-over for reading one full email. Same overlay shape as the
// households ReportPanel, but no PreviewBadge (this is real data) and no engine
// footer. Parent-controlled open state; closes on backdrop click or Escape.
function EmailModal({
  email,
  term = null,
  onClose,
}: {
  email: HouseholdEmail | EmailSearchRow;
  term?: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = email.subject ?? "(no subject)";
  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <aside
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.panelHead}>
          <div className={styles.panelHeadText}>
            <h2 className={styles.panelTitle}><Highlighted text={title} term={term} /></h2>
            {email.sent_at ? (
              <span className={styles.panelDate}>{utcDateLabel(email.sent_at)}</span>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className={styles.panelBody}>
          <EmailEnvelopeDetails envelope={email.email_envelope} term={term} compact={false} />
          {email.body ? (
            <p className={styles.fullBody}><Highlighted text={email.body} term={term} /></p>
          ) : (
            <p className={styles.empty}>No message body on file.</p>
          )}
        </div>
        <footer className={styles.panelFoot}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </footer>
      </aside>
    </div>
  );
}

export function EmailCard({ initialPage, householdId, scope }: {
  initialPage: HouseholdHistoryPage<"email">; householdId: string; scope: string;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { href, historyHref } = householdHistoryLocation(pathname, search.toString(), "email");
  const state = useProgressiveList({ initialPage, scope, href, historyHref,
    endpoint: `/api/navigation/household-email?${new URLSearchParams({ household: householdId })}`,
    rowIdKey: "sf_id", emptyMeta: EMPTY_META, scrollSelector: "[data-history-scroll='email']" });
  const active = state.page.rows.find(email => email.sf_id === state.expandedIds[0]) ?? null;
  // ticket content search. Separate state: the paged list, its expanded row and
  // its scroll position are untouched while searching and restored afterwards.
  const emailSearch = useEmailSearch(householdId);
  const searching = emailSearch.state.status !== "idle";
  const [openSearchId, setOpenSearchId] = useState<string | null>(null);
  const openSearchRow = searching ? emailSearch.state.rows.find(row => row.sf_id === openSearchId) ?? null : null;
  // A hidden element reads scrollTop as 0, so the list's position is tracked while
  // it is visible and written back as soon as it is shown again (before paint).
  const listScroll = useRef(0);
  const wasSearching = useRef(false);
  useLayoutEffect(() => {
    if (wasSearching.current && !searching) {
      const box = state.rootRef.current?.querySelector<HTMLElement>("[data-history-scroll='email']");
      if (box) box.scrollTop = listScroll.current;
    }
    wasSearching.current = searching;
  }, [searching, state.rootRef]);
  useEffect(() => { if (!searching) setOpenSearchId(null); }, [searching]);

  return (
    <div ref={state.rootRef} data-history-list="email" data-list-ready={state.ready}>
    <Card>
      <CardHeader>
        <h2>Recent email</h2>
        {state.page.total > 0 ? (
          <span className={styles.count}>
            {state.page.total} {state.page.total === 1 ? "email" : "emails"}
          </span>
        ) : null}
      </CardHeader>
      <CardBody>
        {state.page.total > 0 || searching ? (
          <EmailSearchInput value={emailSearch.value} onChange={emailSearch.change} onSubmit={emailSearch.submit}
            onClear={emailSearch.clear} tooShort={emailSearch.tooShort} />
        ) : null}
        <EmailSearchResults state={emailSearch.state} onOpen={row => setOpenSearchId(row.sf_id)} onLoadMore={emailSearch.loadMore} />
        <div hidden={searching} data-email-list-hidden={searching ? "" : undefined}>
        {state.loadState === "idle" && state.page.total === 0 ? (
          <p className={styles.empty}>No email on file.</p>
        ) : null}
          <div className={styles.scroll} data-history-scroll="email"
            onScroll={event => { if (!searching) listScroll.current = event.currentTarget.scrollTop; }}>
            <ul className={styles.list}>
              {state.page.rows.map((email) => (
                <li key={email.sf_id} className={styles.row} data-list-row-id={email.sf_id}>
                  <button
                    type="button"
                    className={styles.rowBtn}
                    onClick={() => state.setExpandedIds([email.sf_id])}
                  >
                    <span className={styles.head}>
                      <span className={styles.subject}>
                        {email.subject ?? "(no subject)"}
                      </span>
                      {email.sent_at ? (
                        <span className={styles.date}>{utcDateLabel(email.sent_at)}</span>
                      ) : null}
                    </span>
                    <EmailEnvelopeDetails envelope={email.email_envelope} />
                    <span className={styles.snippet}>{snippet(email.body)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <ProgressiveListControls state={state} label="Emails" href={href} />
          </div>
        </div>
      </CardBody>

      {active && !searching ? <EmailModal email={active} onClose={() => state.setExpandedIds([])} /> : null}
      {openSearchRow ? <EmailModal email={openSearchRow} term={emailSearch.state.term} onClose={() => setOpenSearchId(null)} /> : null}
    </Card>
    </div>
  );
}
