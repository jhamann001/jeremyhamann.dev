"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * A warning or failure raised in the current browser session (epic Business
 * Rules → Session messages). The Trade Request service never stores these.
 */
export type SessionMessage = { id: string; message: string; date: string };

export type SessionMessageStore = {
  /** Newest first. */
  messages: readonly SessionMessage[];
  /**
   * Adds a message at the top of the list; returns its id. Writers pass only
   * fixed copy or a sanitized reason (the epic's session-message texts): never
   * tokens, client PII or raw upstream response bodies. The text is rendered
   * as plain text in the bell and is never sent anywhere.
   */
  add: (message: string) => string;
  /** Selecting a session message in the bell removes it. */
  markRead: (id: string) => void;
  /** Removes every session message (Mark all read). */
  clear: () => void;
};

const SessionMessagesContext = createContext<SessionMessageStore | null>(null);

/**
 * Mounted once by the authenticated layout, so messages survive in-shell
 * navigation and are lost on a full page load. Signing out leaves the layout,
 * which unmounts the store; the layout also keys it by the signed-in user.
 */
export function SessionMessagesProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const sequence = useRef(0);

  const add = useCallback((message: string) => {
    sequence.current += 1;
    const id = `session-message-${sequence.current}`;
    const date = new Date().toISOString();
    setMessages((current) => [{ id, message, date }, ...current]);
    return id;
  }, []);
  const markRead = useCallback((id: string) => {
    setMessages((current) => current.filter((item) => item.id !== id));
  }, []);
  const clear = useCallback(() => setMessages([]), []);

  const store = useMemo(() => ({ messages, add, markRead, clear }), [messages, add, markRead, clear]);
  return <SessionMessagesContext.Provider value={store}>{children}</SessionMessagesContext.Provider>;
}

export function useSessionMessages(): SessionMessageStore {
  const store = useContext(SessionMessagesContext);
  if (!store) throw new Error("useSessionMessages must be used inside SessionMessagesProvider");
  return store;
}
