import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { ClientLinkPerson } from "@/lib/data/asset-map-client-link-contract";
import { CLIENT_LINK_COPY, type FailureView, type LookupNotice } from "./client-link-model";
import styles from "./ClientLinking.module.css";

const COPIED_MS = 2000;

export function ClientLinkErrorNotice({ failure, onRetry }: { failure: FailureView | null; onRetry?: () => void }) {
  if (!failure) return null;
  return (
    <div role="alert" className={`${styles.notice} ${styles.error}`} data-tone="danger">
      <div>
        <strong>{failure.title}</strong>
        {failure.message ? <p>{failure.message}</p> : null}
        {failure.stale ? <p>{CLIENT_LINK_COPY.staleDetail}</p> : null}
      </div>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry}>{CLIENT_LINK_COPY.tryAgain}</Button>
      ) : null}
    </div>
  );
}

export function DirectoryNotice({ notice }: { notice: LookupNotice | null }) {
  if (!notice) return null;
  return (
    <div className={`${styles.notice} ${styles.warn}`} data-tone="caution">
      <strong>{notice.title}</strong>
      <p>{notice.body}</p>
    </div>
  );
}

export function HolderConflictNotice({ flags }: { flags: string[] }) {
  return (
    <div className={`${styles.notice} ${styles.conflict}`} data-tone="danger">
      <strong>{CLIENT_LINK_COPY.holderConflict}</strong>
      <ul>{flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
    </div>
  );
}

export function WritesDisabledNotice({ text }: { text: string }) {
  return <div role="status" className={styles.notice} data-tone="neutral">{text}</div>;
}

export function PersonId({ person }: { person: ClientLinkPerson }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    navigator.clipboard.writeText(person.user_id).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => setCopied(false),
    );
  };
  return (
    <span className={styles.personId}>
      <span className={styles.muted}>Cedar Ridge ID</span>
      <code>{person.user_id}</code>
      <Button size="sm" variant="ghost" aria-label={`Copy Cedar Ridge ID for ${person.display_name}`} onClick={copy}>
        {copied ? CLIENT_LINK_COPY.copied : CLIENT_LINK_COPY.copy}
      </Button>
    </span>
  );
}
