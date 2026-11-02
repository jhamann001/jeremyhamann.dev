"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  buildSearchGroups,
  stageLabel,
  type SearchRow,
  type SearchGroups,
} from "@/lib/data/transfer-types";
import { usdCompact } from "@/lib/format";
import styles from "./ClientSearch.module.css";

// Client-search typeahead over the board rows (mockup #clientSearchWrap; the
// client-card OVERLAY is dropped — answered decision 5, list→detail as ROUTES).
// The dropdown is GROUPED (ticket) into Households and Individuals, mirroring
// the global search: picking a household narrows the board via the server-side
// ?household focus filter (composes with ?owner); picking an individual navigates
// straight to `/asset-transfer/<id>`; pressing Enter narrows via ?q. Grouping is a
// pure, tested helper (buildSearchGroups) so search and the board can never disagree.
// Pure client-side filter over the FULL listTransfers rows (not the owner-narrowed
// set) so search always spans the whole book.

// ONE row shape — re-exported from the pure transfer-types module so page.tsx and
// this component can never diverge.
export type ClientSearchRow = SearchRow;

export function ClientSearch({ rows, scope, onRecordNavigate, onUnauthorized }: {
  rows?: ClientSearchRow[]; scope?: string; onRecordNavigate?: (href: string) => void; onUnauthorized?: () => void;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const query = q.trim();
  const [remote, setRemote] = useState<SearchGroups>({ households: [], individuals: [] });
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  useEffect(() => {
    if (rows || scope === undefined) return;
    const controller = new AbortController();
    setRemote({ households: [], individuals: [] });
    if (!query) { setState("idle"); return; }
    setState("loading");
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/navigation/transfers?mode=search&q=${encodeURIComponent(query)}`, {
          signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
        });
        if (response.status === 401 || response.status === 403 || response.headers.get("X-AOA-Navigation-Scope") !== scope) { onUnauthorized?.(); setState("error"); return; }
        if (!response.ok) throw new Error("search_unavailable");
        const value = await response.json();
        if (controller.signal.aborted) return;
        if (!Array.isArray(value.households) || value.households.length > 20 || !Array.isArray(value.individuals) || value.individuals.length > 50) throw new Error("search_unavailable");
        setRemote(value); setState("idle");
      } catch { if (!controller.signal.aborted) setState("error"); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [rows, scope, query, onUnauthorized]);
  const groups = rows ? buildSearchGroups(rows, query) : remote;
  const hasResults =
    groups.households.length > 0 || groups.individuals.length > 0;

  // Preserve any active ?owner pill; set household (or q) and drop the other.
  const focusHref = (key: "household" | "q", value: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set(key, value);
    next.delete(key === "household" ? "q" : "household");
    next.delete("page");
    return `/asset-transfer?${next.toString()}`;
  };

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        className={styles.input}
        type="text"
        placeholder="Search for a client..."
        autoComplete="off"
        aria-label="Search transfers by client name"
        value={q}
        maxLength={256}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(e.target.value.trim().length > 0);
        }}
        onFocus={() => setOpen(query.length > 0)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" && query.length > 0) {
            setOpen(false);
            router.push(focusHref("q", query));
          }
        }}
      />
      {open && (
        <div className={styles.results}>
          {!hasResults ? (
            <div className={styles.empty}>{state === "loading" ? "Searching…" : state === "error" ? "Search unavailable. Press Enter to filter the board." : "No clients found"}</div>
          ) : (
            <>
              {groups.households.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.groupHead}>Households</div>
                  {groups.households.map((h) => (
                    <Link
                      key={h.key}
                      href={focusHref("household", h.key)}
                      className={styles.item}
                      prefetch={false}
                    >
                      <span className={styles.itemName}>{h.name}</span>
                      <span className={styles.itemDetail}>
                        {h.count} transfer{h.count === 1 ? "" : "s"} ·{" "}
                        {usdCompact(h.total)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
              {groups.individuals.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.groupHead}>Individuals</div>
                  {groups.individuals.map((r) => (
                    <Link
                      key={r.id}
                      href={`/asset-transfer/${r.id}`}
                      className={styles.item}
                      prefetch={false}
                      onClick={() => onRecordNavigate?.(`/asset-transfer/${r.id}`)}
                    >
                      <span className={styles.itemName}>{r.name}</span>
                      <span className={styles.itemDetail}>
                        {stageLabel(r.stage)} · {usdCompact(r.value)}
                        {r.contra ? ` · ${r.contra}` : ""}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
          {hasResults && !rows ? <div className={styles.empty}>Up to 20 households and 50 transfers. Press Enter to show all matching transfers.</div> : null}
        </div>
      )}
    </div>
  );
}
