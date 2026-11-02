import { describe, expect, it } from "vitest";
import {
  CLIENT_LINK_COPY,
  afterStateBadge,
  batchLine,
  buildBackfillDraft,
  buildLinkDraft,
  canBulk,
  canRetryLookup,
  clientLinkCapabilities,
  clientLinkDate,
  clientLinkReducer,
  directoryQueriedLine,
  draftReducer,
  failureView,
  folderChangeViews,
  folderDiffers,
  holderConflicts,
  initialClientLinkState,
  initialDraft,
  isPreviewExpired,
  isUnlinking,
  linkMethodView,
  lookupNotice,
  openRunTarget,
  previewRunLabel,
  queueFilterCounts,
  queueStats,
  reviewStateTone,
  selectAllToggles,
  selectAllView,
  suggestionView,
  toggleFolder,
  type FolderSelection,
} from "@/components/asset-mapping/workspace/client-linking/client-link-model";
import type {
  ClientLinkFolderChange,
  ClientLinkIdentity,
  ClientLinkLookup,
  ClientLinkLookupState,
  ClientLinkPreview,
  ClientLinkQueueItem,
  RunClientLink,
} from "@/lib/data/asset-map-client-link-contract";

const RUN = "11111111-1111-4111-8111-111111111111";
const P1 = { user_id: "synthetic-person-1", display_name: "Synthetic Person One" };
const P2 = { user_id: "synthetic-person-2", display_name: "Synthetic Person Two" };
const SCOPE = { source_system: "google_drive" as const, source_folder_id: "synthetic-folder" };

function identity(over: Partial<ClientLinkIdentity> = {}): ClientLinkIdentity {
  return {
    decision_id: null, people: [], coverage: "partial", primary_user_id: null, cedar_ridge_user_id: null,
    review_state: "unresolved", method: null, conflict_flags: [], ...over,
  };
}

function lookup(over: Partial<ClientLinkLookup> = {}): ClientLinkLookup {
  return { state: "ready", suggestion: null, directory: null, error_code: null, message: null, ...over };
}

function run(over: Partial<RunClientLink> = {}): RunClientLink {
  return {
    run_id: RUN, identity: identity(), lookup: lookup(), holder_evidence: [], folder: null, events: [],
    identity_version: 3, source_scope: SCOPE, ...over,
  };
}

function item(key: string, over: Partial<ClientLinkQueueItem> = {}): ClientLinkQueueItem {
  return {
    scope_key: key,
    source_scope: { source_system: "google_drive", source_folder_id: key },
    representative_run_id: RUN,
    client_name: "Synthetic Client",
    run_count: 4,
    unlinked_run_count: 1,
    folder: {
      source_scope: { source_system: "google_drive", source_folder_id: key },
      revision: 2,
      decision: identity({ people: [P1], review_state: "complete", coverage: "complete" }),
      reuse_future: true,
    },
    review_state: "complete",
    lookup_state: "ready",
    bulk_eligible: true,
    exceptions: [],
    ...over,
  };
}

function preview(over: Partial<ClientLinkPreview> = {}): ClientLinkPreview {
  return {
    preview_id: "33333333-3333-4333-8333-333333333333", kind: "confirm", payload_hash: "synthetic-hash",
    expires_at: "2026-10-04T12:00:00Z", acknowledgement: "Synthetic acknowledgement.", targets: [], exclusions: [], ...over,
  };
}

const LOADED = { ...initialClientLinkState(), config: { enabled: true, writesEnabled: true } };
const BATCH = { batch_id: "22222222-2222-4222-8222-222222222222", applied: 2, unchanged: 1, excluded: 0, kind: "confirm" as const };

describe("client-link model", () => {
  it("computes the four queue counts from the loaded page", () => {
    const page = { items: [item("a"), item("b", { review_state: "partial", bulk_eligible: false })], total: 7, next_cursor: null };
    expect(queueStats(page)).toEqual({ folders: 7, readyToBackfill: 1, complete: 1, coverage: { linked: 6, runs: 8 } });
    expect(queueStats({ items: [], total: 0, next_cursor: null }).coverage).toEqual({ linked: 0, runs: 0 });
  });

  it("treats a folder as bulk-ready only when complete, verified, and conflict-free", () => {
    expect(canBulk(item("a"))).toBe(true);
    expect(canBulk(item("a", { bulk_eligible: false }))).toBe(false);
    expect(canBulk(item("a", { source_scope: null }))).toBe(false);
    expect(canBulk(item("a", { folder: null }))).toBe(false);
    const folder = (decision: ClientLinkIdentity) => ({ source_scope: SCOPE, revision: 1, decision, reuse_future: true });
    expect(canBulk(item("a", { folder: folder(identity({ people: [P1], review_state: "partial" })) }))).toBe(false);
    expect(canBulk(item("a", {
      folder: folder(identity({ people: [P1], review_state: "complete", conflict_flags: ["holder_mismatch"] })),
    }))).toBe(false);
  });

  it("caps the backfill selection at 100 folders", () => {
    let selection: FolderSelection = new Map();
    for (let i = 0; i < 101; i++) selection = toggleFolder(selection, item(`f-${i}`));
    expect(selection.size).toBe(100);
    selection = toggleFolder(selection, item("f-0"));
    expect(selection.size).toBe(99);
    expect(toggleFolder(new Map(), item("x", { bulk_eligible: false })).size).toBe(0);
  });

  it("builds a backfill draft from the selected folders", () => {
    const selection = toggleFolder(toggleFolder(new Map(), item("a")), item("b"));
    expect(buildBackfillDraft(selection)).toEqual({
      action: "backfill",
      target_scope: "bulk",
      folder_targets: [
        { source_scope: { source_system: "google_drive", source_folder_id: "a" }, expected_revision: 2 },
        { source_scope: { source_system: "google_drive", source_folder_id: "b" }, expected_revision: 2 },
      ],
      reason: "Reviewed historical backfill",
    });
  });

  it("caps the people selection at 20", () => {
    let draft = initialDraft(run());
    for (let i = 0; i < 21; i++) {
      draft = draftReducer(draft, { type: "togglePerson", person: { user_id: `p-${i}`, display_name: `Synthetic ${i}` } });
    }
    expect(draft.people).toHaveLength(20);
    draft = draftReducer(draft, { type: "togglePerson", person: { user_id: "p-0", display_name: "Synthetic 0" } });
    expect(draft.people).toHaveLength(19);
  });

  it("offers removal preview when every accepted person is cleared", () => {
    const linked = run({ identity: identity({ decision_id: "d-1", people: [P1], primary_user_id: P1.user_id, review_state: "complete" }) });
    let draft = initialDraft(linked);
    expect(isUnlinking(linked, draft)).toBe(false);
    draft = draftReducer(draft, { type: "togglePerson", person: P1 });
    expect(draft.primary).toBeNull();
    expect(isUnlinking(linked, draft)).toBe(true);
    expect(buildLinkDraft(linked, draft)).toMatchObject({ action: "unlink", people_ids: [], primary_user_id: null, reuse_future: false });
  });

  it("builds a confirm draft with coverage, primary, scope, reuse, and note", () => {
    const r = run({ folder: { source_scope: SCOPE, revision: 5, decision: identity(), reuse_future: false } });
    let draft = initialDraft(r);
    draft = draftReducer(draft, { type: "togglePerson", person: P1 });
    draft = draftReducer(draft, { type: "togglePerson", person: P2 });
    draft = draftReducer(draft, { type: "setPrimary", userId: P2.user_id });
    draft = draftReducer(draft, { type: "setCoverage", coverage: "complete" });
    draft = draftReducer(draft, { type: "setScope", scope: "all_existing" });
    draft = draftReducer(draft, { type: "setReuse", reuse: true });
    draft = draftReducer(draft, { type: "setNote", note: "  Synthetic evidence  " });
    expect(buildLinkDraft(r, draft)).toEqual({
      action: "confirm",
      run_id: RUN,
      target_scope: "all_existing",
      expected_identity_version: 3,
      expected_folder_revision: 5,
      folder_targets: [],
      people_ids: [P1.user_id, P2.user_id],
      coverage: "complete",
      primary_user_id: P2.user_id,
      reuse_future: true,
      reason: "Synthetic evidence",
    });
  });

  it("copies the saved folder people into the draft", () => {
    const folder = identity({ people: [P1, P2], coverage: "complete", primary_user_id: P1.user_id, review_state: "complete" });
    const draft = draftReducer(initialDraft(run()), { type: "usePeople", folder });
    expect(draft.people).toEqual([P1, P2]);
    expect(draft.coverage).toBe("complete");
    expect(draft.primary).toBe(P1.user_id);
  });

  it("detects a folder association that differs from the run", () => {
    const folder = { source_scope: SCOPE, revision: 1, decision: identity({ people: [P1], coverage: "complete" as const }), reuse_future: true };
    expect(folderDiffers(run({ folder }))).toBe(true);
    expect(folderDiffers(run({ folder, identity: identity({ people: [P1], coverage: "complete" }) }))).toBe(false);
    expect(folderDiffers(run())).toBe(false);
  });

  it("blocks apply when the preview has expired", () => {
    const p = preview();
    expect(isPreviewExpired(p, Date.parse("2026-10-04T11:59:59Z"))).toBe(false);
    expect(isPreviewExpired(p, Date.parse("2026-10-04T12:00:00Z"))).toBe(true);
  });

  it("maps stale codes to the needs-another-review text", () => {
    const view = failureView({ reason: "stale", message: "Synthetic stale message." });
    expect(view).toEqual({ title: CLIENT_LINK_COPY.staleTitle, message: "Synthetic stale message.", stale: true, retry: false });
  });

  it("shows the service message for a rejected apply", () => {
    expect(failureView({ reason: "rejected", message: "Too many folders." })).toEqual({
      title: CLIENT_LINK_COPY.failedTitle, message: "Too many folders.", stale: false, retry: false,
    });
    expect(failureView({ reason: "unavailable", message: null }).retry).toBe(true);
  });

  it("keeps the last accepted link when an apply is rejected", () => {
    const linked = run({ identity: identity({ people: [P1], review_state: "complete" }) });
    let state = clientLinkReducer(LOADED, { type: "runLoaded", run: linked });
    state = clientLinkReducer(state, { type: "previewReady", preview: preview() });
    state = clientLinkReducer(state, { type: "applyStarted" });
    state = clientLinkReducer(state, { type: "applyRejected", failure: failureView({ reason: "rejected", message: "No." }) });
    expect(state.run).toBe(linked);
    expect(state.applying).toBe(false);
    expect(state.failure?.message).toBe("No.");
    expect(state.reloadRun).toBe(false);
  });

  it("keeps the same preview for a retry after an uncertain apply", () => {
    const p = preview();
    let state = clientLinkReducer(LOADED, { type: "previewReady", preview: p });
    state = clientLinkReducer(state, { type: "applyStarted" });
    state = clientLinkReducer(state, { type: "applyUncertain" });
    expect(state.preview).toBe(p);
    expect(state.uncertain).toBe(true);
    expect(state.applying).toBe(false);
  });

  it("stores the apply result and requests a run and queue reload", () => {
    let state = clientLinkReducer(LOADED, { type: "previewReady", preview: preview() });
    state = clientLinkReducer(state, { type: "applyConfirmed", result: BATCH });
    expect(state).toMatchObject({ preview: null, result: BATCH, reloadRun: true, reloadQueue: true, uncertain: false });
    state = clientLinkReducer(state, { type: "reloadsHandled" });
    expect(state).toMatchObject({ reloadRun: false, reloadQueue: false, result: BATCH });
  });

  it("shows the writes-disabled text and hides review controls when writes are off", () => {
    expect(clientLinkCapabilities(true, { enabled: true, writesEnabled: false })).toEqual({ visible: true, canReview: false, writesDisabled: true });
    const state = clientLinkReducer(LOADED, { type: "writesDisabled" });
    expect(clientLinkCapabilities(true, state.config)).toEqual({ visible: true, canReview: false, writesDisabled: true });
    expect(failureView({ reason: "writes_disabled", message: "Service text." }).message).toBe(CLIENT_LINK_COPY.writesDisabled);
  });

  it("hides the tab and card when client linking is off", () => {
    const hidden = { visible: false, canReview: false, writesDisabled: false };
    expect(clientLinkCapabilities(false, { enabled: true, writesEnabled: true })).toEqual(hidden);
    expect(clientLinkCapabilities(true, { enabled: false, writesEnabled: true })).toEqual(hidden);
    expect(clientLinkCapabilities(true, null)).toEqual(hidden);
    const failed = clientLinkReducer(initialClientLinkState(), { type: "configLoaded", config: null });
    expect(clientLinkCapabilities(true, failed.config)).toEqual(hidden);
    const disabled = clientLinkReducer(LOADED, { type: "disabled" });
    expect(clientLinkCapabilities(true, disabled.config)).toEqual(hidden);
  });

  it("a read-only role views but never reviews, and sees no disabled notice while writes are on (ticket)", () => {
    expect(clientLinkCapabilities(true, { enabled: true, writesEnabled: true }, false)).toEqual({ visible: true, canReview: false, writesDisabled: false });
    expect(clientLinkCapabilities(true, { enabled: true, writesEnabled: false }, false)).toEqual({ visible: true, canReview: false, writesDisabled: true });
    expect(clientLinkCapabilities(true, { enabled: true, writesEnabled: true }, true)).toEqual({ visible: true, canReview: true, writesDisabled: false });
  });

  it("keeps the queue error with a retry when the queue cannot load", () => {
    const unavailable = failureView({ reason: "unavailable", message: null });
    const first = Symbol("first");
    let state = clientLinkReducer(LOADED, { type: "queueLoading", request: first });
    state = clientLinkReducer(state, { type: "queueFailed", request: first, failure: unavailable });
    expect(state.queueStatus).toBe("failed");
    expect(state.queueFailure?.retry).toBe(true);
    const retry = Symbol("retry");
    state = clientLinkReducer(state, { type: "queueLoading", request: retry });
    expect(state.queueFailure).toBeNull();
    expect(clientLinkReducer(state, { type: "queueFailed", request: first, failure: unavailable })).toBe(state);
  });

  it("appends the next page without duplicate folders", () => {
    const first = Symbol("first");
    const more = Symbol("more");
    let state = clientLinkReducer(LOADED, { type: "queueLoading", request: first });
    state = clientLinkReducer(state, { type: "queueLoaded", request: first, page: { items: [item("a"), item("b")], total: 3, next_cursor: "c-1" }, append: false });
    state = clientLinkReducer(state, { type: "queueLoading", request: more });
    state = clientLinkReducer(state, { type: "queueLoaded", request: more, page: { items: [item("b"), item("c")], total: 3, next_cursor: null }, append: true });
    expect(state.page.items.map((i) => i.scope_key)).toEqual(["a", "b", "c"]);
    expect(state.page.next_cursor).toBeNull();
    const late = Symbol("late");
    const filtered = Symbol("filtered");
    state = clientLinkReducer(state, { type: "queueLoading", request: late });
    state = clientLinkReducer(state, { type: "queueLoading", request: filtered });
    state = clientLinkReducer(state, { type: "queueLoaded", request: filtered, page: { items: [item("z")], total: 1, next_cursor: null }, append: false });
    const stale = clientLinkReducer(state, { type: "queueLoaded", request: late, page: { items: [item("d")], total: 9, next_cursor: "c-2" }, append: true });
    expect(stale).toBe(state);
    expect(stale.page.items.map((i) => i.scope_key)).toEqual(["z"]);
  });

  it("offers lookup retry only for unavailable, stale, not-attempted, or pending", () => {
    const retryable: ClientLinkLookupState[] = ["unavailable", "stale", "not_attempted", "pending"];
    expect(retryable.every(canRetryLookup)).toBe(true);
    expect(canRetryLookup("ready")).toBe(false);
  });

  it("describes unavailable, pending, and stale directory states", () => {
    expect(lookupNotice(lookup({ state: "unavailable" }))?.title).toBe(CLIENT_LINK_COPY.directoryUnavailable);
    expect(lookupNotice(lookup({ state: "pending" }))?.title).toBe(CLIENT_LINK_COPY.directoryPending);
    const stale = { freshness: "stale" as const, complete: true, eligibility_verified: true, fetched_at: "2026-10-04T00:00:00Z", source_as_of: null };
    expect(lookupNotice(lookup({ state: "stale", directory: stale }))?.title).toBe(CLIENT_LINK_COPY.directoryStale);
    expect(lookupNotice(lookup({ directory: { ...stale, freshness: "fresh", eligibility_verified: false } }))?.title)
      .toBe(CLIENT_LINK_COPY.directoryUnverified);
    expect(lookupNotice(lookup({ directory: { ...stale, freshness: "fresh" } }))).toBeNull();
  });

  it("lists holder-evidence conflict flags", () => {
    expect(holderConflicts(run({ identity: identity({ review_state: "conflict", conflict_flags: ["holder_mismatch"] }) })))
      .toEqual(["holder_mismatch"]);
    expect(holderConflicts(run())).toBeNull();
  });

  it("shows suggested people before review", () => {
    const view = suggestionView(lookup({
      suggestion: {
        kind: "ambiguous",
        candidates: [
          { ...P1, match_kind: "exact", evidence: ["name"], eligible: true },
          { ...P2, match_kind: "partial", evidence: ["email"], eligible: true },
        ],
        evidence: ["name"],
        conflict_flags: [],
      },
    }));
    expect(view).toEqual({ title: CLIENT_LINK_COPY.suggestionAmbiguous, people: [P1, P2], evidence: ["name", "email"] });
    expect(suggestionView(lookup())).toBeNull();
  });

  it("opens a loaded run and reports a run that is not loaded yet", () => {
    expect(openRunTarget([{ id: RUN }], RUN)).toBe("select");
    expect(openRunTarget([{ id: RUN }], "44444444-4444-4444-8444-444444444444")).toBe("not_loaded");
  });

  it("formats the batch result line", () => {
    expect(batchLine({ applied: 2, unchanged: 1, excluded: 0 })).toBe("2 runs updated · 1 unchanged · 0 excluded.");
    expect(batchLine({ applied: 1, unchanged: 0, excluded: 3 })).toBe("1 run updated · 0 unchanged · 3 excluded.");
  });

  it("queueFilterCounts sums All only when every review state total is known", () => {
    expect(queueFilterCounts({ unresolved: 2, partial: 0, complete: 5, conflict: 1 })).toEqual({ all: 8, unresolved: 2, partial: 0, complete: 5, conflict: 1 });
    expect(queueFilterCounts({ unresolved: 2 })).toEqual({ all: null, unresolved: 2, partial: null, complete: null, conflict: null });
    expect(queueFilterCounts({}).all).toBeNull();
  });

  it("reviewStateTone gives each review state a distinct tone", () => {
    expect((["unresolved", "partial", "complete", "conflict"] as const).map(reviewStateTone)).toEqual(["attention", "caution", "ok", "danger"]);
  });

  it("select-all selects loaded eligible folders up to 100 and clears them on the second press", () => {
    const items = [
      ...Array.from({ length: 150 }, (_, i) => item(`f-${i}`)),
      item("x-1", { bulk_eligible: false }),
      item("x-2", { source_scope: null }),
    ];
    const empty: FolderSelection = new Map();
    const press = (s: FolderSelection) => selectAllToggles(items, s).reduce(toggleFolder, s);
    const selected = press(empty);
    expect(selected.size).toBe(100);
    expect([...selected.keys()]).toEqual(Array.from({ length: 100 }, (_, i) => `f-${i}`));
    expect(selectAllView(items, selected)).toEqual({ checked: true, disabled: false });
    const cleared = press(selected);
    expect(cleared.size).toBe(0);
    expect(selectAllView(items, cleared)).toEqual({ checked: false, disabled: false });
    const few = [item("a"), item("b"), item("c", { bulk_eligible: false })];
    const fewSelected = selectAllToggles(few, empty).reduce(toggleFolder, empty);
    expect([...fewSelected.keys()]).toEqual(["a", "b"]);
    expect(selectAllView(few, fewSelected).checked).toBe(true);
    expect(selectAllToggles(few, fewSelected).reduce(toggleFolder, fewSelected).size).toBe(0);
  });

  it("select-all is disabled with no loaded eligible folder and selects nothing", () => {
    const items = [item("x", { bulk_eligible: false }), item("y", { folder: null })];
    const empty: FolderSelection = new Map();
    expect(selectAllView(items, empty)).toEqual({ checked: false, disabled: true });
    expect(selectAllToggles(items, empty)).toEqual([]);
  });

  it("select-all tops up a partial selection without passing 100", () => {
    const items = Array.from({ length: 150 }, (_, i) => item(`f-${i}`));
    let selection: FolderSelection = new Map();
    for (let i = 0; i < 98; i++) selection = toggleFolder(selection, items[i]);
    const toggles = selectAllToggles(items, selection);
    expect(toggles.map((i) => i.scope_key)).toEqual(["f-98", "f-99"]);
    expect(toggles.reduce(toggleFolder, selection).size).toBe(100);
  });

  it("link method names how the link was made and never labels an inherited link accepted on this run", () => {
    const linked = (method: ClientLinkIdentity["method"]) => identity({ people: [P1], method });
    expect(linkMethodView(linked("inherited"))).toEqual({ label: CLIENT_LINK_COPY.methodInherited, acceptedHere: false });
    expect(linkMethodView(linked("manual"))).toEqual({ label: CLIENT_LINK_COPY.methodManual, acceptedHere: true });
    expect(linkMethodView(linked("backfill"))).toEqual({ label: CLIENT_LINK_COPY.methodBackfill, acceptedHere: true });
    expect(linkMethodView(linked("revert"))).toEqual({ label: CLIENT_LINK_COPY.methodRevert, acceptedHere: true });
    expect(linkMethodView(linked(null))).toEqual({ label: CLIENT_LINK_COPY.methodUnknown, acceptedHere: false });
    expect(linkMethodView(identity({ method: "manual" }))).toBeNull();
  });

  it("preview run label shows Run N, or Previous run for an earlier run", () => {
    expect(previewRunLabel({ run_number: 3, is_historical: false })).toBe("Run 3");
    expect(previewRunLabel({ run_number: 1, is_historical: true })).toBe(CLIENT_LINK_COPY.previousRun);
    expect(previewRunLabel({ run_number: undefined as unknown as number, is_historical: false })).toBe(CLIENT_LINK_COPY.runNumberMissing);
  });

  it("after-state badge comes from the after identity's review state", () => {
    expect(afterStateBadge({ after: identity({ review_state: "complete" }) })).toBe("complete");
    expect(afterStateBadge({ after: { ...identity(), review_state: undefined } as unknown as ClientLinkIdentity })).toBeNull();
  });

  it("directory queried-at line uses directory.fetched_at", () => {
    const at = "2026-10-04T09:30:00Z";
    const directory = { freshness: "fresh" as const, complete: true, eligibility_verified: true, fetched_at: at, source_as_of: null };
    expect(directoryQueriedLine(preview({ directory }))).toBe(`${CLIENT_LINK_COPY.directoryQueried} ${clientLinkDate(at)}`);
    expect(directoryQueriedLine(preview({ directory: null }))).toBe(CLIENT_LINK_COPY.directoryQueriedMissing);
    expect(directoryQueriedLine(preview())).toBe(CLIENT_LINK_COPY.directoryQueriedMissing);
    expect(directoryQueriedLine(preview({ directory: { ...directory, fetched_at: "not a date" } }))).toBe(CLIENT_LINK_COPY.directoryQueriedMissing);
  });

  it("folder-change views show people and future reuse before and after, coping with missing fields", () => {
    const before = { source_scope: SCOPE, revision: 1, decision: identity(), reuse_future: false };
    const after = { source_scope: SCOPE, revision: 2, decision: identity({ people: [P1, P2] }), reuse_future: true };
    expect(folderChangeViews(preview({ folder_changes: [{ source_scope: SCOPE, expected_revision: 1, before, after }] }))).toEqual([{
      key: `0:${SCOPE.source_folder_id}`,
      folderId: SCOPE.source_folder_id,
      before: { people: CLIENT_LINK_COPY.noAcceptedPeople, reuse: "Off" },
      after: { people: `${P1.display_name} + ${P2.display_name}`, reuse: "On" },
    }]);
    const partial = { source_scope: SCOPE, expected_revision: 1, before: {}, after: { decision: {} } } as unknown as ClientLinkFolderChange;
    expect(folderChangeViews(preview({ folder_changes: [partial] }))[0]).toMatchObject({
      before: { people: CLIENT_LINK_COPY.noAcceptedPeople, reuse: CLIENT_LINK_COPY.notRecorded },
      after: { people: CLIENT_LINK_COPY.noAcceptedPeople, reuse: CLIENT_LINK_COPY.notRecorded },
    });
    expect(folderChangeViews(preview())).toEqual([]);
  });
});
