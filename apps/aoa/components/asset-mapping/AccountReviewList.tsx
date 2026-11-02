"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { Button, Pill } from "@/components/ui";
import { usdCompact } from "@/lib/format";
import type {
  AccountReviewRow,
  FolderAccountReview,
  ReviewCandidate,
} from "@/lib/data/asset-map-review";
import {
  confirmAccountOwners,
  rejectAccount,
  loadReviewClients,
  type ReviewClientsResult,
} from "@/app/(authenticated)/asset-mapping-review/actions";
import styles from "./AccountReviewList.module.css";

// Client surface for the ACCOUNT-grain review — the ONLY review surface now that
// the household confirm/verify card is retired (design "do it at the account
// level"). A folder row expands to its accounts. Two shapes per account:
//
//  • RESOLVED folder (household already bound) — the P2.5 multi-select owner
//    control (checkboxes over the live-recomputed household members, pre-checked
//    from preSelected; a joint account confirms both in one click) or an
//    "entity — no person" toggle.
//  • UNRESOLVED folder (the matcher couldn't bind the household) — the FOLD-IN:
//    the account row carries the client picker (ranked household candidates +
//    firm-wide search). Picking the client + Confirm resolves the folder link AND
//    attributes the account owner in one ops tx (confirmAccountOwners's
//    householdClientSfId path). Resolving any one account resolves the folder, so
//    its remaining accounts re-render as member-based on the next load.
//
// Confirm is all-or-nothing per account. NO write happens here: every write is a
// co-located "use server" action that re-gates + runs under RLS + re-validates
// membership. PII: names + a MASKED account number are shown (the ops-only
// surface's purpose); the full account number is never displayed or logged.

type Loaded = Extract<ReviewClientsResult, { ok: true }>;

const pct = (n: number | null | undefined): string =>
  n == null ? "—" : `${Math.round(n * 100)}%`;

export function AccountReviewList({ folders }: { folders: FolderAccountReview[] }) {
  // Firm-wide client cache for the fold-in picker's free search — lazily loaded
  // once on first open, shared across every unresolved account row. A
  // forbidden/error result disables free search but leaves the ranked household
  // candidates fully usable (the AssetMappingReviewList idiom).
  const [clients, setClients] = useState<Loaded | null>(null);
  const [clientsFailed, setClientsFailed] = useState(false);
  const loadingRef = useRef(false);

  const ensureClients = useCallback(() => {
    if (clients || clientsFailed || loadingRef.current) return;
    loadingRef.current = true;
    loadReviewClients().then((res) => {
      if (res.ok) setClients(res);
      else setClientsFailed(true);
      loadingRef.current = false;
    });
  }, [clients, clientsFailed]);

  if (folders.length === 0) {
    return (
      <p className={styles.empty} role="status">
        No accounts need attribution right now. After the next reconcile run,
        accounts whose owner (or household) needs a human decision will appear here.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.groupHead}>
        <h2 className={styles.groupTitle}>Accounts to attribute</h2>
        <span className={styles.count}>
          {folders.reduce((n, f) => n + f.accounts.length, 0)}
        </span>
      </div>
      <p className={styles.groupHint}>
        Each matched household expands to its accounts. Pick the owner(s) for each
        account — both spouses for a joint account — then confirm, or mark it an
        entity (trust / LLC) with no person. For a household we haven&apos;t matched
        yet, pick the client right on the account.
      </p>
      <ul className={styles.folders}>
        {folders.map((folder) => (
          <li key={folder.sourceFolderId}>
            <details className={styles.folder} open>
              <summary className={styles.folderSummary}>
                <span className={styles.folderName}>
                  {folder.householdName ?? "—"}
                </span>
                {!folder.folderResolved && (
                  <Pill tone="amber">household not matched</Pill>
                )}
                <span className={styles.folderCount}>
                  {folder.accounts.length}{" "}
                  {folder.accounts.length === 1 ? "account" : "accounts"}
                </span>
              </summary>
              <ul className={styles.accounts}>
                {folder.accounts.map((acct, index) => (
                  <li key={acct.accountId ?? `historical-${index}`}>
                    <AccountRow
                      folder={folder}
                      acct={acct}
                      clients={clients}
                      clientsFailed={clientsFailed}
                      ensureClients={ensureClients}
                    />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountRow({
  folder,
  acct,
  clients,
  clientsFailed,
  ensureClients,
}: {
  folder: FolderAccountReview;
  acct: AccountReviewRow;
  clients: Loaded | null;
  clientsFailed: boolean;
  ensureClients: () => void;
}) {
  const [isEntity, setIsEntity] = useState<boolean>(acct.isEntity);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Synchronous double-submit guard (the review-list idiom).
  const submittingRef = useRef(false);

  // Resolved-folder state: multi-select over household members, pre-checked.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(acct.candidates.filter((c) => c.preSelected).map((c) => c.clientSfId)),
  );
  const toggle = (clientSfId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(clientSfId)) next.delete(clientSfId);
      else next.add(clientSfId);
      return next;
    });
  };

  // Unresolved-folder (fold-in) state: the single household client to bind.
  const [householdPick, setHouseholdPick] = useState<{ sfId: string; name: string } | null>(
    null,
  );

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (submittingRef.current || !acct.accountId) return;
    submittingRef.current = true;
    setError(null);
    startTransition(async () => {
      const res = await fn();
      // On success the action revalidates and this row drops out; on failure
      // release the guard and surface the generic message.
      if (!res.ok) {
        submittingRef.current = false;
        setError(res.error ?? "The change could not be saved.");
      }
    });
  };

  const onReject = () =>
    run(() => rejectAccount(acct.accountId ?? ""));

  const head = (
    <div className={styles.cardHead}>
      <div className={styles.holder}>{acct.accountHolder ?? "—"}</div>
      <div className={styles.meta}>
        <Pill tone="gray">{acct.custodian}</Pill>
        <span className={styles.metaText}>{acct.accountNumberMasked}</span>
        {acct.totalValue != null && (
          <span className={styles.metaText}>{usdCompact(acct.totalValue)}</span>
        )}
        {acct.status === "AUTO_LINKED" && <Pill tone="green">Auto</Pill>}
      </div>
    </div>
  );

  const rejectHelper = (
    <p className={styles.helper}>
      Reject marks this account reviewed with no owner — it won&apos;t be re-queued.
      Nothing is deleted.
    </p>
  );

  // ---- UNRESOLVED folder: the fold-in (pick the household client here) --------
  if (!folder.folderResolved) {
    const onConfirm = () => {
      if (!householdPick) return;
      run(() =>
        confirmAccountOwners(
          acct.accountId ?? "",
          isEntity ? [] : [householdPick.sfId],
          isEntity,
          householdPick.sfId, // resolves the folder link from the account row
        ),
      );
    };

    return (
      <div className={styles.card}>
        {head}
        {!acct.accountId && (
          <p className={styles.helper}>
            This account is no longer in the current mapping. Refresh after the next import to review it.
          </p>
        )}

        <p className={styles.helper}>
          This household isn&apos;t matched yet — pick the client to attribute this
          account to. Confirming binds the household and attributes the account in
          one step.
        </p>

        <HouseholdPicker
          candidates={folder.householdCandidates}
          clients={clients}
          clientsFailed={clientsFailed}
          ensureClients={ensureClients}
          pick={householdPick}
          onPick={setHouseholdPick}
          pending={pending}
        />

        <label className={styles.entityToggle}>
          <input
            type="checkbox"
            checked={isEntity}
            disabled={!acct.accountId || pending}
            onChange={(e) => setIsEntity(e.target.checked)}
          />
          <span>Entity — no person (trust / LLC / estate)</span>
        </label>

        <p className={styles.helper}>
          {isEntity
            ? "Confirm binds the household to the selected client and records this account as an entity with no individual owner."
            : "Confirm binds the household and attributes this account to the selected client. This is reversible."}
        </p>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <Button onClick={onConfirm} disabled={!acct.accountId || !householdPick || pending}>
            {isEntity ? "Match & confirm entity" : "Match & confirm owner"}
          </Button>
          <Button variant="ghost" onClick={onReject} disabled={!acct.accountId || pending}>
            Reject
          </Button>
        </div>
        {rejectHelper}
      </div>
    );
  }

  // ---- RESOLVED folder: the P2.5 member multi-select ------------------------
  const canConfirm = isEntity || checked.size > 0;
  const onConfirm = () =>
    run(() =>
      confirmAccountOwners(
        acct.accountId ?? "",
        isEntity ? [] : [...checked],
        isEntity,
      ),
    );

  return (
    <div className={styles.card}>
      {head}
      {!acct.accountId && (
        <p className={styles.helper}>
          This account is no longer in the current mapping. Refresh after the next import to review it.
        </p>
      )}

      <label className={styles.entityToggle}>
        <input
          type="checkbox"
          checked={isEntity}
          disabled={!acct.accountId || pending}
          onChange={(e) => setIsEntity(e.target.checked)}
        />
        <span>Entity — no person (trust / LLC / estate)</span>
      </label>

      {!isEntity &&
        (acct.candidates.length > 0 ? (
          <fieldset className={styles.candidates} disabled={!acct.accountId || pending}>
            <legend className={styles.candLegend}>Owner(s) — select all that apply</legend>
            {acct.candidates.map((c) => {
              const on = checked.has(c.clientSfId);
              return (
                <label
                  key={c.clientSfId}
                  className={`${styles.candidate} ${on ? styles.candidateOn : ""}`.trim()}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(c.clientSfId)}
                  />
                  <span className={styles.candName}>{c.name || c.clientSfId}</span>
                  {c.notInHousehold && (
                    <Pill tone="amber">not in this household</Pill>
                  )}
                  <span className={styles.candWhy}>
                    {pct(c.confidence)} · {c.sharedTokens} shared{" "}
                    {c.sharedTokens === 1 ? "token" : "tokens"}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <p className={styles.noCandidates}>
            No household member matched this holder — mark it an entity, or reject.
          </p>
        ))}

      {acct.status === "NEEDS_REVIEW" && !isEntity && checked.size === 0 && (
        <p className={styles.hint}>Select at least one owner, or mark it an entity.</p>
      )}

      <p className={styles.helper}>
        {isEntity
          ? "Confirm records this account as an entity (trust / LLC / estate) with no individual owner."
          : "Confirm attributes this account to the selected owner(s). Unselected suggestions are dismissed. This is reversible."}
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <Button onClick={onConfirm} disabled={!acct.accountId || !canConfirm || pending}>
          {isEntity ? "Confirm entity" : "Confirm owner(s)"}
        </Button>
        <Button variant="ghost" onClick={onReject} disabled={!acct.accountId || pending}>
          Reject
        </Button>
      </div>
      {rejectHelper}
    </div>
  );
}

// The fold-in client picker: ranked household candidates (radios) + a firm-wide
// free search fallback. Picking sets the single household client the confirm binds.
function HouseholdPicker({
  candidates,
  clients,
  clientsFailed,
  ensureClients,
  pick,
  onPick,
  pending,
}: {
  candidates: ReviewCandidate[];
  clients: Loaded | null;
  clientsFailed: boolean;
  ensureClients: () => void;
  pick: { sfId: string; name: string } | null;
  onPick: (p: { sfId: string; name: string }) => void;
  pending: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const openSearch = () => {
    setSearchOpen(true);
    ensureClients();
  };

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!clients || q.length === 0) return [];
    return clients.clients.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [clients, q]);

  return (
    <fieldset className={styles.candidates} disabled={pending}>
      <legend className={styles.candLegend}>Match to client</legend>

      {candidates.map((c) => {
        const on = pick?.sfId === c.clientSfId;
        return (
          <label
            key={c.clientSfId}
            className={`${styles.candidate} ${on ? styles.candidateOn : ""}`.trim()}
          >
            <input
              type="radio"
              name={`hh-pick-${c.clientSfId}-${pick?.sfId ?? ""}`}
              checked={on}
              onChange={() => onPick({ sfId: c.clientSfId, name: c.name })}
            />
            <span className={styles.candName}>{c.name || c.clientSfId}</span>
            <span className={styles.candWhy}>
              {pct(c.confidence)} · {c.sharedTokens} shared{" "}
              {c.sharedTokens === 1 ? "token" : "tokens"}
            </span>
          </label>
        );
      })}

      {candidates.length === 0 && (
        <p className={styles.noCandidates}>
          No suggested clients — search for the right one below.
        </p>
      )}

      {!searchOpen ? (
        <button type="button" className={styles.linkBtn} onClick={openSearch}>
          Search for another client
        </button>
      ) : (
        <div className={styles.search}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search clients by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {clientsFailed && (
            <p className={styles.searchError}>Client search is unavailable right now.</p>
          )}
          {matches.length > 0 && (
            <ul className={styles.matchList}>
              {matches.map((m) => (
                <li key={m.sfId}>
                  <button
                    type="button"
                    className={styles.matchItem}
                    onClick={() => {
                      onPick({ sfId: m.sfId, name: m.name });
                      setQuery(m.name);
                    }}
                  >
                    <span className={styles.matchName}>{m.name}</span>
                    <span className={styles.matchSub}>{m.householdName ?? "Client"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pick && (
        <p className={styles.hint}>
          Selected: <strong>{pick.name || pick.sfId}</strong>
        </p>
      )}
    </fieldset>
  );
}
