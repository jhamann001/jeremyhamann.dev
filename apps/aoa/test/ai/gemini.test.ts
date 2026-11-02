import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// gemini.ts — keyless Vertex client, WITHOUT the network or GCP. server-only is
// stubbed; google-auth-library's GoogleAuth is mocked to hand back a fixed token;
// global fetch is a spy returning canned Vertex responses. Asserts the global-vs-
// regional host, the model + user-project header, the 404→fallback, and the error
// mapping — all without a real call.
vi.mock("server-only", () => ({}));

const { getAccessTokenSpy } = vi.hoisted(() => ({
  getAccessTokenSpy: vi.fn(async () => "test-token" as string | null),
}));
vi.mock("google-auth-library", () => ({
  // A class (not an arrow fn) so `new GoogleAuth(...)` in gemini.ts constructs.
  GoogleAuth: class {
    getAccessToken = getAccessTokenSpy;
  },
}));

import { AiError, generateText, geminiConfig } from "@/lib/ai/gemini";

function ok(text: string, finishReason = "STOP") {
  return {
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
    }),
  };
}
function status(code: number) {
  return { status: code, json: async () => ({ error: { code } }) };
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  getAccessTokenSpy.mockReset().mockResolvedValue("test-token");
  process.env.VERTEX_PROJECT = "test-proj";
  process.env.VERTEX_LOCATION = "global";
  process.env.GEMINI_MODEL = "gemini-3.8-flash";
  process.env.GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";
});
afterEach(() => vi.unstubAllGlobals());

describe("geminiConfig", () => {
  it("defaults location=global and the 3.8/3.5 model pair", () => {
    delete process.env.VERTEX_LOCATION;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODEL;
    const c = geminiConfig();
    expect(c).toMatchObject({
      location: "global",
      model: "gemini-3.8-flash",
      fallbackModel: "gemini-3.5-flash",
    });
  });
});

describe("generateText", () => {
  it("calls the GLOBAL endpoint with the model + user-project header and returns text", async () => {
    fetchSpy.mockResolvedValueOnce(ok("hello"));
    const res = await generateText({ prompt: "hi", system: "be nice" });
    expect(res).toEqual({ text: "hello", model: "gemini-3.8-flash", finishReason: "STOP" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-proj/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
    );
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(init.headers["x-goog-user-project"]).toBe("test-proj");
    const body = JSON.parse(init.body);
    expect(body.systemInstruction.parts[0].text).toBe("be nice");
    expect(body.contents[0].parts[0].text).toBe("hi");
    expect(body.generationConfig.maxOutputTokens).toBe(2048); // generous default (thinking budget)
  });

  it("falls back to the stable 3.5 model on a 404, once", async () => {
    fetchSpy.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(ok("from fallback"));
    const res = await generateText({ prompt: "hi" });
    expect(res.model).toBe("gemini-3.5-flash");
    expect(res.text).toBe("from fallback");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain("gemini-3.5-flash");
  });

  it("does NOT fall back on a non-404 error", async () => {
    fetchSpy.mockResolvedValueOnce(status(500));
    await expect(generateText({ prompt: "hi" })).rejects.toMatchObject({ reason: "upstream_error" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps 401/403 → unauthorized, 429 → rate_limited", async () => {
    fetchSpy.mockResolvedValueOnce(status(403));
    await expect(generateText({ prompt: "hi" })).rejects.toMatchObject({ reason: "unauthorized" });
    fetchSpy.mockResolvedValueOnce(status(429));
    await expect(generateText({ prompt: "hi" })).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("empty text (thinking-only MAX_TOKENS) → empty_response", async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }),
    });
    await expect(generateText({ prompt: "hi" })).rejects.toMatchObject({ reason: "empty_response" });
  });

  it("regional location → regional host", async () => {
    process.env.VERTEX_LOCATION = "us-central1";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";
    fetchSpy.mockResolvedValueOnce(ok("ok"));
    await generateText({ prompt: "hi" });
    expect(fetchSpy.mock.calls[0][0]).toContain("us-central1-aiplatform.googleapis.com");
  });

  it("no project configured → config_error, no fetch", async () => {
    delete process.env.VERTEX_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    await expect(generateText({ prompt: "hi" })).rejects.toMatchObject({ reason: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no access token → unauthorized", async () => {
    getAccessTokenSpy.mockResolvedValueOnce(null);
    await expect(generateText({ prompt: "hi" })).rejects.toBeInstanceOf(AiError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
