/**
 * Composer draft store (decision D4). UI state only.
 *
 * Memory-only zustand: **no `persist`, no browser storage** — the guardrail in MOBILE_FIRST §7 still
 * holds, and Wave B makes it easier to keep rather than harder. Durability now comes from the
 * SERVER: `saveDraft` writes a `ComposerDraft` row per (ticket, user, channel), so a draft survives a
 * closed tab, a different device and a session that timed out — none of which `localStorage` would
 * have survived, and all of which it would have leaked half-written client correspondence into.
 *
 * What lives here is therefore the LIVE state between keystroke and confirmed save:
 *
 *  - `drafts` — the text in the textarea right now, keyed by ticket id, so dismissing the phone
 *    composer sheet (overlay, Escape, X) unmounts the `Composer` without losing what was typed and
 *    the inline composer at `md` shows the same draft.
 *  - `sync` — per channel: whether this ticket's drafts have been loaded from the server yet, the
 *    body the server last confirmed, and the save status. "Unsaved" is `body !== savedBody`, which is
 *    a fact rather than a timer, so it stays correct across a failed save and a refresh.
 *  - `capabilities` — the one fact `CommentItem` needs and cannot obtain. See below.
 *
 * The acknowledgement / disclaimer / confirm state is deliberately NOT here: it is a per-send
 * confirmation and must reset with the component.
 *
 * **Why capabilities live in this store.** `CommentItem` renders the withdraw control for a public
 * reply, which needs `queue:write` on the ticket's queue. The timeline passes it a `CommentDTO` and
 * nothing else, and the ticket page that mounts both is foundation-owned, so there is
 * no prop to thread it through and a client component may not import `@/lib/session`. The
 * `Composer` DOES receive `viewer` and `ticket`, is mounted on every ticket page at every width, and
 * can compute the fact with `canWriteQueue` — an L1 module client components may import. So it
 * publishes it once and `CommentItem` reads it. The default is `false`, so a page without a composer
 * shows no control, and `retractComment` re-checks the capability server-side regardless: this
 * is what the control is *offered* on, never what it is *allowed* on. The cleaner shape — a
 * `canRetract` prop from the page — is filed in the build record.
 */
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";

/** The two composer channels, in the store's own vocabulary (`CommentVisibility` lower-cased). */
export type ComposerChannel = "internal" | "public";

export type ComposerDraft = {
  note: string;
  noteMacroId: string | null;
  reply: string;
  replyMacroId: string | null;
  /** True when the agent chose "Save reply and set Pending client" for this draft. */
  replySetsPending: boolean;
};

export type DraftSaveStatus = "idle" | "saving" | "saved" | "error";

export type DraftSyncState = {
  /** The body the server last confirmed storing. "Unsaved" is the current body differing from this. */
  savedBody: string;
  /** ISO-8601 of that confirmation, or null when nothing has been saved in this session. */
  savedAt: string | null;
  status: DraftSaveStatus;
  /** Set when the last save failed, so the indicator can say so instead of silently reading "idle". */
  error: string | null;
};

export type TicketSyncState = {
  /** False until `loadComposerState` has answered. Nothing autosaves before it does (see below). */
  hydrated: boolean;
  internal: DraftSyncState;
  public: DraftSyncState;
};

/** What a comment row needs to know about the ticket it is on and cannot work out for itself. */
export type TicketCapabilities = { canRetract: boolean };

export type ComposerStore = {
  /** keyed by ticket id */
  drafts: Record<string, ComposerDraft>;
  /** keyed by ticket id */
  sync: Record<string, TicketSyncState>;
  /** keyed by ticket id */
  capabilities: Record<string, TicketCapabilities>;
  setDraft(ticketId: string, patch: Partial<ComposerDraft>): void;
  clearDraft(ticketId: string, channel: ComposerChannel): void;
  /**
   * Seeds both channels from the server's stored drafts and marks the ticket hydrated.
   *
   * Only fills a channel whose in-memory body is still empty: if the operator started typing while
   * the round trip was in flight, their keystrokes win. Losing a sentence to a race with a restore is
   * exactly the failure this whole feature exists to prevent.
   */
  hydrate(ticketId: string, restored: { note?: RestoredDraft; reply?: RestoredDraft }): void;
  setSync(ticketId: string, channel: ComposerChannel, patch: Partial<DraftSyncState>): void;
  setCapabilities(ticketId: string, capabilities: TicketCapabilities): void;
};

export type RestoredDraft = { body: string; macroId: string | null; savedAt: string };

export const EMPTY_DRAFT: ComposerDraft = {
  note: "",
  noteMacroId: null,
  reply: "",
  replyMacroId: null,
  replySetsPending: false,
};

export const EMPTY_SYNC_CHANNEL: DraftSyncState = { savedBody: "", savedAt: null, status: "idle", error: null };

export const EMPTY_SYNC: TicketSyncState = {
  hydrated: false,
  internal: EMPTY_SYNC_CHANNEL,
  public: EMPTY_SYNC_CHANNEL,
};

export const NO_CAPABILITIES: TicketCapabilities = { canRetract: false };

export const useComposerStore: UseBoundStore<StoreApi<ComposerStore>> = create<ComposerStore>()((set) => ({
  drafts: {},
  sync: {},
  capabilities: {},

  setDraft: (ticketId, patch) =>
    set((state) => ({
      drafts: { ...state.drafts, [ticketId]: { ...(state.drafts[ticketId] ?? EMPTY_DRAFT), ...patch } },
    })),

  clearDraft: (ticketId, channel) =>
    set((state) => {
      const current = state.drafts[ticketId] ?? EMPTY_DRAFT;
      const next: ComposerDraft =
        channel === "internal"
          ? { ...current, note: "", noteMacroId: null }
          : { ...current, reply: "", replyMacroId: null, replySetsPending: false };
      const sync = state.sync[ticketId] ?? EMPTY_SYNC;
      // The server row is gone too (submit clears it in the comment's transaction; discard deletes
      // it), so the saved baseline goes back to empty and the channel reads "no draft" rather than
      // "unsaved changes" against a body that no longer exists.
      return {
        drafts: { ...state.drafts, [ticketId]: next },
        sync: { ...state.sync, [ticketId]: { ...sync, [channel]: { ...EMPTY_SYNC_CHANNEL } } },
      };
    }),

  hydrate: (ticketId, restored) =>
    set((state) => {
      const current = state.drafts[ticketId] ?? EMPTY_DRAFT;
      const sync = state.sync[ticketId] ?? EMPTY_SYNC;
      const note = current.note.length === 0 && restored.note ? restored.note : null;
      const reply = current.reply.length === 0 && restored.reply ? restored.reply : null;
      return {
        drafts: {
          ...state.drafts,
          [ticketId]: {
            ...current,
            ...(note ? { note: note.body, noteMacroId: note.macroId } : {}),
            ...(reply ? { reply: reply.body, replyMacroId: reply.macroId } : {}),
          },
        },
        sync: {
          ...state.sync,
          [ticketId]: {
            hydrated: true,
            internal: note
              ? { savedBody: note.body, savedAt: note.savedAt, status: "saved", error: null }
              : sync.internal,
            public: reply ? { savedBody: reply.body, savedAt: reply.savedAt, status: "saved", error: null } : sync.public,
          },
        },
      };
    }),

  setSync: (ticketId, channel, patch) =>
    set((state) => {
      const sync = state.sync[ticketId] ?? EMPTY_SYNC;
      return { sync: { ...state.sync, [ticketId]: { ...sync, [channel]: { ...sync[channel], ...patch } } } };
    }),

  setCapabilities: (ticketId, capabilities) =>
    set((state) => ({ capabilities: { ...state.capabilities, [ticketId]: capabilities } })),
}));

/**
 * Pure: is there text the server has not confirmed?
 *
 * Compared against the CONFIRMED body rather than against a "dirty" flag, so a save that failed, a
 * save that is still in flight and an edit that reverted the text all answer correctly.
 */
export function hasUnsavedChanges(body: string, sync: DraftSyncState): boolean {
  return body.trim() !== sync.savedBody.trim();
}

/** The indicator's words. Pure, so `composer-store.test.ts` can assert every branch. */
export function draftStatusLabel(body: string, sync: DraftSyncState, hydrated: boolean): string | null {
  if (!hydrated) return null;
  if (sync.status === "error") return sync.error ?? "Draft not saved";
  if (sync.status === "saving") return "Saving draft…";
  if (hasUnsavedChanges(body, sync)) return body.trim().length === 0 ? null : "Unsaved changes";
  if (sync.savedAt !== null && sync.savedBody.trim().length > 0) return "Draft saved";
  return null;
}
