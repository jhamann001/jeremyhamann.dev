"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import { Button, SectionLabel } from "@/components/ui";
import { IconBell } from "@/components/icons";
import {
  BELL_COPY, fetchBellNotifications, postBellMarkAllRead, postBellMarkRead, type BellNotificationList,
} from "@/lib/trade-requests/notifications-model";
import { useSessionMessages } from "./session-messages";
import styles from "@/components/shell/Topbar.module.css";

export const BELL_REFRESH_MS = 30_000;

/** "checking" until a load answers; "unavailable" only while no load has succeeded since the page loaded. */
type Phase = "checking" | "unavailable" | "loaded";
type State = { phase: Phase } & BellNotificationList;

type BellStore = State & {
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
};

// A successful mark, replayed onto any load that started before it succeeded.
type Mark = { seq: number; ids: ReadonlySet<string>; all: boolean };

function applyMark(list: BellNotificationList, mark: Mark): BellNotificationList {
  let cleared = 0;
  const notifications = list.notifications.map((item) => {
    if (item.isRead || !mark.ids.has(item.id)) return item;
    cleared += 1;
    return { ...item, isRead: true };
  });
  const unreadCount = mark.all
    ? notifications.filter((item) => !item.isRead).length
    : Math.max(0, list.unreadCount - cleared);
  return { notifications, unreadCount };
}

const BellContext = createContext<BellStore | null>(null);

/**
 * Mounted by the authenticated layout above the bell's Suspense boundary, and
 * only for workspace roles while the epic flag is on, so the roster fallback
 * swap and in-shell navigation keep the list and a full page load starts over.
 */
export function TradeRequestNotificationsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ phase: "checking", notifications: [], unreadCount: 0 });
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const marks = useRef<Mark[]>([]);
  const markSeq = useRef(0);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const startedAfter = markSeq.current;
    let stale = false;
    try {
      const list = await fetchBellNotifications();
      if (!mounted.current) return;
      if (!list) {
        setState((current) => (current.phase === "checking" ? { ...current, phase: "unavailable" } : current));
        return;
      }
      marks.current = marks.current.filter((mark) => mark.seq > startedAfter);
      stale = marks.current.length > 0;
      setState({ phase: "loaded", ...marks.current.reduce(applyMark, list) });
    } finally {
      inFlight.current = false;
    }
    // This answer predates a successful mark, so the mark's own reload was skipped.
    if (stale && mounted.current) void load();
  }, []);

  const recordMark = useCallback((ids: ReadonlySet<string>, all: boolean) => {
    markSeq.current += 1;
    const mark = { seq: markSeq.current, ids, all };
    marks.current = [...marks.current, mark];
    setState((current) => (current.phase === "loaded" ? { phase: "loaded", ...applyMark(current, mark) } : current));
    if (!inFlight.current) void load();
  }, [load]);

  const markRead = useCallback(async (id: string) => {
    if (!(await postBellMarkRead(id)) || !mounted.current) return;
    recordMark(new Set([id]), false);
  }, [recordMark]);

  const markAllRead = useCallback(async () => {
    const shown = new Set(stateRef.current.notifications.map((item) => item.id));
    if (!(await postBellMarkAllRead()) || !mounted.current) return;
    recordMark(shown, true);
  }, [recordMark]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), BELL_REFRESH_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load]);

  const store = useMemo(() => ({ ...state, markRead, markAllRead }), [state, markRead, markAllRead]);
  return <BellContext.Provider value={store}>{children}</BellContext.Provider>;
}

const noSubscription = () => () => {};

/**
 * The bell as the server rendered it ("checking", nothing unread) until this part has hydrated. The provider sits
 * above the roster's Suspense boundary, so its first load can answer before the bell inside that boundary hydrates;
 * rendering the loaded list then would not match the server's HTML (React error #418).
 */
function useBell(): BellStore {
  const store = useContext(BellContext);
  if (!store) throw new Error("useBell must be used inside TradeRequestNotificationsProvider");
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  return hydrated ? store : { ...store, phase: "checking", notifications: [], unreadCount: 0 };
}

/** Open roster reminders + unread service notifications + session messages, counting only sources with data. */
function useOpenCount(rosterOpen: number): number {
  const bell = useBell();
  const { messages } = useSessionMessages();
  return rosterOpen + (bell.phase === "loaded" ? bell.unreadCount : 0) + messages.length;
}

export function BellSummary({ rosterOpen }: { rosterOpen: number }) {
  const open = useOpenCount(rosterOpen);
  return (
    <summary className={styles.iconBtn} aria-label={open > 0 ? `Notifications, ${open} open` : "Notifications"}>
      <IconBell />
      {open > 0 && <span className={styles.notificationCount}>{open}</span>}
    </summary>
  );
}

export function BellOpenCount({ rosterOpen }: { rosterOpen: number }) {
  return <span>{`${useOpenCount(rosterOpen)} open`}</span>;
}

function BellItem({ message, date, unread, onSelect }: { message: string; date: string; unread: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`${styles.bellItem} ${unread ? styles.bellUnread : styles.bellRead}`} onClick={onSelect}>
      {unread && <em className={styles.srOnly}>Unread</em>}
      <span>{message}</span>
      <time dateTime={date}>{new Date(date).toLocaleString()}</time>
    </button>
  );
}

/** Session messages first, then the service notifications; selecting an item never leaves the page. */
export function TradeRequestGroup() {
  const bell = useBell();
  const sessionMessages = useSessionMessages();
  const markAllRead = () => {
    sessionMessages.clear();
    void bell.markAllRead();
  };
  return (
    <section className={styles.notificationSection} aria-label={BELL_COPY.heading}>
      <div className={styles.bellGroupHeading}>
        <SectionLabel>{BELL_COPY.heading}</SectionLabel>
        <Button variant="ghost" size="sm" onClick={markAllRead}>{BELL_COPY.markAllRead}</Button>
      </div>
      {sessionMessages.messages.map((item) => (
        <BellItem key={item.id} message={item.message} date={item.date} unread onSelect={() => sessionMessages.markRead(item.id)} />
      ))}
      {bell.phase === "checking" ? (
        <p className={styles.notificationEmpty} role="status">{BELL_COPY.checking}</p>
      ) : bell.phase === "unavailable" ? (
        <p className={styles.notificationEmpty} role="status">{BELL_COPY.unavailable}</p>
      ) : bell.notifications.length === 0 && sessionMessages.messages.length === 0 ? (
        <p className={styles.notificationEmpty}>{BELL_COPY.empty}</p>
      ) : bell.notifications.map((item) => (
        <BellItem key={item.id} message={item.message} date={item.date} unread={!item.isRead} onSelect={() => { if (!item.isRead) void bell.markRead(item.id); }} />
      ))}
    </section>
  );
}
