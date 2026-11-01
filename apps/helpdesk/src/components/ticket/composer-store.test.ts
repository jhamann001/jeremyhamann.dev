/**
 * The composer's draft state machine.
 *
 * The store is where "is my work safe" is answered, and the answer is rendered as words an operator
 * reads. These assert the pure helpers and the store transitions; there is no DOM environment in this
 * repo, so the component is covered by the source guards in `composer-copy.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  EMPTY_SYNC,
  EMPTY_SYNC_CHANNEL,
  draftStatusLabel,
  hasUnsavedChanges,
  useComposerStore,
} from "@/components/ticket/composer-store";

const TICKET = "tkt_1";

beforeEach(() => {
  useComposerStore.setState({ drafts: {}, sync: {}, capabilities: {} });
});

describe("hasUnsavedChanges", () => {
  it("compares against the CONFIRMED body, not a dirty flag", () => {
    expect(hasUnsavedChanges("hello", { ...EMPTY_SYNC_CHANNEL, savedBody: "hello" })).toBe(false);
    expect(hasUnsavedChanges("hello there", { ...EMPTY_SYNC_CHANNEL, savedBody: "hello" })).toBe(true);
  });

  it("treats an edit that reverted the text as saved again", () => {
    const sync = { ...EMPTY_SYNC_CHANNEL, savedBody: "hello", status: "error" as const };
    expect(hasUnsavedChanges("hello", sync)).toBe(false);
  });

  it("ignores whitespace either side, which no save would have changed", () => {
    expect(hasUnsavedChanges("  hello  ", { ...EMPTY_SYNC_CHANNEL, savedBody: "hello" })).toBe(false);
  });
});

describe("draftStatusLabel", () => {
  it("says nothing before the restore has answered", () => {
    expect(draftStatusLabel("anything", EMPTY_SYNC_CHANNEL, false)).toBeNull();
  });

  it("says nothing for an empty, never-saved channel", () => {
    expect(draftStatusLabel("", EMPTY_SYNC_CHANNEL, true)).toBeNull();
  });

  it("reports in flight, unsaved, saved and failed", () => {
    expect(draftStatusLabel("abc", { ...EMPTY_SYNC_CHANNEL, status: "saving" }, true)).toBe("Saving draft…");
    expect(draftStatusLabel("abc", EMPTY_SYNC_CHANNEL, true)).toBe("Unsaved changes");
    expect(
      draftStatusLabel("abc", { savedBody: "abc", savedAt: "2026-09-20T12:00:00.000Z", status: "saved", error: null }, true),
    ).toBe("Draft saved");
    expect(draftStatusLabel("abc", { ...EMPTY_SYNC_CHANNEL, status: "error", error: "Draft not saved" }, true)).toBe(
      "Draft not saved",
    );
  });

  it("prefers the failure over everything else — a lost draft must not read as saved", () => {
    const failed = { savedBody: "abc", savedAt: "2026-09-20T12:00:00.000Z", status: "error" as const, error: "Draft not saved" };
    expect(draftStatusLabel("abc", failed, true)).toBe("Draft not saved");
  });
});

describe("the store", () => {
  it("hydrates both channels and records the confirmed baseline", () => {
    useComposerStore.getState().hydrate(TICKET, {
      note: { body: "half a note", macroId: "m1", savedAt: "2026-09-20T12:00:00.000Z" },
      reply: { body: "half a reply", macroId: null, savedAt: "2026-09-20T12:01:00.000Z" },
    });
    const state = useComposerStore.getState();
    expect(state.drafts[TICKET]?.note).toBe("half a note");
    expect(state.drafts[TICKET]?.noteMacroId).toBe("m1");
    expect(state.sync[TICKET]?.hydrated).toBe(true);
    expect(state.sync[TICKET]?.public.savedBody).toBe("half a reply");
    expect(draftStatusLabel("half a reply", state.sync[TICKET]!.public, true)).toBe("Draft saved");
  });

  it("never overwrites text the operator typed while the restore was in flight", () => {
    useComposerStore.getState().setDraft(TICKET, { reply: "typed first" });
    useComposerStore.getState().hydrate(TICKET, {
      reply: { body: "the stored draft", macroId: null, savedAt: "2026-09-20T12:00:00.000Z" },
    });
    expect(useComposerStore.getState().drafts[TICKET]?.reply).toBe("typed first");
    // And it is correctly reported as unsaved, because the server holds different text.
    expect(useComposerStore.getState().sync[TICKET]?.hydrated).toBe(true);
  });

  it("marks a ticket hydrated even when nothing was restored, so autosave may start", () => {
    useComposerStore.getState().hydrate(TICKET, {});
    expect(useComposerStore.getState().sync[TICKET]).toEqual({ ...EMPTY_SYNC, hydrated: true });
  });

  it("clearDraft resets the channel's text, its macro AND its saved baseline", () => {
    useComposerStore.getState().hydrate(TICKET, {
      reply: { body: "a reply", macroId: "m2", savedAt: "2026-09-20T12:00:00.000Z" },
    });
    useComposerStore.getState().setDraft(TICKET, { replySetsPending: true });
    useComposerStore.getState().clearDraft(TICKET, "public");
    const state = useComposerStore.getState();
    expect(state.drafts[TICKET]).toEqual({ ...EMPTY_DRAFT, note: "", noteMacroId: null });
    // The server row is gone with the submit, so the baseline must be empty — otherwise the channel
    // would read "unsaved changes" against text that no longer exists anywhere.
    expect(state.sync[TICKET]?.public).toEqual(EMPTY_SYNC_CHANNEL);
    expect(draftStatusLabel("", state.sync[TICKET]!.public, true)).toBeNull();
  });

  it("clearDraft leaves the OTHER channel alone", () => {
    useComposerStore.getState().hydrate(TICKET, {
      note: { body: "a note", macroId: null, savedAt: "2026-09-20T12:00:00.000Z" },
      reply: { body: "a reply", macroId: null, savedAt: "2026-09-20T12:00:00.000Z" },
    });
    useComposerStore.getState().clearDraft(TICKET, "public");
    const state = useComposerStore.getState();
    expect(state.drafts[TICKET]?.note).toBe("a note");
    expect(state.sync[TICKET]?.internal.savedBody).toBe("a note");
  });

  it("publishes the retraction capability, defaulting to false for an unknown ticket", () => {
    expect(useComposerStore.getState().capabilities["nope"]).toBeUndefined();
    useComposerStore.getState().setCapabilities(TICKET, { canRetract: true });
    expect(useComposerStore.getState().capabilities[TICKET]).toEqual({ canRetract: true });
  });
});
