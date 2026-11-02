import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ClientLinkIdentity,
  ClientLinkLookup,
  ClientLinkPreview as Preview,
  ClientLinkQueueItem,
  RunClientLink,
} from "@/lib/data/asset-map-client-link-contract";
import { ClientLinkQueue, type ClientLinkQueueProps } from "@/components/asset-mapping/workspace/client-linking/ClientLinkQueue";
import { ClientLinkReview, type ClientLinkReviewProps } from "@/components/asset-mapping/workspace/client-linking/ClientLinkReview";
import { ClientLinkPreview, ResultNotice, type ClientLinkPreviewProps } from "@/components/asset-mapping/workspace/client-linking/ClientLinkPreview";
import { HouseholdLinkCard, type HouseholdLinkCardProps } from "@/components/asset-mapping/workspace/client-linking/HouseholdLinkCard";
import { WorkspaceSectionNav } from "@/components/asset-mapping/workspace/client-linking/WorkspaceSectionNav";
import {
  CLIENT_LINK_COPY,
  LINK_SUMMARY_COPY,
  QUEUE_FILTERS,
  clientLinkDate,
  failureView,
  initialDraft,
  type LinkDraftState,
} from "@/components/asset-mapping/workspace/client-linking/client-link-model";

const RUN = "11111111-1111-4111-8111-111111111111";
const P1 = { user_id: "synthetic-person-1", display_name: "Synthetic Person One" };
const P2 = { user_id: "synthetic-person-2", display_name: "Synthetic Person Two" };
const SCOPE = { source_system: "google_drive" as const, source_folder_id: "synthetic-folder" };
const noop = () => {};

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
    run_id: RUN, identity: identity(), lookup: lookup(), holder_evidence: ["Synthetic Holder"], folder: null, events: [],
    identity_version: 1, source_scope: SCOPE, ...over,
  };
}

function item(key: string, over: Partial<ClientLinkQueueItem> = {}): ClientLinkQueueItem {
  return {
    scope_key: key,
    source_scope: { source_system: "google_drive", source_folder_id: key },
    representative_run_id: RUN,
    client_name: `Synthetic Client ${key}`,
    run_count: 3,
    unlinked_run_count: 1,
    folder: null,
    review_state: "unresolved",
    lookup_state: "ready",
    bulk_eligible: false,
    exceptions: [],
    ...over,
  };
}

function preview(over: Partial<Preview> = {}): Preview {
  return {
    preview_id: "33333333-3333-4333-8333-333333333333",
    kind: "confirm",
    payload_hash: "synthetic-hash",
    expires_at: "2026-10-04T12:00:00Z",
    acknowledgement: "I reviewed these synthetic changes.",
    targets: [{ run_id: RUN, client_name: "Synthetic Client A", run_number: 1, is_historical: false, before: identity(), after: identity({ people: [P1] }) }],
    exclusions: [],
    ...over,
  };
}

const LINKED = identity({ decision_id: "d-1", people: [P1], primary_user_id: P1.user_id, coverage: "complete", review_state: "complete" });

function queue(over: Partial<ClientLinkQueueProps> = {}): string {
  const props: ClientLinkQueueProps = {
    page: { items: [item("a"), item("b", { folder: { source_scope: SCOPE, revision: 1, decision: LINKED, reuse_future: true } })], total: 2, next_cursor: "c-1" },
    status: "loaded", failure: null, reviewState: null, query: "", selection: new Map(), canReview: true,
    onReviewState: noop, onQuery: noop, onLoadMore: noop, onRetry: noop, onToggle: noop, onPreviewBackfill: noop, onReview: noop,
    onViewRun: () => "select",
    ...over,
  };
  return renderToStaticMarkup(createElement(ClientLinkQueue, props));
}

function review(r: RunClientLink, draft: LinkDraftState = initialDraft(r), over: Partial<ClientLinkReviewProps> = {}): string {
  const props: ClientLinkReviewProps = {
    run: r, draft, directory: { query: "", result: null, searching: false, failure: null }, busy: false,
    onDraft: noop, onQuery: noop, onPreview: noop, onClose: noop, ...over,
  };
  return renderToStaticMarkup(createElement(ClientLinkReview, props));
}

function previewHtml(over: Partial<ClientLinkPreviewProps> = {}): string {
  const props: ClientLinkPreviewProps = {
    preview: preview(), now: Date.parse("2026-10-04T11:00:00Z"), uncertain: false, failure: null, applying: false,
    onApply: noop, onRefresh: noop, onClose: noop, ...over,
  };
  return renderToStaticMarkup(createElement(ClientLinkPreview, props));
}

function card(over: Partial<HouseholdLinkCardProps> = {}): string {
  const props: HouseholdLinkCardProps = {
    run: run(), failure: null, canReview: true, busy: false,
    onRetryLoad: noop, onRetryLookup: noop, onReview: noop, onViewChange: noop, ...over,
  };
  return renderToStaticMarkup(createElement(HouseholdLinkCard, props));
}

function occurrences(html: string, text: string): number {
  return html.split(text).length - 1;
}

describe("client-link rendering", () => {
  it("queue shows the five filters, folder search, four counts, and Load more folders", () => {
    const html = queue();
    for (const f of QUEUE_FILTERS) expect(html).toContain(`>${f.label}<`);
    expect(QUEUE_FILTERS).toHaveLength(5);
    expect(html).toContain(`aria-label="${CLIENT_LINK_COPY.searchFolders}"`);
    for (const label of [CLIENT_LINK_COPY.statFolders, CLIENT_LINK_COPY.statReady, CLIENT_LINK_COPY.statComplete, CLIENT_LINK_COPY.statCoverage]) {
      expect(html).toContain(label);
    }
    expect(html).toContain(CLIENT_LINK_COPY.loadMore);
    expect(html).toContain(">4 / 6<");
  });

  it("queue filters are a segmented control with a count per filter and a distinct tone per review state", () => {
    const html = queue({ reviewState: "partial", filterTotals: { unresolved: 7, partial: 3, complete: 12, conflict: 1 } });
    expect(html).toMatch(new RegExp(`class="[^"]*segmented[^"]*" role="group" aria-label="${CLIENT_LINK_COPY.filterGroup}"`));
    const counts = [...html.matchAll(/data-filter-count="([a-z]+)">(\d+)</g)].map((x) => `${x[1]}=${x[2]}`);
    expect(counts).toEqual(["all=23", "unresolved=7", "partial=3", "complete=12", "conflict=1"]);
    const tones = [...html.matchAll(/data-tone="([a-z]+)" aria-pressed="(?:true|false)"><span>([A-Za-z]+)</g)].map((x) => `${x[2]}=${x[1]}`);
    expect(tones).toEqual(["Unresolved=attention", "Partial=caution", "Complete=ok", "Conflicts=danger"]);
    expect(new Set(tones.map((t) => t.split("=")[1])).size).toBe(4);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"><span>Partial</);
    const partial = queue({ filterTotals: { unresolved: 7 } });
    expect([...partial.matchAll(/data-filter-count="([a-z]+)"/g)].map((x) => x[1])).toEqual(["unresolved"]);
  });

  it("queue rows tone the review-state pill by state", () => {
    const html = queue({ page: { items: [item("a", { review_state: "conflict" }), item("b", { review_state: "complete" })], total: 2, next_cursor: null } });
    expect(html).toContain('data-tone="danger">conflict</span>');
    expect(html).toContain('data-tone="ok">complete</span>');
  });

  it("card collapses to a one-line summary with state, people, and Show details, keeping the details inside", () => {
    const html = card({ run: run({ identity: LINKED }) });
    expect(html).toMatch(/^<details class="[^"]*disclosure[^"]*" data-link-card=""><summary/);
    const summary = html.slice(0, html.indexOf("</summary>"));
    expect(summary).toContain(LINK_SUMMARY_COPY.label);
    expect(summary).toContain('data-tone="ok">complete</span>');
    expect(summary).toContain(P1.display_name);
    expect(summary).toContain(LINK_SUMMARY_COPY.showDetails);
    expect(html.slice(html.indexOf("</summary>"))).toContain(`Copy Cedar Ridge ID for ${P1.display_name}`);
    expect(card({ run: null })).toContain(LINK_SUMMARY_COPY.loading);
    expect(card()).toContain(LINK_SUMMARY_COPY.noPeople);
  });

  it("holder-evidence conflict renders as a danger notice", () => {
    const html = card({ run: run({ identity: identity({ review_state: "conflict", conflict_flags: ["holder_mismatch"] }) }) });
    expect(html).toMatch(/class="[^"]*notice[^"]*conflict[^"]*" data-tone="danger"/);
  });

  it("queue shows View run on every row", () => {
    expect(occurrences(queue(), `>${CLIENT_LINK_COPY.viewRun}<`)).toBe(2);
    expect(occurrences(queue({ canReview: false }), `>${CLIENT_LINK_COPY.viewRun}<`)).toBe(2);
  });

  it("queue hides Review, backfill selection, and Preview backfill when writes are off and shows the disabled text", () => {
    const html = queue({ canReview: false });
    expect(html).not.toContain(`>${CLIENT_LINK_COPY.review}<`);
    expect(html).not.toContain(`>${CLIENT_LINK_COPY.manage}<`);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain(CLIENT_LINK_COPY.previewBackfill);
    expect(html).toContain(CLIENT_LINK_COPY.writesDisabledQueue);
    const writable = queue();
    expect(writable).toContain(`>${CLIENT_LINK_COPY.review}<`);
    expect(writable).toContain(`>${CLIENT_LINK_COPY.manage}<`);
    expect(writable).toContain(CLIENT_LINK_COPY.previewBackfill);
  });

  it("queue shows the error and Try again when it cannot load", () => {
    const html = queue({ status: "failed", failure: failureView({ reason: "unavailable", message: null }) });
    expect(html).toContain('role="alert"');
    expect(html).toContain(CLIENT_LINK_COPY.failedTitle);
    expect(html).toContain(CLIENT_LINK_COPY.tryAgain);
  });

  it("review shows directory search, candidates, primary, coverage, scope, reuse, and the review note", () => {
    const r = run({
      lookup: lookup({ suggestion: { kind: "exact", candidates: [{ ...P2, match_kind: "exact", evidence: ["name"], eligible: true }], evidence: ["name"], conflict_flags: [] } }),
    });
    const html = review(r);
    expect(html).toContain(CLIENT_LINK_COPY.findClient);
    expect(html).toContain(`Select ${P2.display_name}, ${P2.user_id}`);
    for (const text of [
      CLIENT_LINK_COPY.primary, CLIENT_LINK_COPY.coverageLegend, CLIENT_LINK_COPY.coverageComplete, CLIENT_LINK_COPY.coveragePartial,
      CLIENT_LINK_COPY.scopeLegend, CLIENT_LINK_COPY.scopeThisRun, CLIENT_LINK_COPY.scopeAllExisting, CLIENT_LINK_COPY.reuse, CLIENT_LINK_COPY.note,
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('maxLength="2000"');
  });

  it("review disables more selections at 20 people", () => {
    const people = Array.from({ length: 20 }, (_, i) => ({ user_id: `p-${i}`, display_name: `Synthetic ${i}` }));
    const r = run({
      lookup: lookup({ suggestion: { kind: "exact", candidates: [{ ...P2, match_kind: "exact", evidence: [], eligible: true }], evidence: [], conflict_flags: [] } }),
    });
    const html = review(r, { ...initialDraft(r), people, coverage: "partial" });
    const extra = html.match(new RegExp(`<input[^>]*aria-label="Select ${P2.display_name}, ${P2.user_id}"[^>]*>`));
    expect(extra?.[0]).toContain('disabled=""');
    const selected = html.match(/<input[^>]*aria-label="Select Synthetic 0, p-0"[^>]*>/);
    expect(selected?.[0]).not.toContain('disabled=""');
  });

  it("review shows Preview removal when every person is cleared", () => {
    const r = run({ identity: LINKED });
    expect(review(r)).toContain(CLIENT_LINK_COPY.previewChanges);
    const html = review(r, { ...initialDraft(r), people: [], primary: null });
    expect(html).toContain(CLIENT_LINK_COPY.previewRemoval);
    expect(html).not.toContain(CLIENT_LINK_COPY.previewChanges);
  });

  it("review offers Use these people in this draft when the folder differs", () => {
    const r = run({ folder: { source_scope: SCOPE, revision: 2, decision: LINKED, reuse_future: true } });
    const html = review(r);
    expect(html).toContain(CLIENT_LINK_COPY.folderDiffers);
    expect(html).toContain(CLIENT_LINK_COPY.usePeople);
    expect(review(run())).not.toContain(CLIENT_LINK_COPY.usePeople);
  });

  it("preview shows targets, expiry, and acknowledgement", () => {
    const html = previewHtml();
    expect(html).toContain("Synthetic Client A");
    expect(html).toContain("Before: Unlinked");
    expect(html).toContain(`After: ${P1.display_name}`);
    expect(html).toContain("Preview expires ");
    expect(html).toContain("I reviewed these synthetic changes.");
    expect(html).toContain(CLIENT_LINK_COPY.applyChanges);
  });

  it("preview shows the expired notice and Refresh and review again after expiry", () => {
    const html = previewHtml({ now: Date.parse("2026-10-04T12:00:01Z") });
    expect(html).toContain(CLIENT_LINK_COPY.previewExpired);
    expect(html).toContain(CLIENT_LINK_COPY.refreshAndReview);
    expect(html).not.toContain(CLIENT_LINK_COPY.applyChanges);
  });

  it("preview shows Retry same apply after an uncertain apply", () => {
    const html = previewHtml({ uncertain: true });
    expect(html).toContain(CLIENT_LINK_COPY.uncertainApply);
    expect(html).toContain(CLIENT_LINK_COPY.retrySameKey);
    expect(html).toContain(CLIENT_LINK_COPY.retrySameApply);
  });

  it("result notice shows the batch counts and Review reversal", () => {
    const html = renderToStaticMarkup(createElement(ResultNotice, {
      result: { batch_id: "22222222-2222-4222-8222-222222222222", applied: 2, unchanged: 1, excluded: 0, kind: "confirm" },
      busy: false,
      onReviewReversal: noop,
    }));
    expect(html).toContain(CLIENT_LINK_COPY.resultUpdated);
    expect(html).toContain("2 runs updated · 1 unchanged · 0 excluded.");
    expect(html).toContain(CLIENT_LINK_COPY.reviewReversal);
  });

  it("card shows linked people with Copy Cedar Ridge ID and Retry lookup", () => {
    const html = card({ run: run({ identity: LINKED, lookup: lookup({ state: "unavailable" }) }) });
    expect(html).toContain(P1.display_name);
    expect(html).toContain(`Copy Cedar Ridge ID for ${P1.display_name}`);
    expect(html).toContain(CLIENT_LINK_COPY.retryLookup);
    expect(html).toContain(CLIENT_LINK_COPY.manageLink);
    expect(card({ run: run({ identity: LINKED }) })).not.toContain(CLIENT_LINK_COPY.retryLookup);
  });

  it("card shows directory state, holder-evidence conflict, and suggested people", () => {
    const html = card({
      run: run({
        identity: identity({ review_state: "conflict", conflict_flags: ["holder_mismatch"] }),
        lookup: lookup({
          state: "pending",
          suggestion: { kind: "ambiguous", candidates: [{ ...P1, match_kind: "exact", evidence: ["name"], eligible: true }, { ...P2, match_kind: "partial", evidence: [], eligible: true }], evidence: [], conflict_flags: [] },
        }),
      }),
    });
    expect(html).toContain(CLIENT_LINK_COPY.directoryPending);
    expect(html).toContain(CLIENT_LINK_COPY.holderConflict);
    expect(html).toContain("holder_mismatch");
    expect(html).toContain(CLIENT_LINK_COPY.suggestionAmbiguous);
    expect(html).toContain(P1.display_name);
    expect(html).toContain(P2.display_name);
  });

  it("card shows activity history with View change", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      event_id: `e-${i}`, batch_id: i === 0 ? null : `b-${i}`, kind: "link_confirmed", actor: "synthetic@example.invalid",
      occurred_at: "2026-10-04T10:00:00Z", reason: null,
    }));
    const html = card({ run: run({ identity: LINKED, events }) });
    expect(html).toContain(CLIENT_LINK_COPY.activity);
    expect(occurrences(html, "link confirmed")).toBe(5);
    expect(occurrences(html, `>${CLIENT_LINK_COPY.viewChange}<`)).toBe(4);
    expect(html).toContain(`synthetic@example.invalid · ${clientLinkDate("2026-10-04T10:00:00Z")}`);
    expect(html).not.toContain("2026-10-04T10:00:00Z");
  });

  it("section nav shows Asset mapping and Client linking", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSectionNav, { visible: true, active: "linking", onSelect: noop }));
    expect(html).toContain(`>${CLIENT_LINK_COPY.tabHouseholds}<`);
    expect(html).toContain(`>${CLIENT_LINK_COPY.tabLinking}<`);
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>Client linking</);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*>Asset mapping</);
  });

  it("section nav renders nothing when client linking is off", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceSectionNav, { visible: false, active: "households", onSelect: noop }))).toBe("");
  });

  it("queue select-all is a header checkbox, checked once every loaded eligible folder is selected", () => {
    const eligible = (key: string) =>
      item(key, { bulk_eligible: true, review_state: "complete", folder: { source_scope: SCOPE, revision: 1, decision: LINKED, reuse_future: true } });
    const items = [eligible("a"), eligible("b"), item("c")];
    const page = { items, total: 3, next_cursor: null };
    const selectAll = (html: string) => html.match(new RegExp(`<input[^>]*aria-label="${CLIENT_LINK_COPY.selectAll}"[^>]*>`))?.[0] ?? "";
    const none = selectAll(queue({ page }));
    expect(none).toContain('type="checkbox"');
    expect(none).not.toContain('checked=""');
    const all = new Map(items.slice(0, 2).map((i) => [i.scope_key, i] as const));
    expect(selectAll(queue({ page, selection: all }))).toContain('checked=""');
    expect(selectAll(queue({ page: { items: [item("c")], total: 1, next_cursor: null } }))).toContain('disabled=""');
  });

  it("preview shows the run label, after-state badge, folder-change before and after, and queried-at", () => {
    const at = "2026-10-04T09:30:00Z";
    const html = previewHtml({
      preview: preview({
        targets: [
          { run_id: RUN, client_name: "Synthetic Client A", run_number: 4, is_historical: false, before: identity(), after: LINKED },
          {
            run_id: "44444444-4444-4444-8444-444444444444", client_name: "Synthetic Client A", run_number: 2, is_historical: true,
            before: identity(), after: identity({ people: [P1], review_state: "partial" }),
          },
        ],
        folder_changes: [{
          source_scope: SCOPE,
          expected_revision: 1,
          before: { source_scope: SCOPE, revision: 1, decision: identity(), reuse_future: false },
          after: { source_scope: SCOPE, revision: 2, decision: LINKED, reuse_future: true },
        }],
        directory: { freshness: "fresh", complete: true, eligibility_verified: true, fetched_at: at, source_as_of: null },
      }),
    });
    expect(html).toContain('data-run-label="">Run 4<');
    expect(html).toContain(`data-run-label="">${CLIENT_LINK_COPY.previousRun}<`);
    expect(html).not.toContain('data-run-label="">Run 2<');
    expect(html).toContain('data-tone="ok">complete</span>');
    expect(html).toContain('data-tone="caution">partial</span>');
    expect(html).toContain(CLIENT_LINK_COPY.savedFolder);
    expect(html).toContain(`Saved before: ${CLIENT_LINK_COPY.noAcceptedPeople} · Future reuse: Off`);
    expect(html).toContain(`Saved after: ${P1.display_name} · Future reuse: On`);
    expect(html).toContain(`${CLIENT_LINK_COPY.directoryQueried} ${clientLinkDate(at)}`);
  });

  it("preview copes with a body missing folder-change and directory fields", () => {
    const html = previewHtml();
    expect(html).not.toContain(CLIENT_LINK_COPY.savedFolder);
    expect(html).toContain(CLIENT_LINK_COPY.directoryQueriedMissing);
    expect(html).toContain('data-run-label="">Run 1<');
  });

  it("card shows how the link was made and never labels an inherited link accepted on this run", () => {
    const inherited = card({ run: run({ identity: { ...LINKED, method: "inherited" } }) });
    expect(inherited).toContain(CLIENT_LINK_COPY.methodInherited);
    expect(inherited).not.toContain(CLIENT_LINK_COPY.acceptedHere);
    const manual = card({ run: run({ identity: { ...LINKED, method: "manual" } }) });
    expect(manual).toContain(CLIENT_LINK_COPY.acceptedHere);
    expect(manual).toContain(CLIENT_LINK_COPY.methodManual);
    const unlinked = card();
    expect(unlinked).not.toContain(CLIENT_LINK_COPY.acceptedHere);
    expect(unlinked).not.toContain(CLIENT_LINK_COPY.methodUnknown);
  });
});
