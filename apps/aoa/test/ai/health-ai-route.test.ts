import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/health/ai probe — auth gate + response shape, with the deps mocked.
// AiError stays REAL (importActual) so the route's `instanceof AiError` branch
// works; generateText + geminiConfig are overridden.
vi.mock("server-only", () => ({}));

const { requireIngestTokenSpy, generateTextSpy } = vi.hoisted(() => ({
  requireIngestTokenSpy: vi.fn(() => ({ ok: true }) as { ok: boolean }),
  generateTextSpy: vi.fn(),
}));
vi.mock("@/lib/ingest/auth", () => ({ requireIngestToken: requireIngestTokenSpy }));
vi.mock("@/lib/flags", () => ({ aiDraftingEnabled: () => false }));
vi.mock("@/lib/ai/gemini", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/gemini")>()),
  generateText: generateTextSpy,
  geminiConfig: () => ({
    project: "p",
    location: "global",
    model: "gemini-3.8-flash",
    fallbackModel: "gemini-3.5-flash",
  }),
}));

import { GET, PUT } from "@/app/api/health/ai/route";
import { AiError } from "@/lib/ai/gemini";

const req = () => new Request("http://x/api/health/ai", { headers: { Authorization: "Bearer t" } });

beforeEach(() => {
  requireIngestTokenSpy.mockReturnValue({ ok: true });
  generateTextSpy.mockReset();
});

describe("/api/health/ai", () => {
  it("PUT → 405", async () => {
    expect((await PUT()).status).toBe(405);
  });

  it("no/invalid ingest token → 401, no model call", async () => {
    requireIngestTokenSpy.mockReturnValue({ ok: false });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(generateTextSpy).not.toHaveBeenCalled();
  });

  it("model answers → 200 with model + latency, and NEVER the model's text", async () => {
    generateTextSpy.mockResolvedValue({
      text: "ok",
      model: "gemini-3.8-flash",
      finishReason: "STOP",
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      model: "gemini-3.8-flash",
      configuredModel: "gemini-3.8-flash",
      location: "global",
      aiDraftingEnabled: false,
    });
    expect(typeof body.latencyMs).toBe("number");
    // The probe must not echo the model output.
    expect(JSON.stringify(body)).not.toContain('"text"');
  });

  it("model unavailable → 503 with the static reason (no secrets)", async () => {
    generateTextSpy.mockRejectedValue(new AiError("x", "model_not_found"));
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: "model_not_found" });
  });
});
