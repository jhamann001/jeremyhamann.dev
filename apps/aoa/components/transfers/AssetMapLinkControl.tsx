"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { usd } from "@/lib/format";
import {
  loadAssignableAssetMapAccounts,
  linkAssetMapToTransfer,
  unlinkAssetMapFromTransfer,
  type AssignableAssetMapResult,
} from "@/app/(authenticated)/asset-transfer/actions";
import type { AssetMapAccountOption } from "@/lib/data/transfer-asset-map";
import styles from "./AssetMapLinkControl.module.css";

// The "assign an asset map to a transfer" control (rework S3) — the funding
// card's Mapping-account row. Client component; the funding card (server) renders
// it only when the flag is ON. Two states:
//   • Linked — shows the linked account (masked) with Change / Unlink.
//   • Unlinked — a "Link asset map" button (writers) → a modal picker that lazily
//     loads the assignable accounts (the AcatLinkPicker lazy-load idiom):
//     RECOMMENDED (matched by the deal's last-4) on top, then the full searchable
//     list of everything not already linked to a transfer. A VIEWER sees the
//     read-only "No asset map linked" note.
// NO write happens here — every write is a co-located "use server" action that
// re-gates (flag + RLS). Masked numbers only (§6).

type Loaded = Extract<AssignableAssetMapResult, { ok: true }>;

export function AssetMapLinkControl({
  transferId,
  canWrite,
  hrqjSbevsbySbin8,
  current,
}: {
  transferId: string;
  canWrite: boolean;
  hrqjSbevsbySbin8: string | null;
  /** The currently-linked mapping account (masked), or null when unlinked. S5:
   *  accountNumberMasked is null for a numberless account — accountType is the
   *  label then. */
  current: {
    custodian: string;
    accountNumberMasked: string | null;
    accountType: string | null;
  } | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean } | void>) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    startTransition(async () => {
      const res = await fn();
      submittingRef.current = false;
      if (res && !res.ok) setError("The change could not be saved.");
      else setOpen(false);
    });
  };

  const onPick = (a: AssetMapAccountOption) =>
    run(() => linkAssetMapToTransfer(transferId, a.accountId));
  const onUnlink = () => run(() => unlinkAssetMapFromTransfer(transferId));

  if (current) {
    return (
      <div className={styles.linked}>
        <span className={styles.linkedValue}>
          {current.accountNumberMasked ?? current.accountType ?? "no acct #"} ·{" "}
          {current.custodian}
        </span>
        {canWrite && (
          <span className={styles.linkedActions}>
            <button type="button" className={styles.linkBtn} onClick={() => setOpen(true)}>
              Change
            </button>
            <button type="button" className={styles.linkBtn} onClick={onUnlink} disabled={pending}>
              Unlink
            </button>
          </span>
        )}
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
        {open && (
          <AssetMapLinkModal
            transferId={transferId}
            hrqjSbevsbySbin8={hrqjSbevsbySbin8}
            onClose={() => setOpen(false)}
            onPick={onPick}
            pending={pending}
          />
        )}
      </div>
    );
  }

  if (!canWrite) {
    return <span className={styles.emptyNote}>No asset map linked</span>;
  }

  return (
    <div className={styles.linked}>
      <button type="button" className={styles.linkCta} onClick={() => setOpen(true)}>
        Link asset map →
      </button>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      {open && (
        <AssetMapLinkModal
          transferId={transferId}
          hrqjSbevsbySbin8={hrqjSbevsbySbin8}
          onClose={() => setOpen(false)}
          onPick={onPick}
          pending={pending}
        />
      )}
    </div>
  );
}

function AssetMapLinkModal({
  transferId,
  hrqjSbevsbySbin8,
  onClose,
  onPick,
  pending,
}: {
  transferId: string;
  hrqjSbevsbySbin8: string | null;
  onClose: () => void;
  onPick: (a: AssetMapAccountOption) => void;
  pending: boolean;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    loadAssignableAssetMapAccounts(hrqjSbevsbySbin8, transferId).then((res) => {
      if (!live) return;
      if (res.ok) setData(res);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [hrqjSbevsbySbin8, transferId]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  // While searching, filter the ENTIRE list (recommended + others) so a name
  // query shows ONLY matches — the Recommended band no longer leaks unrelated
  // last-4 matches through. Match on the fields ops would type.
  const results = useMemo(() => {
    if (!data || !searching) return [];
    const matches = (a: AssetMapAccountOption) =>
      (a.householdName ?? "").toLowerCase().includes(q) ||
      (a.accountHolder ?? "").toLowerCase().includes(q) ||
      (a.accountType ?? "").toLowerCase().includes(q) ||
      a.custodian.toLowerCase().includes(q) ||
      (a.accountNumberMasked ?? "").toLowerCase().includes(q);
    return [...data.recommended, ...data.others].filter(matches);
  }, [data, q, searching]);
  // Opaque identity also distinguishes numberless accounts and last-four
  // collisions without keeping the durable account number in client state.
  const rowKey = (a: AssetMapAccountOption) => a.accountId;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Link asset map">
      <div className={styles.modal}>
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle}>Link an asset map</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {failed ? (
          <p className={styles.note}>Couldn&apos;t load asset maps right now — close and retry.</p>
        ) : !data ? (
          <p className={styles.note}>Loading asset maps…</p>
        ) : data.recommended.length === 0 && data.others.length === 0 ? (
          <p className={styles.note}>
            No asset-map accounts found to assign.
          </p>
        ) : (
          <>
            {/* Search is global — it filters the whole list, so it lives at the
                top (not inside one band). */}
            <input
              type="text"
              className={styles.search}
              placeholder="Search by client, holder, custodian, or type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />

            {searching ? (
              // Searching → ONE flat, fully-filtered result list (both bands).
              <section className={styles.section}>
                <p className={styles.sectionLabel}>
                  Results{" "}
                  <span className={styles.sectionSub}>— matching “{query.trim()}”</span>
                </p>
                {results.length === 0 ? (
                  <p className={styles.note}>No matches.</p>
                ) : (
                  <ul className={styles.list}>
                    {results.map((a) => (
                      <li key={rowKey(a)}>
                        <AccountButton
                          a={a}
                          onPick={onPick}
                          pending={pending}
                          recommended={data.recommended.includes(a)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : (
              // Idle → Recommended band (if any) + the full list.
              <>
                {data.recommended.length > 0 && (
                  <section className={styles.section}>
                    <p className={styles.sectionLabel}>
                      Recommended · matches the deal&apos;s account ending {hrqjSbevsbySbin8}
                    </p>
                    <ul className={styles.list}>
                      {data.recommended.map((a) => (
                        <li key={rowKey(a)}>
                          <AccountButton a={a} onPick={onPick} pending={pending} recommended />
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className={styles.section}>
                  <p className={styles.sectionLabel}>
                    All accounts{" "}
                    <span className={styles.sectionSub}>
                      — the recommendation may miss; pick from the full list. Accounts
                      already linked to another transfer are marked.
                    </span>
                  </p>
                  <ul className={styles.list}>
                    {data.others.map((a) => (
                      <li key={rowKey(a)}>
                        <AccountButton a={a} onPick={onPick} pending={pending} />
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AccountButton({
  a,
  onPick,
  pending,
  recommended = false,
}: {
  a: AssetMapAccountOption;
  onPick: (a: AssetMapAccountOption) => void;
  pending: boolean;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${recommended ? styles.itemRec : ""}`.trim()}
      onClick={() => onPick(a)}
      disabled={pending}
    >
      <span className={styles.itemMain}>
        <span className={styles.itemName}>{a.householdName ?? a.accountHolder ?? "—"}</span>
        <span className={styles.itemSub}>
          {a.custodian}
          {a.accountType ? ` · ${a.accountType}` : ""}
          {` · ${a.accountNumberMasked ?? "no acct #"}`}
          {a.totalValue != null ? ` · ${usd(a.totalValue)}` : ""}
        </span>
        {a.linkedTransferCount > 0 && (
          <span className={styles.itemLinked}>
            Already linked to{" "}
            {a.linkedTransferClients.length > 0
              ? a.linkedTransferClients.join(", ")
              : `${a.linkedTransferCount} other transfer${
                  a.linkedTransferCount === 1 ? "" : "s"
                }`}
          </span>
        )}
      </span>
      <span className={styles.itemGo} aria-hidden>
        →
      </span>
    </button>
  );
}
