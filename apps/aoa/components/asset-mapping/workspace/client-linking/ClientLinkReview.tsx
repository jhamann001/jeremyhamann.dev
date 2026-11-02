import { Button } from "@/components/ui";
import {
  MAX_LINK_PEOPLE,
  MAX_LINK_REASON,
  MIN_DIRECTORY_QUERY,
  type ClientLinkCandidate,
  type ClientLinkPerson,
  type ClientLinkSearchResult,
  type RunClientLink,
} from "@/lib/data/asset-map-client-link-contract";
import {
  CLIENT_LINK_COPY,
  folderDiffers,
  holderConflicts,
  isUnlinking,
  lookupNotice,
  suggestionView,
  type DraftAction,
  type FailureView,
  type LinkDraftState,
} from "./client-link-model";
import { ClientLinkErrorNotice, DirectoryNotice } from "./ClientLinkNotices";
import styles from "./ClientLinking.module.css";

export type DirectorySearchState = {
  query: string;
  result: ClientLinkSearchResult | null;
  searching: boolean;
  failure: FailureView | null;
};

export type ClientLinkReviewProps = {
  run: RunClientLink;
  draft: LinkDraftState;
  directory: DirectorySearchState;
  busy: boolean;
  onDraft: (action: DraftAction) => void;
  onQuery: (query: string) => void;
  onPreview: () => void;
  onClose: () => void;
};

type Option = ClientLinkPerson & { eligible: boolean; evidence: string[] };

function candidates(run: RunClientLink, draft: LinkDraftState, directory: DirectorySearchState): Option[] {
  const found: ClientLinkCandidate[] = directory.query.trim().length >= MIN_DIRECTORY_QUERY
    ? (directory.result?.candidates ?? [])
    : (run.lookup.suggestion?.candidates ?? []);
  const byId = new Map<string, Option>();
  for (const p of [...draft.people, ...run.identity.people]) byId.set(p.user_id, { ...p, eligible: true, evidence: [] });
  for (const c of found) {
    if (!byId.has(c.user_id)) byId.set(c.user_id, { user_id: c.user_id, display_name: c.display_name, eligible: c.eligible, evidence: c.evidence });
  }
  return [...byId.values()];
}

export function ClientLinkReview({ run, draft, directory, busy, onDraft, onQuery, onPreview, onClose }: ClientLinkReviewProps) {
  const unlinking = isUnlinking(run, draft);
  const selectedIds = new Set(draft.people.map((p) => p.user_id));
  const atLimit = draft.people.length >= MAX_LINK_PEOPLE;
  const canPreview = !busy && (unlinking || (draft.people.length > 0 && draft.coverage != null));
  const suggestion = suggestionView(run.lookup);
  const conflicts = holderConflicts(run);
  const folder = folderDiffers(run) ? run.folder : null;

  return (
    <section className={styles.card} aria-label={run.identity.people.length ? CLIENT_LINK_COPY.manageTitle : CLIENT_LINK_COPY.reviewTitle}>
      <div className={styles.cardHead}>
        <h3>{run.identity.people.length ? CLIENT_LINK_COPY.manageTitle : CLIENT_LINK_COPY.reviewTitle}</h3>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>{CLIENT_LINK_COPY.close}</Button>
      </div>
      <div className={styles.muted}>
        Account holders: {run.holder_evidence.length ? run.holder_evidence.join("; ") : "No holder evidence recorded"}
      </div>
      {conflicts ? (
        <div className={`${styles.notice} ${styles.warn}`}>
          <strong>{CLIENT_LINK_COPY.holderConflict}</strong>
          <ul>{conflicts.map((flag) => <li key={flag}>{flag}</li>)}</ul>
        </div>
      ) : null}
      {folder ? (
        <div className={styles.notice}>
          <strong>{CLIENT_LINK_COPY.folderDiffers}</strong>
          <p>{folder.decision.people.map((p) => p.display_name).join(" + ")}</p>
          <Button size="sm" variant="ghost" onClick={() => onDraft({ type: "usePeople", folder: folder.decision })}>
            {CLIENT_LINK_COPY.usePeople}
          </Button>
        </div>
      ) : null}
      {suggestion ? (
        <div className={styles.muted}>
          <strong>{suggestion.title}</strong>
          {suggestion.evidence.map((e) => <p key={e}>{e}</p>)}
        </div>
      ) : null}
      <label className={styles.field}>
        {CLIENT_LINK_COPY.findClient}
        <input
          className={styles.search}
          placeholder={CLIENT_LINK_COPY.searchPlaceholder}
          autoComplete="off"
          value={directory.query}
          maxLength={200}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <ClientLinkErrorNotice failure={directory.failure} />
      {directory.searching ? <p className={styles.muted} aria-busy="true">Searching the client directory…</p> : null}
      <div className={styles.people}>
        {candidates(run, draft, directory).map((person) => {
          const checked = selectedIds.has(person.user_id);
          return (
            <label key={person.user_id} className={styles.choice}>
              <input
                type="checkbox"
                aria-label={`Select ${person.display_name}, ${person.user_id}`}
                checked={checked}
                disabled={busy || (!checked && (atLimit || !person.eligible))}
                onChange={() => onDraft({ type: "togglePerson", person })}
              />
              <span>
                <strong>{person.display_name}</strong> <code>{person.user_id}</code>
                {person.evidence.map((e) => <small key={e}> {e}</small>)}
              </span>
            </label>
          );
        })}
      </div>
      <DirectoryNotice
        notice={lookupNotice(directory.result
          ? { state: directory.result.lookup_state, suggestion: null, directory: directory.result.directory, error_code: null, message: directory.result.message }
          : run.lookup)}
      />
      <label className={styles.field}>
        {CLIENT_LINK_COPY.primary}
        <select
          value={draft.primary ?? ""}
          disabled={busy || draft.people.length === 0}
          onChange={(e) => onDraft({ type: "setPrimary", userId: e.target.value || null })}
        >
          <option value="">{CLIENT_LINK_COPY.noPrimary}</option>
          {draft.people.map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name}</option>)}
        </select>
      </label>
      <fieldset className={styles.fieldset} disabled={busy || unlinking}>
        <legend>{CLIENT_LINK_COPY.coverageLegend}</legend>
        <label className={styles.choice}>
          <input type="radio" name="client-link-coverage" checked={draft.coverage === "complete"} onChange={() => onDraft({ type: "setCoverage", coverage: "complete" })} />
          {CLIENT_LINK_COPY.coverageComplete}
        </label>
        <label className={styles.choice}>
          <input type="radio" name="client-link-coverage" checked={draft.coverage === "partial"} onChange={() => onDraft({ type: "setCoverage", coverage: "partial" })} />
          {CLIENT_LINK_COPY.coveragePartial}
        </label>
      </fieldset>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend>{CLIENT_LINK_COPY.scopeLegend}</legend>
        <label className={styles.choice}>
          <input type="radio" name="client-link-scope" checked={draft.scope === "this_run"} onChange={() => onDraft({ type: "setScope", scope: "this_run" })} />
          {CLIENT_LINK_COPY.scopeThisRun}
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name="client-link-scope"
            checked={draft.scope === "all_existing"}
            disabled={run.source_scope == null}
            onChange={() => onDraft({ type: "setScope", scope: "all_existing" })}
          />
          {CLIENT_LINK_COPY.scopeAllExisting}
        </label>
      </fieldset>
      <label className={styles.choice}>
        <input
          type="checkbox"
          checked={!unlinking && draft.reuse}
          disabled={busy || run.source_scope == null || unlinking}
          onChange={(e) => onDraft({ type: "setReuse", reuse: e.target.checked })}
        />
        {CLIENT_LINK_COPY.reuse}
      </label>
      <label className={styles.field}>
        {CLIENT_LINK_COPY.note}
        <textarea
          rows={2}
          value={draft.note}
          maxLength={MAX_LINK_REASON}
          placeholder={CLIENT_LINK_COPY.notePlaceholder}
          disabled={busy}
          onChange={(e) => onDraft({ type: "setNote", note: e.target.value })}
        />
      </label>
      <div className={styles.footer}>
        <span />
        <Button size="sm" disabled={!canPreview} onClick={onPreview}>
          {unlinking ? CLIENT_LINK_COPY.previewRemoval : CLIENT_LINK_COPY.previewChanges}
        </Button>
      </div>
    </section>
  );
}
