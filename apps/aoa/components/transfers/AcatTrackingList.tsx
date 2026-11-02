"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill, type PillTone } from "@/components/ui";
import type { AcatToneKind } from "@/lib/data/acat-lane";
import type { AcatStatusGroup } from "@/lib/data/acat-tracking";
import { AcatUnlinkedDrawer } from "./AcatUnlinkedDrawer";
import styles from "./AcatTrackingList.module.css";

// Client list for the ACAT Tracking page: renders the status groups (a header
// with a tone dot + count, then one clickable row per ACAT) and opens the shared
// ACAT-detail drawer on click. Group data is computed server-side
// (buildAcatTracking) and passed in as plain, serializable rows. The drawer
// loads the position table via the role-gated by-id action (reused), and a
// LINKED row's drawer offers a "View transfer →" link.

const TONE: Record<AcatToneKind, PillTone> = {
  accepted: "green",
  submitted: "amber",
  rejected: "red",
  neutral: "gray",
};

// Direction verbatim can be "Incoming"/"Outgoing" or "IN"/"OUT" — normalise to
// the mockup's IN/OUT chip. ONLY an explicit incoming/outgoing maps to a chip;
// a null / blank / unrecognised direction returns null and renders a neutral
// dash (never a definite "OUT" guess — the tracker owns the value).
function direction(
  dir: string | null,
): { label: "IN" | "OUT"; tone: PillTone } | null {
  const d = (dir ?? "").trim().toUpperCase();
  if (/^IN/.test(d)) return { label: "IN", tone: "green" };
  if (/^OUT/.test(d)) return { label: "OUT", tone: "amber" };
  return null; // null / unknown / blank → neutral dash
}

const dash = (s: string | null): string => (s == null || s === "" ? "—" : s);

export function AcatTrackingList({ groups, sourceCheckedAt, onUnlinked, onUnlinkError }: {
  groups: AcatStatusGroup[];
  sourceCheckedAt?: number;
  onUnlinked?: () => void;
  onUnlinkError?: (message: string) => void;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A by-record detail read is newer than the workspace's cached source rows.
  const [currentTypes, setCurrentTypes] = useState(() => new Map<string, string | null>());
  // Linkage-only reloads reuse the Tracker snapshot; only a fresh source read
  // supersedes these values. The uncached legacy view has no snapshot metadata.
  const sourceSnapshot = sourceCheckedAt ?? groups;
  useEffect(() => { setCurrentTypes(new Map()); }, [sourceSnapshot]);
  const handleTypeChanged = useCallback((recordId: string, type: string | null) => {
    setCurrentTypes((current) => current.has(recordId) && current.get(recordId) === type ? current : new Map(current).set(recordId, type));
  }, []);
  const selectedRow = groups.flatMap((group) => group.rows).find((row) => row.id === selectedId);
  const selected = selectedRow && currentTypes.has(selectedRow.id)
    ? { ...selectedRow, type: currentTypes.get(selectedRow.id)! } : selectedRow;

  if (groups.length === 0) {
    return (
      <p className={styles.empty} role="status">
        No ACAT records to show right now.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      {groups.map((group) => (
        <section key={group.label} className={styles.group}>
          <div className={styles.groupHead}>
            <span
              className={`${styles.dot} ${styles[`dot_${group.tone}`]}`}
              aria-hidden
            />
            <h2 className={styles.groupTitle}>{group.label}</h2>
            <span className={styles.count}>{group.count}</span>
          </div>

          <ul className={styles.rows}>
            {group.rows.map((row) => {
              const dir = direction(row.direction);
              const currentType = currentTypes.has(row.id) ? currentTypes.get(row.id)! : row.type;
              return (
                // The tracker record `id` is the stable, always-present identity
                // (a legacy/manual ACAT may have an empty acatTransferId), so it
                // is the React key.
                <li key={row.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${row.needsAttention ? styles.attention : ""}`.trim()}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <span className={styles.client}>
                      <span className={styles.name}>
                        {dash(row.clientName)}
                      </span>
                      <span className={styles.acctType}>
                        {dash(row.accountType)}
                      </span>
                    </span>
                    <span className={styles.statusCell}>
                      {/* Friendly label + catalog tone — identical to the
                          group header and the detail modal (ticket). Every
                          row in a group shares its label, so we reuse it. */}
                      <Pill tone={TONE[group.tone]} dot>
                        {group.label}
                      </Pill>
                    </span>
                    <span className={styles.contra}>
                      {dash(row.transferringContra)}
                    </span>
                    <span className={styles.dirCell}>
                      {dir ? (
                        <Pill tone={dir.tone}>{dir.label}</Pill>
                      ) : (
                        <span className={styles.dirDash}>—</span>
                      )}
                    </span>
                    <span className={styles.type}>{dash(currentType)}</span>
                    <span className={styles.date}>{dash(row.acatDate)}</span>
                    <span className={styles.linkCell}>
                      {row.linked ? (
                        <span className={styles.linked}>Linked</span>
                      ) : (
                        <span className={styles.unlinked}>Un-linked</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {selected && (
        <AcatUnlinkedDrawer
          key={`${selected.id}:${selected.transferId ?? "unlinked"}`}
          row={selected}
          transferId={selected.transferId}
          onTypeChanged={handleTypeChanged}
          onClose={() => setSelectedId(null)}
          onUnlinked={() => {
            setSelectedId(null);
            if (onUnlinked) onUnlinked();
            else router.refresh();
          }}
          onUnlinkError={onUnlinkError}
        />
      )}
    </div>
  );
}
