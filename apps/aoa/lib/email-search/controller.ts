import type { EmailEnvelope, EmailEnvelopeCoverage } from "./envelope";
// ticket household email search: framework-free client state machine.
// The term lives only in memory and in POST bodies. This module never touches the
// URL, history, sessionStorage, localStorage or any logging sink.
import { normalizeEmailSearchTerm } from "./term";

export const EMAIL_SEARCH_ENDPOINT = "/api/navigation/household-email/search";

export type EmailSearchRow = {
  email_envelope?: EmailEnvelope | null;
  sf_id: string;
  subject: string | null;
  body: string | null;
  sent_at: string | Date | null;
  source_modified_at: string | Date | null;
};

export type EmailSearchStatus = "idle" | "loading" | "ready" | "error" | "unavailable";

export type EmailSearchState = {
  status: EmailSearchStatus;
  /** The normalized term the visible results belong to (null when idle). */
  term: string | null;
  rows: EmailSearchRow[];
  total: number;
  searched: number;
  metadataCoverage: EmailEnvelopeCoverage | null;
  page: number;
  pageCount: number;
  snapshot: string | null;
  appending: boolean;
  notice: "changed" | null;
  error: "invalid" | "read_only" | "unavailable" | null;
};

export const IDLE_EMAIL_SEARCH: EmailSearchState = Object.freeze({
  status: "idle", term: null, rows: [], total: 0, searched: 0, page: 0, pageCount: 0,
  snapshot: null, appending: false, notice: null, error: null, metadataCoverage: null,
}) as EmailSearchState;

type PageBody = { metadataCoverage?: EmailEnvelopeCoverage; rows: EmailSearchRow[]; page: number; total: number; pageCount: number; searched: number; snapshot: string };
type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, "status" | "json">>;

export type EmailSearchController = {
  getState(): EmailSearchState;
  search(rawTerm: string): void;
  loadMore(): void;
  clear(): void;
  dispose(): void;
};

export function createEmailSearchController({ householdId, fetchImpl, onChange }: {
  householdId: string;
  fetchImpl: FetchLike;
  onChange: (state: EmailSearchState) => void;
}): EmailSearchController {
  let state: EmailSearchState = IDLE_EMAIL_SEARCH;
  let sequence = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: EmailSearchState) => { state = next; if (!disposed) onChange(state); };
  const cancel = () => { inFlight?.abort(); inFlight = null; };

  async function request(term: string, page: number, snapshot: string | null, token: number) {
    const controller = new AbortController();
    inFlight = controller;
    try {
      const response = await fetchImpl(EMAIL_SEARCH_ENDPOINT, {
        method: "POST", signal: controller.signal, cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ household: householdId, q: term, page, ...(snapshot ? { snapshot } : {}) }),
      });
      if (token !== sequence) return null;
      if (response.status === 200) return { ok: true as const, body: await response.json() as PageBody };
      let error: string | null = null;
      try { error = ((await response.json()) as { error?: string }).error ?? null; } catch { error = null; }
      if (token !== sequence) return null;
      return { ok: false as const, status: response.status, error };
    } catch {
      if (token !== sequence || controller.signal.aborted) return null;
      return { ok: false as const, status: 0, error: null };
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  function fail(term: string, status: number, error: string | null, keepRows: boolean) {
    // 401: session gone. 404: household no longer visible. Both mean revoked: drop every row.
    if (status === 401 || status === 404) {
      set({ ...IDLE_EMAIL_SEARCH, status: "unavailable", term, error: "unavailable" });
      return;
    }
    const kind = status === 400 ? "invalid" : error === "temporarily_read_only" ? "read_only" : "unavailable";
    set(keepRows ? { ...state, appending: false, status: "ready", error: kind }
      : { ...IDLE_EMAIL_SEARCH, status: "error", term, error: kind });
  }

  async function runFirstPage(term: string, notice: EmailSearchState["notice"]) {
    cancel();
    const token = ++sequence;
    set({ ...IDLE_EMAIL_SEARCH, status: "loading", term, notice });
    const result = await request(term, 1, null, token);
    if (!result || token !== sequence) return;
    if (!result.ok) { fail(term, result.status, result.error, false); return; }
    const body = result.body;
    set({ status: "ready", term, rows: dedupe([], body.rows), total: body.total, searched: body.searched,
      metadataCoverage: body.metadataCoverage ?? null, page: body.page, pageCount: body.pageCount, snapshot: body.snapshot, appending: false, notice, error: null });
  }

  function clear() { cancel(); sequence += 1; set(IDLE_EMAIL_SEARCH); }

  return {
    getState: () => state,
    search(rawTerm) {
      const term = normalizeEmailSearchTerm(rawTerm);
      if (!term) { clear(); return; }
      if (term === state.term && (state.status === "loading" || state.status === "ready")) return;
      void runFirstPage(term, null);
    },
    loadMore() {
      if (state.status !== "ready" || state.appending || !state.term || state.page >= state.pageCount) return;
      const { term, snapshot } = state;
      const page = state.page + 1;
      cancel();
      const token = ++sequence;
      set({ ...state, appending: true, error: null });
      void request(term, page, snapshot, token).then(result => {
        if (!result || token !== sequence) return;
        if (result.ok) {
          set({ ...state, rows: dedupe(state.rows, result.body.rows), page: result.body.page, total: result.body.total,
            pageCount: result.body.pageCount, searched: result.body.searched, appending: false });
          return;
        }
        // The matching set changed: restart from page 1 rather than splice two snapshots.
        if (result.status === 409 || result.status === 416) { void runFirstPage(term, "changed"); return; }
        fail(term, result.status, result.error, true);
      });
    },
    clear,
    dispose() { cancel(); sequence += 1; disposed = true; },
  };
}

// A message appears once even if a page boundary is ever re-served.
function dedupe(existing: EmailSearchRow[], incoming: EmailSearchRow[]): EmailSearchRow[] {
  const seen = new Set(existing.map(row => row.sf_id));
  const merged = [...existing];
  for (const row of incoming) if (!seen.has(row.sf_id)) { seen.add(row.sf_id); merged.push(row); }
  return merged;
}
