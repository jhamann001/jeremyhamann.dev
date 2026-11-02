import { PassThrough } from "node:stream";
import { createElement, type ReactElement } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authMock, previewMock, fullMock } = vi.hoisted(() => ({
  authMock: vi.fn(), previewMock: vi.fn(), fullMock: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/households", () => ({
  getHouseholdDirectoryPreview: previewMock,
  getHouseholdDirectory: fullMock,
}));
vi.mock("@/components/households/HouseholdsTable", () => ({
  HouseholdsTable: () => createElement("div", { "data-exact-directory": "true" }, "Synthetic exact directory"),
}));

import HouseholdsPage from "@/app/(household-directory)/households/page";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Households streamed first page", () => {
  it("sends authorized first-row links without starting the exact directory on the server", async () => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "1");
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: "synthetic@example.invalid" }, navigationScope: "" });
    previewMock.mockResolvedValue([{
      sf_id: "001GLD999342093AAA", name: "AAA Preview Synthetic 0001",
      stage: "Client", advisor_name: null, lead_advisor_email: "synthetic@example.invalid",
    }]);
    fullMock.mockImplementation(() => new Promise(() => {}));

    const page = await HouseholdsPage({ searchParams: Promise.resolve({}) });
    const firstChunk = await new Promise<string>((resolve, reject) => {
      const output = new PassThrough();
      let html = "";
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("preview_not_streamed")); } }, 2000);
      const stream = renderToPipeableStream(page as ReactElement, {
        onShellReady: () => stream.pipe(output),
        onError: (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
      });
      output.on("data", (chunk: Buffer) => {
        html += chunk.toString();
        if (!settled && html.includes("AAA Preview Synthetic 0001")) {
          settled = true;
          clearTimeout(timer);
          resolve(html);
          stream.abort();
          output.destroy();
        }
      });
    });
    expect(fullMock).not.toHaveBeenCalled();
    expect(firstChunk).toContain("/households/001GLD999342093AAA");
    expect(firstChunk).toContain("Loading filters and balances");
    expect(firstChunk).not.toContain("0 households");
    expect(firstChunk).not.toContain("<!--$?-->");
  });

  it("does not let an exact-read failure block the first server chunk", async () => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "1");
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: "synthetic@example.invalid" }, navigationScope: "" });
    previewMock.mockResolvedValue([{
      sf_id: "001GLD999342093AAA", name: "AAA Preview Synthetic 0001",
      stage: "Client", advisor_name: null, lead_advisor_email: "synthetic@example.invalid",
    }]);
    fullMock.mockRejectedValue(new Error("synthetic exact read failure"));

    const page = await HouseholdsPage({ searchParams: Promise.resolve({}) });
    const html = await new Promise<string>((resolve, reject) => {
      const output = new PassThrough();
      let body = "";
      const stream = renderToPipeableStream(page as ReactElement, {
        onShellReady: () => stream.pipe(output),
        onError: reject,
      });
      output.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      output.on("end", () => resolve(body));
    });
    expect(html).toContain("AAA Preview Synthetic 0001");
    expect(html).toContain("Loading filters and balances");
    expect(fullMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "preview failure", flag: "1", params: {}, previewCalls: 1 },
    { name: "disabled fast path", flag: "0", params: {}, previewCalls: 0 },
    { name: "nondefault query", flag: "1", params: { q: "Synthetic" }, previewCalls: 0 },
  ])("streams loading before exact data for $name", async ({ flag, params, previewCalls }) => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", flag);
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: "synthetic@example.invalid" }, navigationScope: "" });
    previewMock.mockRejectedValue(new Error("synthetic preview failure"));
    let release!: () => void;
    fullMock.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ page: 1, snapshot: "a".repeat(32) });
    }));

    const page = await HouseholdsPage({ searchParams: Promise.resolve(params) });
    let html = "";
    const errors: unknown[] = [];
    const output = new PassThrough();
    const completed = new Promise<void>((resolve, reject) => {
      output.on("data", (chunk: Buffer) => { html += chunk.toString(); });
      output.on("end", resolve);
      output.on("error", reject);
    });
    const stream = renderToPipeableStream(page, {
      onShellReady: () => stream.pipe(output),
      onError: (error) => { errors.push(error); },
    });
    try {
      await vi.waitFor(() => expect(html).toContain("Loading households…"));
      expect(html).not.toContain("Synthetic exact directory");
      expect(previewMock).toHaveBeenCalledTimes(previewCalls);
      expect(fullMock).toHaveBeenCalledWith(
        { role: "ADVISOR", email: "synthetic@example.invalid" },
        expect.objectContaining({ query: params.q ?? "" }), 1, 100,
      );
      release();
      await completed;
      expect(html).toContain("Synthetic exact directory");
      expect(errors).toEqual([]);
    } finally { stream.abort(); output.destroy(); }
  });

  it("propagates an exact-read failure instead of rendering a false empty directory", async () => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "0");
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: "synthetic@example.invalid" }, navigationScope: "" });
    const failure = new Error("synthetic exact read failure");
    fullMock.mockRejectedValue(failure);
    const page = await HouseholdsPage({ searchParams: Promise.resolve({}) });
    const errors: unknown[] = [];
    const html = await new Promise<string>((resolve, reject) => {
      const output = new PassThrough();
      let body = "";
      const stream = renderToPipeableStream(page, {
        onShellReady: () => stream.pipe(output),
        onError: (error) => { errors.push(error); },
      });
      output.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      output.on("end", () => resolve(body));
      output.on("error", reject);
    });
    expect(errors).toContain(failure);
    expect(html).toContain("Loading households…");
    expect(html).not.toContain("Synthetic exact directory");
    expect(previewMock).not.toHaveBeenCalled();
  });
});
