import type { ReactNode } from "react";
import styles from "./CollapsibleRow.module.css";

// Disclosure primitive for the Full Funding Picture hub (owner decision D8):
// ONE server-safe presentational component built on native <details>/<summary>
// — no "use client", no state, no dependency. Why native <details>:
//   • Collapsed-by-default with a client-side-only toggle and zero persistence
//     is exactly native <details> semantics — no state, no JS shipped.
//   • a11y: <summary> is natively focusable, toggles on Enter/Space, and
//     browsers expose the expanded/collapsed state to assistive tech without
//     any aria-expanded bookkeeping.
//   • Repo precedent: components/asset-mapping/KnownAccountsList.tsx.
//   • Server/client boundary: with no client boundary, Suspense-deferred
//     SERVER children (the ACAT expansion) pass straight through and stream
//     into the hidden content region — the children-serialization trap cannot
//     occur. If this ever needs client state, keep children-as-props (a client
//     CollapsibleRow rendering {children} keeps server children valid); NEVER
//     import a server component into a client file.

export function CollapsibleRow({
  label,
  summary,
  children,
}: {
  label: string;
  /** Collapsed-line content. STATIC ONLY — no links, no interactive controls
   *  (they toggle/navigate ambiguously inside <summary>), and never Suspense-
   *  deferred content (the summary must paint with the shell). */
  summary: ReactNode;
  /** Expanded content — may be a Suspense-wrapped async server component; it
   *  streams into the hidden content region and is revealed on toggle. */
  children: ReactNode;
}) {
  return (
    <details className={styles.row}>
      <summary className={styles.summary}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{summary}</span>
        <span className={styles.chevron} aria-hidden>
          ›
        </span>
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
