import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireIngestToken } from "../../lib/ingest/auth";

// Pure auth tests (no DB). The env var is toggled in-process per case — this is
// exactly why requireIngestToken reads process.env.INGEST_TOKEN at call time.
// All tokens are synthetic.

const TOKEN = "test-d2-secret-token";

function reqWith(auth?: string): Request {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://x/api/ingest/clients", { method: "POST", headers });
}

describe("requireIngestToken", () => {
  const original = process.env.INGEST_TOKEN;
  const originalPause = process.env.AOA_WRITES_PAUSED;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
    if (originalPause === undefined) delete process.env.AOA_WRITES_PAUSED;
    else process.env.AOA_WRITES_PAUSED = originalPause;
  });

  it("A1: env unset → { ok:false } + one counts-free config warn (no header value)", () => {
    delete process.env.INGEST_TOKEN;
    const result = requireIngestToken(reqWith(`Bearer ${TOKEN}`));
    expect(result.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("INGEST_TOKEN not configured");
    expect(line).not.toContain(TOKEN); // never echo the token/header
  });

  it("A2: no Authorization header → { ok:false }, NO config log", () => {
    process.env.INGEST_TOKEN = TOKEN;
    const result = requireIngestToken(reqWith(undefined));
    expect(result.ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("wrong scheme → { ok:false }, no log", () => {
    process.env.INGEST_TOKEN = TOKEN;
    expect(requireIngestToken(reqWith(`Basic ${TOKEN}`)).ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("empty token after Bearer → { ok:false }", () => {
    process.env.INGEST_TOKEN = TOKEN;
    expect(requireIngestToken(reqWith("Bearer ")).ok).toBe(false);
  });

  it("A3: wrong bearer → { ok:false } (constant-time path)", () => {
    process.env.INGEST_TOKEN = TOKEN;
    expect(requireIngestToken(reqWith("Bearer wrong")).ok).toBe(false);
  });

  it("A3b: same-length wrong bearer → { ok:false } (digest compare, no length short-circuit)", () => {
    process.env.INGEST_TOKEN = TOKEN;
    const sameLenWrong = "x".repeat(TOKEN.length);
    expect(requireIngestToken(reqWith(`Bearer ${sameLenWrong}`)).ok).toBe(false);
  });

  it("A4: right bearer → { ok:true }", () => {
    process.env.INGEST_TOKEN = TOKEN;
    expect(requireIngestToken(reqWith(`Bearer ${TOKEN}`)).ok).toBe(true);
  });

  it("fails closed during the owner-gated ingest pause even with the right bearer", () => {
    process.env.INGEST_TOKEN = TOKEN;
    process.env.AOA_WRITES_PAUSED = "true";
    expect(requireIngestToken(reqWith(`Bearer ${TOKEN}`)).ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an unexpected non-false pause value as paused", () => {
    process.env.INGEST_TOKEN = TOKEN;
    process.env.AOA_WRITES_PAUSED = "unexpected";
    expect(requireIngestToken(reqWith(`Bearer ${TOKEN}`)).ok).toBe(false);
  });

  it.each(["false", "0"])("does not pause for explicit %s", (value) => {
    process.env.INGEST_TOKEN = TOKEN;
    process.env.AOA_WRITES_PAUSED = value;
    expect(requireIngestToken(reqWith(`Bearer ${TOKEN}`)).ok).toBe(true);
  });
});
