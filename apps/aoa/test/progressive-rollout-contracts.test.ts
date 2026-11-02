import { describe, expect, it, vi } from "vitest";
import {
  appendProgressiveRows, fetchProgressivePage, parseProgressivePageParams,
  type ProgressivePage,
} from "@/lib/navigation/progressive-page";

type Row = { id: string };
const scope = "a".repeat(64);
const snapshot = "b".repeat(32);
const endpoint = "/api/navigation/clients?q=Synthetic";
const envelope = (): ProgressivePage<Row, Record<string, never>> => ({
  rows: [{ id: "synthetic:201" }], page: 3, pageSize: 100,
  total: 201, pageCount: 3, snapshot, meta: {},
});

function response(body: unknown, status = 200, responseScope: string | null = scope) {
  return Response.json(body, {
    status,
    headers: responseScope === null ? {} : { "X-AOA-Navigation-Scope": responseScope },
  });
}

async function load(fetcher: typeof fetch, signal = new AbortController().signal) {
  return fetchProgressivePage<Row, Record<string, never>>(
    endpoint, 3, 100, snapshot, signal, scope, "id", fetcher,
  );
}

describe("progressive page contracts across rollout surfaces", () => {
  it.each([
    "page=0", "page=-1", "page=01", "page=1.5", "page=1e2", "page=1000001",
    "page=1&page=2", "pageSize=0", "pageSize=201", "pageSize=100&pageSize=200",
    "snapshot=invalid", `snapshot=${snapshot}&snapshot=${snapshot}`,
  ])("rejects ambiguous or unbounded page controls: %s", query => {
    expect(() => parseProgressivePageParams(new URLSearchParams(query))).toThrow();
  });

  it("accepts a bounded final partial page without losing the source total", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(envelope()));
    expect(await load(fetcher)).toEqual(envelope());
    const query = new URL(fetcher.mock.calls[0][0], "https://example.test").searchParams;
    expect(query.get("q")).toBe("Synthetic");
    expect(query.get("page")).toBe("3");
    expect(query.get("pageSize")).toBe("100");
    expect(query.get("snapshot")).toBe(snapshot);
  });

  it.each([
    ["missing row", { rows: [] }],
    ["extra row", { rows: [{ id: "synthetic:201" }, { id: "synthetic:202" }] }],
    ["wrong page", { page: 2 }],
    ["wrong size", { pageSize: 200 }],
    ["negative total", { total: -1 }],
    ["fractional total", { total: 201.5 }],
    ["unsafe total", { total: Number.MAX_SAFE_INTEGER + 1 }],
    ["wrong page count", { pageCount: 4 }],
    ["invalid snapshot", { snapshot: "not-a-snapshot" }],
    ["changed snapshot", { snapshot: "c".repeat(32) }],
    ["missing metadata", { meta: undefined }],
    ["null metadata", { meta: null }],
    ["array metadata", { meta: [] }],
    ["unsafe row anchor", { rows: [{ id: "bad\nanchor" }] }],
    ["non-string row anchor", { rows: [{ id: 201 }] }],
  ])("fails closed on %s", async (_label, patch) => {
    const fetcher = vi.fn().mockResolvedValue(response({ ...envelope(), ...patch }));
    await expect(load(fetcher)).rejects.toMatchObject({ kind: "changed" });
  });

  it.each([401, 403, 404])("never decodes records after authorization status %i", async status => {
    const json = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ status, ok: false, headers: new Headers(), json });
    await expect(load(fetcher)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([null, "", "not-an-opaque-scope", "c".repeat(64)])(
    "never decodes a successful page under missing or mismatched scope %s", async responseScope => {
      const json = vi.fn();
      const headers = responseScope === null ? new Headers() : new Headers({ "X-AOA-Navigation-Scope": responseScope });
      const fetcher = vi.fn().mockResolvedValue({ status: 200, ok: true, headers, json });
      await expect(load(fetcher)).rejects.toMatchObject({ kind: "unauthorized" });
      expect(json).not.toHaveBeenCalled();
    },
  );

  it.each([409, 416])("treats status %i as a changed sequence, not successful emptiness", async status => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: "changed" }, status));
    await expect(load(fetcher)).rejects.toMatchObject({ kind: "changed" });
  });

  it("distinguishes a transient private error from an empty successful page", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: "unavailable" }, 503));
    await expect(load(fetcher)).rejects.toMatchObject({ kind: "unavailable" });
    const empty = { ...envelope(), page: 1, rows: [], total: 0, pageCount: 1 };
    const success = vi.fn().mockResolvedValue(response(empty));
    expect(await fetchProgressivePage(endpoint, 1, 100, snapshot, new AbortController().signal, scope, "id", success)).toEqual(empty);
  });

  it.each([
    "https://outside.test/api/navigation/clients", "//outside.test/api/navigation/clients",
    "/api/admin/users", "/api/navigation/clients#fragment", "/api/navigation/unknown",
  ])("does not send a request to an unsupported endpoint %s", async unsafe => {
    const fetcher = vi.fn();
    await expect(fetchProgressivePage(unsafe, 1, 100, null, new AbortController().signal, scope, "id", fetcher))
      .rejects.toMatchObject({ kind: "changed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not issue a canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(load(fetcher, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a response canceled during body decoding instead of appending late rows", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue({
      status: 200, ok: true, headers: new Headers({ "X-AOA-Navigation-Scope": scope }),
      json: async () => { controller.abort(); return envelope(); },
    });
    await expect(load(fetcher, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects malformed JSON without exposing its body as records", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("not-json", { headers: { "X-AOA-Navigation-Scope": scope } }));
    await expect(load(fetcher)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("rejects duplicate anchors within a page as well as across pages, without mutating current rows", () => {
    const current = [{ id: "synthetic:1" }];
    const next = [{ id: "synthetic:2" }, { id: "synthetic:2" }];
    expect(() => appendProgressiveRows(current, next, "id")).toThrow("changed");
    expect(current).toEqual([{ id: "synthetic:1" }]);
    expect(next).toHaveLength(2);
    expect(() => appendProgressiveRows(current, [{ id: "synthetic:1" }], "id")).toThrow("changed");
  });
});
