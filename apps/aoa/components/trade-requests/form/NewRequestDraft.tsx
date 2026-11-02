"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  NEW_REQUEST_COPY,
  type NewRequestClientsLoad,
  clientsById,
  initialNewRequestDraft,
  type HouseholdResolveResult,
  type NewRequestClient,
  type NewRequestContext,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";

export type NewRequestClientsState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; clients: NewRequestClient[] }
  | { status: "failed"; message: string }
  | { status: "not_set_up" };

type DraftUpdate = Partial<NewRequestDraft> | ((draft: NewRequestDraft) => NewRequestDraft);

type NewRequestDraftValue = {
  draft: NewRequestDraft;
  updateDraft: (update: DraftUpdate) => void;
  resetDraft: () => void;
  clients: NewRequestClientsState;
  /** Loads the client list once; a failed load is tried again the next time the form mounts. */
  ensureClients: (load: () => Promise<NewRequestClientsLoad>) => void;
  context: NewRequestContext;
  households: HouseholdResolveResult | null;
  setHouseholds: (households: HouseholdResolveResult | null) => void;
};

const NewRequestDraftContext = createContext<NewRequestDraftValue | null>(null);
const NO_CLIENTS = new Map<string, NewRequestClient>();

// Mounted by the workspace frame so the draft survives switching to Home or
// the queue and back (the form itself unmounts). The edit and clone forms
// mount their own provider, seeded from the source request.
export function NewRequestDraftProvider({ children, initialDraft }: { children: React.ReactNode; initialDraft?: NewRequestDraft }) {
  const [draft, setDraft] = useState<NewRequestDraft>(() => initialDraft ?? initialNewRequestDraft());
  const [clients, setClients] = useState<NewRequestClientsState>({ status: "idle" });
  const [households, setHouseholds] = useState<HouseholdResolveResult | null>(null);
  const loading = useRef(false);
  const loaded = useRef(false);

  const updateDraft = useCallback((update: DraftUpdate) => {
    setDraft((current) => (typeof update === "function" ? update(current) : { ...current, ...update }));
  }, []);
  const resetDraft = useCallback(() => {
    setDraft(initialNewRequestDraft());
    setHouseholds(null);
  }, []);

  const ensureClients = useCallback((load: () => Promise<NewRequestClientsLoad>) => {
    if (loading.current || loaded.current) return;
    loading.current = true;
    setClients({ status: "loading" });
    load()
      .then((result) => {
        if (result.ok) {
          loaded.current = true;
          setClients({ status: "loaded", clients: result.clients });
        } else if (result.outcome === "not_set_up") setClients({ status: "not_set_up" });
        else setClients({ status: "failed", message: result.message || NEW_REQUEST_COPY.loadFailedDefault });
      })
      .catch(() => setClients({ status: "failed", message: NEW_REQUEST_COPY.loadFailedDefault }))
      .finally(() => {
        loading.current = false;
      });
  }, []);

  const byId = useMemo(() => (clients.status === "loaded" ? clientsById(clients.clients) : NO_CLIENTS), [clients]);
  const value = useMemo<NewRequestDraftValue>(() => ({
    draft, updateDraft, resetDraft, clients, ensureClients, households, setHouseholds,
    context: { draft, clientsById: byId },
  }), [draft, updateDraft, resetDraft, clients, ensureClients, households, byId]);

  return <NewRequestDraftContext.Provider value={value}>{children}</NewRequestDraftContext.Provider>;
}

export function useNewRequestDraft(): NewRequestDraftValue {
  const value = useContext(NewRequestDraftContext);
  if (!value) throw new Error("useNewRequestDraft must be used inside NewRequestDraftProvider");
  return value;
}
