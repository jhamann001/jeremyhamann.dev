import type { EmailEnvelope, EmailEnvelopeCoverage, EmailParty } from "@/lib/email-search/envelope";
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { utcDateLabel } from "@/lib/display-date";
import { highlightSegments, snippetAround, EMAIL_SEARCH_MAX_LENGTH, EMAIL_SEARCH_MIN_LENGTH } from "@/lib/email-search/term";
import {
  createEmailSearchController, IDLE_EMAIL_SEARCH, type EmailSearchRow, type EmailSearchState,
} from "@/lib/email-search/controller";
import { Button } from "@/components/ui";
import styles from "./EmailCard.module.css";

// ticket content search UI. Matches render as React text nodes inside <mark>,
// never as markup, so stored email text and the term cannot inject HTML. The term
// stays in component state only: it is never written to the URL, history, or
// navigation storage, and the paged list's own state is left untouched.

export function Highlighted({ text, term }: { text: string | null; term: string | null }) {
  const segments = useMemo(() => highlightSegments(text, term), [text, term]);
  return <>{segments.map((segment, index) => segment.match
    ? <mark key={index} className={styles.match}>{segment.text}</mark>
    : <span key={index}>{segment.text}</span>)}</>;
}

/** What search can and cannot see. Shown with every result set, and spelled out when nothing matches. */
export function EmailSearchCoverage({ coverage, searched }: { coverage?: EmailEnvelopeCoverage | null; searched?: number } = {}) {
  return (
    <p className={styles.coverage} data-email-search-coverage="">
      Searches subjects and stored message text for emails logged on or after January 1, 2026.
      Stored text stops at the firm disclaimer or an Outlook reply divider and is capped at 8,000 characters;
      marketing emails are not stored. Sender and To/Cc names and addresses are searched where available.
      {coverage ? ` Sender/recipient details are available for ${coverage.enriched} of ${searched ?? 0} stored emails.` : null}
      {" "}Older emails and missing source names may have incomplete address coverage.
    </p>
  );
}

const ERROR_TEXT: Record<NonNullable<EmailSearchState["error"]>, string> = {
  invalid: "That search could not be run. Try different wording.",
  read_only: "Search is temporarily unavailable during maintenance.",
  unavailable: "Search is unavailable right now.",
};

export function EmailSearchResults({ state, onOpen, onLoadMore }: {
  state: EmailSearchState;
  onOpen: (row: EmailSearchRow) => void;
  onLoadMore: () => void;
}) {
  if (state.status === "idle") return null;
  if (state.status === "unavailable") {
    return <p className={styles.empty} role="status">These emails are no longer available to you.</p>;
  }
  if (state.status === "error") {
    return <p className={styles.empty} role="status">{ERROR_TEXT[state.error ?? "unavailable"]}</p>;
  }
  if (state.status === "loading") {
    return <p className={styles.empty} role="status" aria-live="polite">Searching stored emails…</p>;
  }
  return (
    <div data-email-search-results="">
      <p className={styles.searchSummary} role="status" aria-live="polite">
        {state.total === 0 ? "No stored email matches." :
          `${state.total} of ${state.searched} stored ${state.searched === 1 ? "email matches" : "emails match"}.`}
        {state.notice === "changed" ? " Results changed while you were reading; showing the latest matches." : null}
      </p>
      {state.total === 0 ? (
        <p className={styles.empty}>
          An email outside the coverage below can exist without appearing here.
        </p>
      ) : null}
      <EmailSearchCoverage coverage={state.metadataCoverage} searched={state.searched} />
      {state.rows.length ? (
        <ul className={styles.list}>
          {state.rows.map(row => (
            <li key={row.sf_id} className={styles.row} data-email-search-row={row.sf_id}>
              <button type="button" className={styles.rowBtn} onClick={() => onOpen(row)}>
                <span className={styles.head}>
                  <span className={styles.subject}><Highlighted text={row.subject ?? "(no subject)"} term={state.term} /></span>
                  {row.sent_at ? <span className={styles.date}>{utcDateLabel(row.sent_at)}</span> : null}
                </span>
                <EmailEnvelopeDetails envelope={row.email_envelope} term={state.term} />
                <span className={styles.snippet}>
                  <Highlighted text={snippetAround(row.body, state.term) || "—"} term={state.term} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {state.error ? <p className={styles.empty} role="status">{ERROR_TEXT[state.error]}</p> : null}
      {state.page < state.pageCount ? (
        <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={state.appending}>
          {state.appending ? "Loading…" : `Show more matches (${state.rows.length} of ${state.total})`}
        </Button>
      ) : null}
    </div>
  );
}

/** Debounced input → controller. Returns the visible input value and the search state. */
export function useEmailSearch(householdId: string, delayMs = 250) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<EmailSearchState>(IDLE_EMAIL_SEARCH);
  const controller = useMemo(() => createEmailSearchController({
    householdId, fetchImpl: (input, init) => fetch(input, init), onChange: setState,
  }), [householdId]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); controller.dispose(); }, [controller]);
  const schedule = (next: string, immediate = false) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    if (immediate) controller.search(next);
    else timer.current = setTimeout(() => controller.search(next), delayMs);
  };
  return {
    value, state,
    change: (next: string) => schedule(next),
    submit: () => schedule(value, true),
    clear: () => { if (timer.current) clearTimeout(timer.current); setValue(""); controller.clear(); },
    loadMore: () => controller.loadMore(),
    tooShort: value.trim().length > 0 && [...value.trim()].length < EMAIL_SEARCH_MIN_LENGTH,
  };
}

export function EmailSearchInput({ value, onChange, onSubmit, onClear, tooShort }: {
  value: string; onChange: (next: string) => void; onSubmit: () => void; onClear: () => void; tooShort: boolean;
}) {
  return (
    <div className={styles.searchBar}>
      <input
        type="search"
        className={styles.searchInput}
        value={value}
        maxLength={EMAIL_SEARCH_MAX_LENGTH}
        autoComplete="off"
        spellCheck={false}
        aria-label="Search email subjects, stored text, sender and recipients"
        placeholder="Search text, sender or recipients"
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); onSubmit(); }
          if (event.key === "Escape" && value) { event.preventDefault(); onClear(); }
        }}
      />
      {value ? <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button> : null}
      {tooShort ? <span className={styles.hint}>Type at least {EMAIL_SEARCH_MIN_LENGTH} characters.</span> : null}
    </div>
  );
}

function partyLabel(party: EmailParty): string {
  return party.name && party.address ? `${party.name} <${party.address}>` : party.name ?? party.address ?? "";
}

export function EmailEnvelopeDetails({ envelope, term = null, compact = true }: {
  envelope?: EmailEnvelope | null; term?: string | null; compact?: boolean;
}) {
  if (!envelope || envelope.state !== "MATCHED") return compact ? null : <p className={styles.empty}>Sender and recipient details are unavailable for this email.</p>;
  const groups: [string, EmailParty[]][] = [["From", envelope.sender ? [envelope.sender] : []], ["To", envelope.to], ["Cc", envelope.cc]];
  return <span className={styles.envelope}>{groups.filter(([, parties]) => parties.length).map(([label, parties]) => {
    const shown = compact ? parties.slice(0, 3) : parties;
    return <span key={label} className={styles.envelopeLine}><strong>{label}: </strong>
      <Highlighted text={shown.map(partyLabel).join("; ")} term={term} />
      {parties.length > shown.length ? ` +${parties.length - shown.length} more` : null}
    </span>;
  })}</span>;
}
