import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJobMetadata, fetchMetadataPages, JobMetadataAccessError } from "@/components/data-jobs/requests";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Job monitor bounded same-origin requests", () => {
  it("uses no-store, same-origin credentials, and an abort signal", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ nextCursor: null, runs: [] }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchJobMetadata("/api/data-health/jobs/example/runs", new AbortController().signal);
    expect(result).toEqual({ nextCursor: null, runs: [] });
    expect(fetch).toHaveBeenCalledWith("/api/data-health/jobs/example/runs", expect.objectContaining({ cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
  });

  it("never exposes server error bodies or an HTML login page as job data", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("private database error", { status: 500 })).mockResolvedValueOnce(new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetch);
    for (let attempt = 0; attempt < 2; attempt += 1) await expect(fetchJobMetadata("/api/data-health/jobs", new AbortController().signal)).rejects.toThrow("Monitoring metadata unavailable");
  });

  it("rejects malformed success envelopes before they can crash the rendered page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ nextCursor: null, jobs: [{}] })));
    await expect(fetchJobMetadata("/api/data-health/jobs", new AbortController().signal)).rejects.toThrow("Monitoring metadata unavailable");
  });

  it.each([401, 403, 404])("marks HTTP %s as access denial so callers clear prior metadata", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "private failure body" }, { status })));
    await expect(fetchJobMetadata("/api/data-health/jobs", new AbortController().signal)).rejects.toBeInstanceOf(JobMetadataAccessError);
  });

  it("also clears prior metadata when middleware followed a login redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ redirected: true, status: 200 }));
    await expect(fetchJobMetadata("/api/data-health/jobs", new AbortController().signal)).rejects.toBeInstanceOf(JobMetadataAccessError);
  });

  it("stops refreshing after the requested page count, the end, or a repeated cursor", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ nextCursor: "same", runs: [] })));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchMetadataPages((cursor) => `/api/data-health/jobs/example/runs?cursor=${cursor ?? ""}`, 5, new AbortController().signal)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear().mockImplementation(() => Promise.resolve(Response.json({ nextCursor: null, runs: [] })));
    expect(await fetchMetadataPages(() => "/api/data-health/jobs/example/runs", 5, new AbortController().signal)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caps refresh fan-out to five pages and does not request after cancellation", async () => {
    let page = 0;
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ nextCursor: String(++page), runs: [] })));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchMetadataPages(() => "/api/data-health/jobs/example/runs", 99, new AbortController().signal)).toHaveLength(5);
    const canceled = new AbortController();
    canceled.abort();
    await expect(fetchMetadataPages(() => "/api/data-health/jobs", 1, canceled.signal)).rejects.toThrow("Monitoring refresh canceled");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("aborts a stalled request after twelve seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = fetchJobMetadata("/api/data-health/jobs", new AbortController().signal);
    const assertion = expect(result).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
