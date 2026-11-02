import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmailSearchController, EMAIL_SEARCH_ENDPOINT, type EmailSearchState } from "@/lib/email-search/controller";

// Synthetic rows only.
const row = (id: string, subject = `Synthetic ${id}`) => ({ sf_id: id, subject, body: `Synthetic body ${id}`, sent_at: "2026-03-01T12:00:00.000Z", source_modified_at: null });
const page = (rows: ReturnType<typeof row>[], over: Record<string, unknown> = {}) => ({
  rows, page: 1, pageSize: 50, total: rows.length, pageCount: 1, searched: 10, snapshot: "a".repeat(64), ...over,
});

type Call = { input: string; init: RequestInit; resolve: (status: number, body: unknown) => void; aborted: () => boolean };
function harness() {
  const calls: Call[] = [];
  const states: EmailSearchState[] = [];
  const controller = createEmailSearchController({
    householdId: "hh-synthetic",
    fetchImpl: (input, init) => new Promise(done => {
      calls.push({ input, init, aborted: () => Boolean(init.signal?.aborted),
        resolve: (status, body) => done({ status, json: async () => body }) });
    }),
    onChange: state => states.push(state),
  });
  return { calls, states, controller, last: () => controller.getState() };
}
const flush = () => new Promise(done => setTimeout(done, 0));
const sent = (call: Call) => JSON.parse(String(call.init.body));

afterEach(() => { /* each test owns its controller */ });

describe("ticket email search controller", () => {
  it("posts the term in the body only, never in the URL", async () => {
    const { calls, controller } = harness();
    controller.search("  Rebalance  ");
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(EMAIL_SEARCH_ENDPOINT);
    expect(calls[0].input).not.toContain("?");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.cache).toBe("no-store");
    expect(sent(calls[0])).toEqual({ household: "hh-synthetic", q: "Rebalance", page: 1 });
  });

  it("keeps only the newest query when responses arrive out of order (rapid typing)", async () => {
    const { calls, controller, last } = harness();
    controller.search("alpha");
    controller.search("beta");
    expect(calls[0].aborted()).toBe(true);
    calls[1].resolve(200, page([row("B1")]));
    await flush();
    calls[0].resolve(200, page([row("A1")]));
    await flush();
    expect(last()).toMatchObject({ status: "ready", term: "beta" });
    expect(last().rows.map(item => item.sf_id)).toEqual(["B1"]);
  });

  it("drops an in-flight response after clear, and does not refetch the same term", async () => {
    const { calls, controller, last } = harness();
    controller.search("alpha");
    controller.search("alpha");
    expect(calls).toHaveLength(1);
    controller.clear();
    calls[0].resolve(200, page([row("A1")]));
    await flush();
    expect(last().status).toBe("idle");
    expect(last().rows).toEqual([]);
  });

  it("treats too-short or invalid terms as clearing, without a request", () => {
    const { calls, controller, last } = harness();
    for (const term of ["", " ", "a", "a\u0000b"]) controller.search(term);
    expect(calls).toHaveLength(0);
    expect(last().status).toBe("idle");
  });

  it("reports no matches as a ready, empty result", async () => {
    const { calls, controller, last } = harness();
    controller.search("nothing");
    calls[0].resolve(200, page([], { total: 0, searched: 7 }));
    await flush();
    expect(last()).toMatchObject({ status: "ready", total: 0, searched: 7, rows: [] });
  });

  it("appends later pages with the snapshot and never duplicates a message", async () => {
    const { calls, controller, last } = harness();
    controller.search("fee");
    calls[0].resolve(200, page([row("M1"), row("M2")], { total: 3, pageCount: 2 }));
    await flush();
    controller.loadMore();
    controller.loadMore();
    expect(calls).toHaveLength(2);
    expect(sent(calls[1])).toEqual({ household: "hh-synthetic", q: "fee", page: 2, snapshot: "a".repeat(64) });
    calls[1].resolve(200, page([row("M2"), row("M3")], { page: 2, total: 3, pageCount: 2 }));
    await flush();
    expect(last().rows.map(item => item.sf_id)).toEqual(["M1", "M2", "M3"]);
    expect(last().page).toBe(2);
  });

  it("restarts from page 1 when the matching set changed (409)", async () => {
    const { calls, controller, last } = harness();
    controller.search("fee");
    calls[0].resolve(200, page([row("M1")], { total: 2, pageCount: 2 }));
    await flush();
    controller.loadMore();
    calls[1].resolve(409, { error: "household_email_search_changed" });
    await flush();
    expect(calls).toHaveLength(3);
    expect(sent(calls[2])).toEqual({ household: "hh-synthetic", q: "fee", page: 1 });
    calls[2].resolve(200, page([row("M9")]));
    await flush();
    expect(last()).toMatchObject({ status: "ready", notice: "changed" });
    expect(last().rows.map(item => item.sf_id)).toEqual(["M9"]);
  });

  it("clears every row when access is revoked mid-session (401 or 404)", async () => {
    for (const status of [401, 404]) {
      const { calls, controller, last } = harness();
      controller.search("fee");
      calls[0].resolve(200, page([row("M1")], { total: 2, pageCount: 2 }));
      await flush();
      controller.loadMore();
      calls[1].resolve(status, { error: status === 401 ? "unauthorized" : "household_unavailable" });
      await flush();
      expect(last()).toMatchObject({ status: "unavailable", rows: [], total: 0 });
    }
  });

  it("keeps results and reports maintenance or transient failures on later pages", async () => {
    const { calls, controller, last } = harness();
    controller.search("fee");
    calls[0].resolve(200, page([row("M1")], { total: 2, pageCount: 2 }));
    await flush();
    controller.loadMore();
    calls[1].resolve(503, { error: "temporarily_read_only" });
    await flush();
    expect(last()).toMatchObject({ status: "ready", error: "read_only", appending: false });
    expect(last().rows).toHaveLength(1);
    controller.search("other");
    calls[2].resolve(500, null);
    await flush();
    expect(last()).toMatchObject({ status: "error", error: "unavailable", rows: [] });
  });

  it("never references URL, history, browser storage or logging", () => {
    for (const file of ["lib/email-search/controller.ts", "components/client-portrait/EmailSearch.tsx", "lib/email-search/term.ts"]) {
      const source = readFileSync(join(__dirname, "..", file), "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of ["sessionStorage", "localStorage", "indexedDB", "history.", "useRouter", "router.",
        "URLSearchParams", "searchParams", "location.", "console.", "document.cookie"]) {
        expect(source, `${file} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
