import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/health (public)", () => {
  it("returns { ok: true } with 200 regardless of DB state", async () => {
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true });
  });

  it("does NOT leak db status / uptime / version", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data).not.toHaveProperty("db");
    expect(data).not.toHaveProperty("uptime");
    expect(data).not.toHaveProperty("version");
    expect(data).not.toHaveProperty("timestamp");
  });
});
