import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, AlertCircle, Loader2, Plus, RotateCcw, CheckCircle } from 'lucide-react';
import type { ClientExclusion, ClientExclusionKind } from '@trade-request/shared';
import { useClientExclusions } from '../hooks/useClientExclusions';
import { useAccountExclusions } from '../hooks/useAccountExclusions';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { extractApiError } from '../api/client';
import { formatRestrictionReason } from '../utils/formatExclusions';

export interface ModalClient {
  id: string;
  name: string;
}

export interface ModalAccount {
  id: string;
  accountNumber: string;
  clientName: string;
}

type ModalScope = 'client' | 'account';

interface Props {
  /** Client mode (default): manages per-client standing exclusions. */
  clients?: ModalClient[];
  /** Account mode: manages per-account standing exclusions. */
  accounts?: ModalAccount[];
  mode?: ModalScope;
  /**
   * One or more clients. With 1 client, the modal renders without a tab
   * strip. With 2+, a tab strip appears at the top and each tab owns its
   * own staged batch (see plan §v3.3).
   */
  /** Always fires when the user closes the modal. */
  onClose: () => void;
  /**
   * Optional. Fires exactly once during `onClose` iff at least one Apply
   * succeeded during this modal session — across ANY tab. Parents use this
   * to re-sync any state derived from the standing list (e.g. AdvisorForm
   * auto-fills the exclusion textareas with the always-overwrite rule).
   */
  onSavedChanges?: () => void;
}

const KIND_LABELS: Record<ClientExclusionKind, string> = {
  advisor: 'Advisor Specific Exclusions',
  client: 'Client Requested Exclusions',
};

const KIND_PLACEHOLDERS: Record<ClientExclusionKind, string> = {
  advisor: 'TSLA',
  client: 'AAPL',
};

const KIND_REASON_PLACEHOLDERS: Record<ClientExclusionKind, string> = {
  advisor: 'Concentration risk',
  client: 'Employer stock',
};

function formatAddedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

// Local-only staged add. tempId is a UUID purely for React keys; it never
// travels to the server. ticker/reason/noBuy/noSell are editable until the
// user clicks Apply.
//
// v3.4 — new rows start with noBuy=false, noSell=false per the user
// decision to force an explicit side choice (no silent blanket defaults).
// Apply stays disabled until each staged row has at least one of the two.
interface StagedAdd {
  tempId: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  noBuy: boolean;
  noSell: boolean;
}

// v3.4 — flag-only inline edit on an already-saved row. Stored only when
// the user has toggled the row's checkbox to something different from the
// saved value. Toggling back to the saved value REMOVES the entry from
// pendingEdits (a no-op edit shouldn't count toward the pending badge).
interface PendingEdit {
  noBuy: boolean;
  noSell: boolean;
}

type ExclusionLike = Pick<
  ClientExclusion,
  'id' | 'ticker' | 'kind' | 'reason' | 'noBuy' | 'noSell' | 'createdByName' | 'createdAt'
>;

interface BatchPayload {
  add: Array<{ ticker: string; kind: ClientExclusionKind; reason: string; noBuy: boolean; noSell: boolean }>;
  remove: string[];
  edit: Array<{ id: string; noBuy: boolean; noSell: boolean }>;
}

interface ClientPending {
  adds: StagedAdd[];
  // Saved-row ids the user has marked for removal. Toggle (click trash) flips
  // membership. Cleared on successful Apply.
  removeIds: Set<string>;
  // Keyed by the saved row's id. See PendingEdit comment above.
  edits: Record<string, PendingEdit>;
}

const EMPTY_PENDING: ClientPending = { adds: [], removeIds: new Set(), edits: {} };

function pendingCount(p: ClientPending | undefined): number {
  if (!p) return 0;
  return p.adds.length + p.removeIds.size + Object.keys(p.edits).length;
}

// Render the DNB/DNS abbreviation pair. Server-side `formatSide` in
// `services/slack.ts` + `routes/exclusions.ts` must stay in sync — they
// produce the strings the trader sees in Slack + bell notifications.
function formatSide(noBuy: boolean, noSell: boolean): string {
  if (noBuy && noSell) return 'DNB+DNS';
  if (noBuy) return 'DNB';
  if (noSell) return 'DNS';
  return ''; // unreachable after Apply (validation gates it); rendered as warning while staging
}

export function ManageExclusionsModal({ clients, accounts, mode = 'client', onClose, onSavedChanges }: Props) {
  const scope: ModalScope = mode;
  const entities = useMemo(
    () =>
      scope === 'account'
        ? (accounts ?? []).map((a) => ({
            id: a.id,
            label: a.clientName ? `${a.accountNumber} — ${a.clientName}` : a.accountNumber,
            shortLabel: a.accountNumber,
          }))
        : (clients ?? []).map((c) => ({ id: c.id, label: c.name, shortLabel: c.name })),
    [scope, accounts, clients],
  );

  // Tab selection. The hook re-runs whenever activeEntityId changes, so
  // switching tabs refetches from the server for that entity.
  const [activeEntityId, setActiveEntityId] = useState<string>(entities[0]?.id ?? '');

  // Per-tab pending state. Lifted OUT of the hook so it persists across
  // tab switches (the hook unmounts/re-keys on activeEntityId change).
  // Keyed by entity id.
  const [pendingByClient, setPendingByClient] = useState<Record<string, ClientPending>>({});

  // Last successful Apply summary — drives the inline "Saved" toast. Cleared
  // when the user stages new changes or switches tabs.
  const [lastSaved, setLastSaved] = useState<{ added: number; removed: number; edited: number } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!entities.find((e) => e.id === activeEntityId) && entities[0]) {
      setActiveEntityId(entities[0].id);
    }
  }, [entities, activeEntityId]);

  const activeEntity = entities.find((e) => e.id === activeEntityId) ?? entities[0];
  const clientData = useClientExclusions(scope === 'client' ? (activeEntity?.id ?? null) : null);
  const accountData = useAccountExclusions(scope === 'account' ? (activeEntity?.id ?? null) : null);
  const activeData = (scope === 'client' ? clientData : accountData) as {
    exclusions: ExclusionLike[];
    loading: boolean;
    error: string | null;
    applyBatch: (
      payload: BatchPayload,
    ) => Promise<{ exclusions: ExclusionLike[]; added: number; removed: number; edited: number }>;
  };
  const { exclusions, loading, error, applyBatch } = activeData;
  const activePending = pendingByClient[activeEntity?.id ?? ''] ?? EMPTY_PENDING;

  // Tracks whether any Apply succeeded during this modal session.
  const hasChangedRef = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, true);

  const grouped = useMemo(() => {
    const out: Record<ClientExclusionKind, ExclusionLike[]> = { advisor: [], client: [] };
    for (const e of exclusions) out[e.kind].push(e);
    return out;
  }, [exclusions]);

  // --- Pending mutations ------------------------------------------------

  const mutateActivePending = useCallback(
    (fn: (prev: ClientPending) => ClientPending) => {
      if (!activeEntity) return;
      setPendingByClient((prev) => {
        const current = prev[activeEntity.id] ?? EMPTY_PENDING;
        return { ...prev, [activeEntity.id]: fn(current) };
      });
      setLastSaved(null);
    },
    [activeEntity],
  );

  const stageAddRow = useCallback(
    (kind: ClientExclusionKind) => {
      mutateActivePending((prev) => ({
        ...prev,
        adds: [
          ...prev.adds,
          {
            tempId: crypto.randomUUID(),
            ticker: '',
            kind,
            reason: '',
            // v3.4 — both default false; advisor must pick a side before Apply.
            noBuy: false,
            noSell: false,
          },
        ],
      }));
    },
    [mutateActivePending],
  );

  const editStagedAdd = useCallback(
    (tempId: string, field: 'ticker' | 'reason', value: string) => {
      mutateActivePending((prev) => ({
        ...prev,
        adds: prev.adds.map((a) =>
          a.tempId === tempId ? { ...a, [field]: field === 'ticker' ? value.toUpperCase() : value } : a,
        ),
      }));
    },
    [mutateActivePending],
  );

  // v3.4 — toggle one of the two flag checkboxes on a staged-add row.
  const toggleStagedAddSide = useCallback(
    (tempId: string, side: 'noBuy' | 'noSell') => {
      mutateActivePending((prev) => ({
        ...prev,
        adds: prev.adds.map((a) => (a.tempId === tempId ? { ...a, [side]: !a[side] } : a)),
      }));
    },
    [mutateActivePending],
  );

  const unstageAdd = useCallback(
    (tempId: string) => {
      mutateActivePending((prev) => ({
        ...prev,
        adds: prev.adds.filter((a) => a.tempId !== tempId),
      }));
    },
    [mutateActivePending],
  );

  const togglePendingRemove = useCallback(
    (id: string) => {
      mutateActivePending((prev) => {
        const next = new Set(prev.removeIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        // Toggling a row's removal also clears any inline edit on the same row.
        // The Zod schema rejects (edit + remove) on the same id anyway, but
        // clearing the edit here keeps the UI internally consistent and the
        // pending-count badge accurate.
        const nextEdits = { ...prev.edits };
        if (nextEdits[id]) delete nextEdits[id];
        return { ...prev, removeIds: next, edits: nextEdits };
      });
    },
    [mutateActivePending],
  );

  // v3.4 — toggle a saved row's flag inline. Either:
  //  - row has no pending edit yet: seed pendingEdits from saved values, then
  //    flip the requested side. If the result equals the saved values, drop
  //    the entry (no-op edit normalization).
  //  - row already has a pending edit: flip the side. If the result equals
  //    the saved values, drop the entry. Otherwise update.
  const toggleSavedRowSide = useCallback(
    (savedRowId: string, side: 'noBuy' | 'noSell', savedNoBuy: boolean, savedNoSell: boolean) => {
      mutateActivePending((prev) => {
        // If row is marked for removal, refuse to mutate edits (UI also
        // disables the inputs in this state, but defense-in-depth).
        if (prev.removeIds.has(savedRowId)) return prev;
        const current = prev.edits[savedRowId] ?? { noBuy: savedNoBuy, noSell: savedNoSell };
        const next: PendingEdit = { ...current, [side]: !current[side] };
        const nextEdits = { ...prev.edits };
        if (next.noBuy === savedNoBuy && next.noSell === savedNoSell) {
          delete nextEdits[savedRowId]; // back to original — no-op edit
        } else {
          nextEdits[savedRowId] = next;
        }
        return { ...prev, edits: nextEdits };
      });
    },
    [mutateActivePending],
  );

  // --- Apply / discard --------------------------------------------------

  // Apply is enabled only when there's at least one pending change AND every
  // staged-add row has a non-empty ticker AND every staged-add row has at
  // least one of noBuy/noSell checked. We don't validate ticker char-class
  // here; the server's Zod schema + regex are the source of truth.
  //
  // Edits are validated by `toggleSavedRowSide` itself (it never produces a
  // (false, false) state because a row's pendingEdit starts seeded from the
  // saved values, which the DB CHECK guarantees has at least one true; a
  // toggle that would zero out the side is rejected at the UI layer via
  // the disabled-state below on the inline checkbox).
  const allAddsValid = activePending.adds.every((a) => a.ticker.trim().length > 0 && (a.noBuy || a.noSell));
  const applyDisabled = applying || pendingCount(activePending) === 0 || !allAddsValid;

  const handleApply = useCallback(async () => {
    if (applyDisabled || !activeEntity) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyBatch({
        add: activePending.adds.map((a) => ({
          ticker: a.ticker.trim().toUpperCase(),
          kind: a.kind,
          reason: a.reason.trim(),
          noBuy: a.noBuy,
          noSell: a.noSell,
        })),
        remove: [...activePending.removeIds],
        edit: Object.entries(activePending.edits).map(([id, { noBuy, noSell }]) => ({ id, noBuy, noSell })),
      });
      // Clear this tab's pending state on success. Other tabs keep theirs.
      // pendingEdits, adds, and removeIds all clear together — the server-
      // returned post-commit list is the new source of truth, so any
      // stale pendingEdit would point at the wrong baseline anyway.
      setPendingByClient((prev) => {
        const next = { ...prev };
        delete next[activeEntity.id];
        return next;
      });
      hasChangedRef.current = true;
      setLastSaved({ added: result.added, removed: result.removed, edited: result.edited });
    } catch (err) {
      setApplyError(extractApiError(err, 'Failed to apply changes'));
    } finally {
      setApplying(false);
    }
  }, [applyBatch, activeEntity, activePending, applyDisabled]);

  const handleDiscardActive = useCallback(() => {
    if (!activeEntity) return;
    setPendingByClient((prev) => {
      const next = { ...prev };
      delete next[activeEntity.id];
      return next;
    });
    setApplyError(null);
  }, [activeEntity]);

  // --- Close handling (with pending-changes confirm) --------------------

  const pendingEntitySummary = useMemo(() => {
    // Build a list of "N for <entity>" strings for any tab with pending
    // changes. Used in the confirm dialog when closing.
    return Object.entries(pendingByClient)
      .filter(([, p]) => pendingCount(p) > 0)
      .map(([cid, p]) => {
        const name = entities.find((e) => e.id === cid)?.shortLabel ?? cid;
        const n = pendingCount(p);
        return `${n} unsaved change${n === 1 ? '' : 's'} for ${name}`;
      });
  }, [pendingByClient, entities]);

  const handleClose = useCallback(() => {
    if (pendingEntitySummary.length > 0) {
      const message =
        pendingEntitySummary.length === 1
          ? `Discard ${pendingEntitySummary[0]}?`
          : `Discard ${pendingEntitySummary.join(' and ')}?`;
      // window.confirm is intentionally synchronous — JSDOM's test
      // environment can stub it, and we don't want a stateful confirm
      // modal nested inside this one.
      if (!window.confirm(message)) return;
    }
    if (hasChangedRef.current && onSavedChanges) {
      try {
        onSavedChanges();
      } catch {
        // Don't let a parent re-sync failure block the close.
      }
    }
    onClose();
  }, [pendingEntitySummary, onClose, onSavedChanges]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleClose]);

  // Reset transient feedback when the user switches tabs — the "Saved"
  // toast and Apply error are scoped to the most recent action on the
  // currently-visible tab.
  useEffect(() => {
    setLastSaved(null);
    setApplyError(null);
  }, [activeEntityId]);

  if (entities.length === 0 || !activeEntity) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-exclusions-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={containerRef}
        className="bg-[var(--bg-card)] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden border border-[var(--border)]"
        tabIndex={-1}
      >
        <header className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <div>
            <h2 id="manage-exclusions-title" className="text-lg font-bold text-[var(--text-primary)]">
              {scope === 'account' ? 'Manage Account Restrictions' : 'Manage Exclusions'}
            </h2>
            {entities.length === 1 && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                for <span className="font-medium text-[var(--text-primary)]">{entities[0].shortLabel}</span>
              </p>
            )}
            {entities.length > 1 && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {scope === 'account'
                  ? `${entities.length} accounts selected — each tab is its own batch`
                  : `${entities.length} clients in this household — each tab is its own batch`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </header>

        {entities.length > 1 && (
          <div
            role="tablist"
            aria-label={scope === 'account' ? 'Select account' : 'Select client'}
            className="px-6 pt-3 pb-0 border-b border-[var(--border)] flex flex-wrap gap-2"
          >
            {entities.map((entity) => {
              const isActive = entity.id === activeEntity.id;
              const n = pendingCount(pendingByClient[entity.id]);
              return (
                <button
                  key={entity.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveEntityId(entity.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-1.5 ${
                    isActive
                      ? 'border-[var(--blue-muted)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {entity.label}
                  {n > 0 && (
                    <span
                      className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full bg-[var(--yellow-light,_#fff7e6)] text-[var(--yellow,_#92400e)]"
                      aria-label={`${n} unsaved`}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-8 text-[var(--text-muted)] text-sm">
              <Loader2 className="animate-spin mr-2" size={16} /> Loading…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--red-light)] text-[var(--red)] text-sm">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {lastSaved && (
            <div
              role="status"
              className="flex items-start gap-2 p-3 rounded-lg bg-[var(--green-light,_#dcfce7)] text-[var(--green,_#166534)] text-sm"
            >
              <CheckCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span>
                Saved. {lastSaved.added > 0 && `Added ${lastSaved.added}.`}{' '}
                {lastSaved.removed > 0 && `Removed ${lastSaved.removed}.`}{' '}
                {lastSaved.edited > 0 && `Updated ${lastSaved.edited}.`}
              </span>
            </div>
          )}

          {applyError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--red-light)] text-[var(--red)] text-sm">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <span>{applyError}</span>
            </div>
          )}

          {!loading &&
            (Object.keys(KIND_LABELS) as ClientExclusionKind[]).map((kind) => (
              <ExclusionSection
                key={kind}
                kind={kind}
                savedRows={grouped[kind]}
                stagedAdds={activePending.adds.filter((a) => a.kind === kind)}
                removeIds={activePending.removeIds}
                pendingEdits={activePending.edits}
                disabled={applying}
                onStageAdd={() => stageAddRow(kind)}
                onEditStagedAdd={editStagedAdd}
                onToggleStagedAddSide={toggleStagedAddSide}
                onUnstageAdd={unstageAdd}
                onToggleRemove={togglePendingRemove}
                onToggleSavedRowSide={toggleSavedRowSide}
              />
            ))}
        </div>

        <footer className="px-6 py-3 border-t border-[var(--border)] flex items-center justify-between gap-3">
          <div className="text-xs text-[var(--text-muted)]">
            {pendingCount(activePending) > 0 && (
              <button
                type="button"
                onClick={handleDiscardActive}
                disabled={applying}
                className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                <RotateCcw size={12} /> Discard {pendingCount(activePending)} pending
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={applyDisabled}
              className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-semibold bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {applying && <Loader2 className="animate-spin" size={14} />}
              {pendingCount(activePending) > 0
                ? `Apply ${pendingCount(activePending)} change${pendingCount(activePending) === 1 ? '' : 's'}`
                : 'Apply changes'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

interface SectionProps {
  kind: ClientExclusionKind;
  savedRows: ExclusionLike[];
  stagedAdds: StagedAdd[];
  removeIds: Set<string>;
  pendingEdits: Record<string, PendingEdit>;
  disabled: boolean;
  onStageAdd: () => void;
  onEditStagedAdd: (tempId: string, field: 'ticker' | 'reason', value: string) => void;
  onToggleStagedAddSide: (tempId: string, side: 'noBuy' | 'noSell') => void;
  onUnstageAdd: (tempId: string) => void;
  onToggleRemove: (id: string) => void;
  onToggleSavedRowSide: (
    savedRowId: string,
    side: 'noBuy' | 'noSell',
    savedNoBuy: boolean,
    savedNoSell: boolean,
  ) => void;
}

function ExclusionSection({
  kind,
  savedRows,
  stagedAdds,
  removeIds,
  pendingEdits,
  disabled,
  onStageAdd,
  onEditStagedAdd,
  onToggleStagedAddSide,
  onUnstageAdd,
  onToggleRemove,
  onToggleSavedRowSide,
}: SectionProps) {
  const isEmpty = savedRows.length === 0 && stagedAdds.length === 0;

  return (
    <section>
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-label)] mb-2">
        {KIND_LABELS[kind]}
      </h3>

      {isEmpty && <p className="text-xs italic text-[var(--text-muted)] mb-3">No standing exclusions.</p>}

      {savedRows.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {savedRows.map((e) => {
            const markedForRemoval = removeIds.has(e.id);
            const edit = pendingEdits[e.id];
            // Effective flag values: pendingEdit overrides saved, unless the
            // row is marked for removal (in which case we display the saved
            // values; checkboxes are disabled).
            const effectiveNoBuy = edit && !markedForRemoval ? edit.noBuy : e.noBuy;
            const effectiveNoSell = edit && !markedForRemoval ? edit.noSell : e.noSell;
            const hasPendingEdit = !!edit && !markedForRemoval;
            return (
              <li
                key={e.id}
                className={`flex items-start justify-between gap-3 px-3 py-2 rounded-lg border ${
                  markedForRemoval
                    ? 'bg-[var(--red-light)] border-[var(--red)] opacity-60'
                    : hasPendingEdit
                      ? 'bg-[var(--yellow-light,_#fff7e6)] border-[var(--yellow-border,_#f5c97a)]'
                      : 'bg-[var(--bg-surface)] border-[var(--border)]'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span
                      className={`font-mono font-semibold text-sm text-[var(--text-primary)] ${markedForRemoval ? 'line-through' : ''}`}
                    >
                      {e.ticker}
                    </span>
                    {formatRestrictionReason(e.reason) && (
                      <span className={`text-sm text-[var(--text-primary)] ${markedForRemoval ? 'line-through' : ''}`}>
                        — {formatRestrictionReason(e.reason)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <SideCheckbox
                      label="DNB"
                      checked={effectiveNoBuy}
                      disabled={disabled || markedForRemoval}
                      // Block toggling DNB off when DNS is already off — that
                      // would zero out both sides (CHECK violation). Same
                      // guard as the Apply button's allAddsValid for staged
                      // adds, but inline here so the user gets immediate
                      // feedback instead of a server 400.
                      preventBoth={!effectiveNoSell}
                      onToggle={() => onToggleSavedRowSide(e.id, 'noBuy', e.noBuy, e.noSell)}
                      ariaLabel={`${e.ticker}: do not buy`}
                    />
                    <SideCheckbox
                      label="DNS"
                      checked={effectiveNoSell}
                      disabled={disabled || markedForRemoval}
                      preventBoth={!effectiveNoBuy}
                      onToggle={() => onToggleSavedRowSide(e.id, 'noSell', e.noBuy, e.noSell)}
                      ariaLabel={`${e.ticker}: do not sell`}
                    />
                    <p className="text-[11px] text-[var(--text-muted)] flex-1">
                      {markedForRemoval
                        ? 'Marked for removal — click Apply to commit, or click the icon again to keep'
                        : hasPendingEdit
                          ? `Side change pending: ${formatSide(e.noBuy, e.noSell)} → ${formatSide(effectiveNoBuy, effectiveNoSell)}`
                          : `added by ${e.createdByName}, ${formatAddedAt(e.createdAt)}`}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleRemove(e.id)}
                  disabled={disabled}
                  className="p-1.5 text-[var(--text-muted)] hover:text-[var(--red)] transition-colors disabled:opacity-50"
                  aria-label={markedForRemoval ? `Unmark ${e.ticker} for removal` : `Mark ${e.ticker} for removal`}
                >
                  {markedForRemoval ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {stagedAdds.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {stagedAdds.map((a) => {
            const sideMissing = !a.noBuy && !a.noSell;
            return (
              <li
                key={a.tempId}
                className="grid grid-cols-[110px_1fr_auto_auto] gap-2 items-center px-3 py-2 rounded-lg bg-[var(--yellow-light,_#fff7e6)] border border-[var(--yellow-border,_#f5c97a)]"
              >
                <input
                  type="text"
                  value={a.ticker}
                  onChange={(ev) => onEditStagedAdd(a.tempId, 'ticker', ev.target.value)}
                  placeholder={KIND_PLACEHOLDERS[kind]}
                  maxLength={20}
                  disabled={disabled}
                  className="w-full px-2 py-1 text-sm bg-white border border-[var(--border)] rounded-md focus:outline-none focus:border-[var(--blue-muted)] text-[var(--text-primary)] font-mono uppercase placeholder:text-[var(--text-muted)] disabled:opacity-50"
                  aria-label={`Ticker for new ${kind} exclusion`}
                />
                <input
                  type="text"
                  value={a.reason}
                  onChange={(ev) => onEditStagedAdd(a.tempId, 'reason', ev.target.value)}
                  placeholder={KIND_REASON_PLACEHOLDERS[kind]}
                  maxLength={500}
                  disabled={disabled}
                  className="w-full px-2 py-1 text-sm bg-white border border-[var(--border)] rounded-md focus:outline-none focus:border-[var(--blue-muted)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
                  aria-label={`Reason for new ${kind} exclusion`}
                />
                <div className="flex items-center gap-2">
                  <SideCheckbox
                    label="DNB"
                    checked={a.noBuy}
                    disabled={disabled}
                    onToggle={() => onToggleStagedAddSide(a.tempId, 'noBuy')}
                    ariaLabel={`New ${kind} exclusion: do not buy`}
                  />
                  <SideCheckbox
                    label="DNS"
                    checked={a.noSell}
                    disabled={disabled}
                    onToggle={() => onToggleStagedAddSide(a.tempId, 'noSell')}
                    ariaLabel={`New ${kind} exclusion: do not sell`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onUnstageAdd(a.tempId)}
                  disabled={disabled}
                  className="p-1.5 text-[var(--text-muted)] hover:text-[var(--red)] transition-colors disabled:opacity-50"
                  aria-label={`Discard staged ${kind} exclusion`}
                >
                  <X size={14} />
                </button>
                {sideMissing && (
                  <p className="col-span-4 text-[11px] text-[var(--red,_#b91c1c)] mt-0.5" role="alert">
                    Pick at least one of DNB or DNS to enable Apply.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={onStageAdd}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-[var(--text-label)] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors"
      >
        <Plus size={12} /> Add row
      </button>
    </section>
  );
}

interface SideCheckboxProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  /**
   * When true, blocks the toggle from running (and visually disables the
   * input) because the toggle would result in both DNB and DNS being false,
   * which the CHECK constraint rejects. The user has to first enable the
   * OTHER side, then disable this one. This prevents the (false, false)
   * transient state in the UI.
   */
  preventBoth?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

function SideCheckbox({ label, checked, disabled, preventBoth, onToggle, ariaLabel }: SideCheckboxProps) {
  // We block uncheck-that-would-zero-out-both at the click handler instead
  // of the disabled attribute so the input stays focusable for keyboard
  // navigation; the visual disabled style is applied via opacity.
  const wouldZeroOut = preventBoth && checked;
  return (
    <label
      className={`inline-flex items-center gap-1 text-[11px] font-medium select-none ${
        disabled ? 'opacity-40' : wouldZeroOut ? 'opacity-60' : 'cursor-pointer text-[var(--text-primary)]'
      }`}
      title={wouldZeroOut ? 'At least one of DNB or DNS must stay checked' : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={() => {
          if (wouldZeroOut) return;
          onToggle();
        }}
        className="h-3.5 w-3.5 rounded border-[var(--border)] focus:ring-1 focus:ring-[var(--blue-muted)]"
        aria-label={ariaLabel}
      />
      {label}
    </label>
  );
}
