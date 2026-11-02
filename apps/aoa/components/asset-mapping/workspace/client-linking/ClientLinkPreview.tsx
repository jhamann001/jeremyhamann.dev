import { useState } from "react";
import { Button, Pill } from "@/components/ui";
import type {
  ClientLinkBatchResult,
  ClientLinkIdentity,
  ClientLinkPreview as Preview,
} from "@/lib/data/asset-map-client-link-contract";
import {
  CLIENT_LINK_COPY,
  afterStateBadge,
  batchLine,
  clientLinkDate,
  directoryQueriedLine,
  folderChangeViews,
  isPreviewExpired,
  previewRunLabel,
  reviewStateTone,
  type FailureView,
} from "./client-link-model";
import { ClientLinkErrorNotice } from "./ClientLinkNotices";
import styles from "./ClientLinking.module.css";

function names(identity: ClientLinkIdentity | null | undefined): string {
  const people = identity?.people ?? [];
  return people.length ? people.map((p) => p.display_name).join(" + ") : "Unlinked";
}

function PreviewDetails({ preview }: { preview: Preview }) {
  const folders = folderChangeViews(preview);
  return (
    <>
      <div className={styles.targets}>
        {preview.targets.map((t) => {
          const after = afterStateBadge(t);
          return (
            <div key={t.run_id} className={styles.target}>
              <strong>{t.client_name}</strong> <code>{t.run_id}</code>
              <div>
                <span data-run-label="">{previewRunLabel(t)}</span>{" "}
                {after ? <Pill tone={reviewStateTone(after)}>{after}</Pill> : null}
              </div>
              <div>Before: {names(t.before)}</div>
              <div>After: {names(t.after)}</div>
            </div>
          );
        })}
      </div>
      {folders.length > 0 ? (
        <section className={styles.targets} aria-label={CLIENT_LINK_COPY.savedFolder}>
          <h4>{CLIENT_LINK_COPY.savedFolder}</h4>
          <p className={styles.muted}>{CLIENT_LINK_COPY.savedFolderDetail}</p>
          {folders.map((f) => (
            <div key={f.key} className={styles.target} data-folder-change="">
              <code>{f.folderId}</code>
              <div>Saved before: {f.before.people} · Future reuse: {f.before.reuse}</div>
              <div>Saved after: {f.after.people} · Future reuse: {f.after.reuse}</div>
            </div>
          ))}
        </section>
      ) : null}
      <p className={styles.muted} data-directory-queried="">{directoryQueriedLine(preview)}</p>
      {preview.exclusions.length > 0 ? (
        <div className={`${styles.notice} ${styles.warn}`}>
          <ul>
            {preview.exclusions.map((x, i) => (
              <li key={i}>{x.run_id ?? x.scope_key ?? ""}: {x.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export type ClientLinkPreviewProps = {
  preview: Preview;
  now: number;
  uncertain: boolean;
  failure: FailureView | null;
  applying: boolean;
  onApply: () => void;
  onRefresh: () => void;
  onClose: () => void;
};

export function ClientLinkPreview({ preview, now, uncertain, failure, applying, onApply, onRefresh, onClose }: ClientLinkPreviewProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const expired = isPreviewExpired(preview, now);
  const blocked = failure?.stale === true || (expired && !uncertain);
  const revert = preview.kind === "revert";
  return (
    <section className={styles.card} aria-label={revert ? CLIENT_LINK_COPY.reviewReversal : CLIENT_LINK_COPY.reviewChanges}>
      <div className={styles.cardHead}>
        <h3>{revert ? CLIENT_LINK_COPY.reviewReversal : CLIENT_LINK_COPY.reviewChanges}</h3>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={applying}>{CLIENT_LINK_COPY.close}</Button>
      </div>
      <ClientLinkErrorNotice failure={failure} />
      {uncertain ? <div className={`${styles.notice} ${styles.warn}`}>{CLIENT_LINK_COPY.uncertainApply}</div> : null}
      {expired && !uncertain ? <div className={`${styles.notice} ${styles.warn}`}>{CLIENT_LINK_COPY.previewExpired}</div> : null}
      <PreviewDetails preview={preview} />
      <label className={styles.choice}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={applying || blocked}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        {preview.acknowledgement}
      </label>
      <div className={styles.footer}>
        <span className={styles.muted}>
          {uncertain ? CLIENT_LINK_COPY.retrySameKey : `Preview expires ${clientLinkDate(preview.expires_at)}`}
        </span>
        {blocked ? (
          <Button size="sm" variant="ghost" onClick={onRefresh}>{CLIENT_LINK_COPY.refreshAndReview}</Button>
        ) : (
          <Button size="sm" disabled={!acknowledged || applying} onClick={onApply}>
            {uncertain ? CLIENT_LINK_COPY.retrySameApply : revert ? CLIENT_LINK_COPY.applyReversal : CLIENT_LINK_COPY.applyChanges}
          </Button>
        )}
      </div>
    </section>
  );
}

export function BatchPanel({
  batch,
  busy,
  onReviewReversal,
  onClose,
}: {
  batch: ClientLinkBatchResult;
  busy: boolean;
  onReviewReversal: (batchId: string) => void;
  onClose: () => void;
}) {
  return (
    <section className={styles.card} aria-label={CLIENT_LINK_COPY.batchTitle}>
      <div className={styles.cardHead}>
        <h3>{CLIENT_LINK_COPY.batchTitle}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>{CLIENT_LINK_COPY.close}</Button>
      </div>
      <p className={styles.muted}>{batchLine(batch)}</p>
      {batch.preview ? <PreviewDetails preview={batch.preview} /> : null}
      <div className={styles.footer}>
        <span className={styles.muted}>Applied {clientLinkDate(batch.applied_at)}{batch.actor ? ` by ${batch.actor}` : ""}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReviewReversal(batch.batch_id)}>
          {CLIENT_LINK_COPY.reviewReversal}
        </Button>
      </div>
    </section>
  );
}

export function ResultNotice({
  result,
  busy,
  onReviewReversal,
}: {
  result: ClientLinkBatchResult;
  busy: boolean;
  onReviewReversal: (batchId: string) => void;
}) {
  return (
    <div role="status" className={`${styles.notice} ${styles.footer}`}>
      <div>
        <strong>{result.kind === "revert" ? CLIENT_LINK_COPY.resultReversal : CLIENT_LINK_COPY.resultUpdated}</strong>
        <p>{batchLine(result)}</p>
      </div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReviewReversal(result.batch_id)}>
        {CLIENT_LINK_COPY.reviewReversal}
      </Button>
    </div>
  );
}
