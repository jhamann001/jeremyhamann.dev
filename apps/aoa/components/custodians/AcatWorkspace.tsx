"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { acatWorkspaceResponseSchema, type AcatWorkspaceResponse, type AcatWorkspaceView } from "@/lib/data/acat-workspace-contract";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import { AcatTrackingView } from "@/components/transfers/AcatTrackingView";
import { AcatSectionNav } from "./AcatSectionNav";
import type { CustodianLibrary as CustodianLibraryData } from "@/lib/data/custodian-library-contract";
import { patchLibrarySnapshot } from "@/lib/data/custodian-admin-contract";
import { CustodianLibrary } from "./CustodianLibrary";
import styles from "./AcatWorkspace.module.css";

type Saved = { response: AcatWorkspaceResponse; until: number };
type Views<T> = Partial<Record<AcatWorkspaceView, T>>;
const unavailable = {
  library: "The custodian library is unavailable right now. No fee or playbook data could be verified. Try Refresh or open the Transfer Tracker.",
  tracking: "Live ACAT data is unavailable right now. Try Refresh or open the Transfer Tracker.",
};
const viewFromUrl = () => {
  const values = new URL(window.location.href).searchParams.getAll("view");
  return values.length === 1 && values[0] === "library" ? "library" : "tracking";
};
function saved(response: AcatWorkspaceResponse, elapsed: number): Saved | undefined {
  // Monotonic browser lease subtracts the entire request duration. Cache hits
  // never restart the server TTL, even when browser/server clocks disagree.
  // The library click stays for the operator's session. The five-minute
  // reference cache no longer hides it. Tracking keeps the short lease.
  const leaseEnd = response.snapshot.view === "library"
    ? response.sessionExpiresAt
    : Math.min(response.snapshot.expiresAt, response.sessionExpiresAt);
  const remaining = leaseEnd - response.serverNow - elapsed;
  return remaining > 0 ? { response, until: performance.now() + remaining } : undefined;
}

/** Two snapshots, component memory only. No local/session storage, global
 * browser singleton, prefetch or idle polling. Data vanishes on unmount. */
export function AcatWorkspace({ scope, initialView, initial, custodianAdmin = false, authorityLibrary = false }: {
  scope: string; initialView: AcatWorkspaceView; initial: AcatWorkspaceResponse | null; custodianAdmin?: boolean; authorityLibrary?: boolean;
}) {
  const [view, setView] = useState(initialView);
  // The header no longer has a control that calls navigate("tracking"). A full
  // navigation to the book address, such as the sidebar link, arrives as a new
  // initialView and must replace the library view the client was showing.
  useEffect(() => { setView(initialView); }, [initialView]);
  const selected = useRef(view);
  selected.current = view;
  const [snapshots, setSnapshots] = useState<Views<Saved>>(() => {
    if (!initial || initial.scope !== scope) return {};
    // SSR renders identical content. Hydration effect establishes the browser
    // lease, accounting for time since the original server response.
    return { [initialView]: { response: initial, until: Infinity } };
  });
  const [loading, setLoading] = useState<Views<boolean>>({});
  const [errors, setErrors] = useState<Views<string>>(initial ? {} : { [initialView]: unavailable[initialView] });
  const [fatal, setFatal] = useState("");
  const [notice, setNotice] = useState("");
  const [unlinkError, setUnlinkError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const [verified, setVerified] = useState(false);
  const blocked = useRef(false);
  const requests = useRef<Views<AbortController>>({});
  const memory = useRef(snapshots);
  memory.current = snapshots;
  const generation = useRef(0);
  const mounted = useRef(false);

  const abortReads = useCallback(() => {
    generation.current++;
    for (const request of Object.values(requests.current)) request?.abort();
    requests.current = {};
  }, []);
  const clear = useCallback(() => {
    abortReads();
    memory.current = {};
    setSnapshots({}); setLoading({}); setVerified(false);
  }, [abortReads]);
  const lock = useCallback((message: string) => {
    blocked.current = true; clear(); setNotice(""); setUnlinkError(""); setFatal(message);
  }, [clear]);

  const load = useCallback(async (target: AcatWorkspaceView, refresh = false) => {
    if (blocked.current) return;
    requests.current[target]?.abort();
    const controller = new AbortController();
    requests.current[target] = controller;
    const version = generation.current;
    const current = () => mounted.current && generation.current === version && requests.current[target] === controller;
    setSnapshots((old) => ({ ...old, [target]: undefined }));
    setErrors((old) => ({ ...old, [target]: undefined }));
    setLoading((old) => ({ ...old, [target]: true }));
    const started = performance.now();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/acat-workspace?view=${target}${refresh ? "&refresh=1" : ""}`, {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
      });
      if (!current()) return;
      if (controller.signal.aborted) throw new Error("timeout");
      if (response.status === 401 || response.status === 403) {
        lock("Your session or access changed. Reload this page to continue."); return;
      }
      if (!response.ok) throw new Error("unavailable");
      const parsed = acatWorkspaceResponseSchema.safeParse(await response.json());
      if (!current()) return;
      if (controller.signal.aborted) throw new Error("timeout");
      if (!parsed.success || parsed.data.snapshot.view !== target) throw new Error("invalid");
      if (parsed.data.scope !== scope) {
        lock("Your session or access changed. Reload this page to continue."); return;
      }
      const entry = saved(parsed.data, performance.now() - started);
      if (!entry) throw new Error("expired");
      setVerified(true);
      setSnapshots((old) => ({ ...old, [target]: entry }));
    } catch {
      if (current()) setErrors((old) => ({ ...old, [target]: unavailable[target] }));
    } finally {
      clearTimeout(timeout);
      if (current()) {
        delete requests.current[target];
        setLoading((old) => ({ ...old, [target]: false }));
      }
    }
  }, [scope, lock]);

  // Server-action revalidation replaces initial props within the same scope.
  // Keep mutation feedback through that refresh, but never across a login change.
  useEffect(() => {
    setNotice("");
    setUnlinkError("");
  }, [scope]);

  useEffect(() => {
    mounted.current = true;
    blocked.current = false;
    setVerified(false);
    setFatal("");
    // The preceding cleanup aborted the reads owning these loading flags.
    setLoading({});
    const entry = initial && initial.scope === scope
      ? saved(initial, Math.max(0, Date.now() - initial.serverNow)) : undefined;
    setSnapshots(entry ? { [initialView]: entry } : {});
    setErrors(entry ? {} : { [initialView]: unavailable[initialView] });
    // Next/browser history can retain old RSC props. Before displaying ANY
    // retained initial payload, verify the live login scope with Auth.js.
    // This is a small auth read, not another Tracker/source read.
    const access = new AbortController();
    const accessVersion = generation.current;
    const accessTimeout = setTimeout(() => access.abort(), 5_000);
    void (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: access.signal });
        const session = response.ok ? await response.json() : null;
        if (!mounted.current || generation.current !== accessVersion) return;
        if (access.signal.aborted || !session?.user || session.navigationScope !== scope ||
            !Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= Date.now()) {
          lock("Your session or access changed. Reload this page to continue."); return;
        }
        setVerified(true);
      } catch {
        if (mounted.current && generation.current === accessVersion) lock("Your session could not be verified. Reload this page to continue.");
      } finally { clearTimeout(accessTimeout); }
    })();
    const pop = () => {
      const next = viewFromUrl();
      setView(next);
      const previous = memory.current[next];
      if (!previous || performance.now() >= previous.until) void load(next);
    };
    const hide = () => clear();
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
      else void load(selected.current);
    };
    const show = (event: PageTransitionEvent) => { if (event.persisted) { clear(); void load(selected.current); } };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("next-auth");
    const sessionChanged = () => lock("Your session changed. Reload this page to continue.");
    channel?.addEventListener("message", sessionChanged);
    window.addEventListener("popstate", pop);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false; abortReads();
      access.abort(); clearTimeout(accessTimeout);
      window.removeEventListener("popstate", pop);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", visibility);
      channel?.close();
    };
  }, [scope, initial, initialView, clear, load, abortReads, lock]);

  useEffect(() => {
    const entries = Object.values(snapshots).filter((entry): entry is Saved => !!entry && Number.isFinite(entry.until));
    if (!entries.length) return;
    const timeout = setTimeout(() => {
      const now = performance.now();
      setSnapshots((old) => Object.fromEntries(Object.entries(old).filter(([, value]) => value && value.until > now)));
    }, Math.max(0, Math.min(...entries.map((entry) => entry.until)) - performance.now()));
    return () => clearTimeout(timeout);
  }, [snapshots]);

  function navigate(next: AcatWorkspaceView) {
    if (fatal) return;
    if (next !== view) window.history.pushState(null, "", next === "library" ? "/acat-tracking?view=library" : "/acat-tracking");
    setView(next);
    const entry = memory.current[next];
    if ((!entry || performance.now() >= entry.until) && !requests.current[next]) void load(next);
  }
  // An admin save swaps the stored custodian into the shown library and keeps
  // the snapshot's lease, so the value survives a switch to the other view.
  const changeLibrary = (update: (library: CustodianLibraryData) => CustodianLibraryData) => {
    setSnapshots((old) => patchLibrarySnapshot(old, update));
  };
  const entry = snapshots[view];
  const snapshot = verified && !fatal && entry?.response.scope === scope && (entry.until === Infinity || performance.now() < entry.until) ? entry.response.snapshot : null;
  const title = view === "library" ? "Custodian Library" : "Tracked ACATs";
  const status = <p role="status">{snapshot ? <>Last checked <time dateTime={new Date(snapshot.checkedAt).toISOString()}>{new Date(snapshot.checkedAt).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" })}</time> · {view === "library" ? "Stays open for this session. Refresh to load the latest." : "Reused for up to 30 seconds."}</> : fatal || (loading[view] ? `Loading ${title.toLowerCase()}…` : !verified && Object.keys(snapshots).length ? "Checking session…" : errors[view] || "Snapshot expired. Refresh to see current data.")}</p>;
  const refresh = <button className={styles.refresh} type="button" disabled={!!fatal} aria-disabled={!!fatal || !!loading[view]} onClick={() => { if (!loading[view]) void load(view, true); }}>{loading[view] ? "Refreshing…" : "Refresh"}</button>;
  return <>
    <AcatSectionNav current={view} onNavigate={navigate} />
    <section aria-labelledby={view === "library" ? "custodian-library-title" : "tracked-acats-title"}>
      <div className={styles.viewHeader}>
        <h2 ref={heading} tabIndex={-1} id={view === "library" ? "custodian-library-title" : "tracked-acats-title"}>{title}</h2>
        {view === "library" && <nav aria-label="Custodian library source"><a href={EXTERNAL_APPS.acatCustodians} target="_blank" rel="noopener noreferrer">Open library in Tracker ↗</a></nav>}
      </div>
      <p className={styles.description}>{view === "library"
        ? custodianAdmin
          ? "Transfer playbooks, contacts, timing and fees. The Transfer Tracker is the source of truth. Admin changes save there."
          : "Transfer playbooks, contacts, timing and fees. Read only here; the Transfer Tracker is the source of truth."
        : "Every tracker ACAT — linked to a transfer or not — grouped by status. Includes open transfers and those completed recently."}</p>
      {view === "library"
        ? <CustodianLibrary library={snapshot?.view === "library" ? snapshot.data : null} status={status} actions={refresh}
            admin={custodianAdmin} authorityLibrary={authorityLibrary}
            onLibraryChange={custodianAdmin ? changeLibrary : undefined} />
        : <div className={styles.freshness}>{status}{refresh}</div>}
      {view === "tracking" && notice && <p role="status">{notice}</p>}
      {view === "tracking" && unlinkError && <p role="alert">{unlinkError}</p>}
      {snapshot?.view === "tracking" && <AcatTrackingView {...snapshot.data} sourceCheckedAt={snapshot.checkedAt} onUnlinked={() => {
        if (!mounted.current || blocked.current) return;
        setNotice("Transfer unlinked.");
        setUnlinkError("");
        heading.current?.focus();
        // Linkage is freshly read on every request; the unchanged Tracker
        // source rows can retain their normal cache lease.
        void load("tracking");
      }} onUnlinkError={(message) => {
        if (!mounted.current || blocked.current) return;
        setUnlinkError(message);
        if (!message) setNotice("");
      }} />}
    </section>
  </>;
}
