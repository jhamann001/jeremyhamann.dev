import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withUserScope } from "@/lib/rls";
import { prisma } from "@/lib/db";
import { getHouseholdDirectoryPreview } from "@/lib/data/households";

function isolatedDatabase() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return !process.env.K_SERVICE && !process.env.CLOUD_RUN_SERVICE &&
      url.hostname === "127.0.0.1" && url.port === "55444" &&
      url.pathname === "/aoa_pagination_synthetic" && url.username === "app_rw";
  } catch { return false; }
}

(isolatedDatabase() ? describe : describe.skip)("RLS observer with real synthetic PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("retains transaction-local identity and clears it after completion", async () => {
    const observed: string[] = [];
    const rows = await withUserScope({ role: "ADVISOR", email: "observer@example.invalid" }, async tx => {
      observed.push("query");
      return tx.$queryRaw<Array<{ role: string; email: string }>>`
        SELECT current_setting('app.user_role', true) AS role,
               current_setting('app.user_email', true) AS email`;
    }, { onTransactionAcquired: () => { observed.push("acquired"); } });
    expect(observed).toEqual(["acquired", "query"]);
    expect(rows).toEqual([{ role: "ADVISOR", email: "observer@example.invalid" }]);
    const cleared = await prisma.$queryRaw<Array<{ role: string; email: string }>>`
      SELECT COALESCE(current_setting('app.user_role', true), '') AS role,
             COALESCE(current_setting('app.user_email', true), '') AS email`;
    expect(cleared).toEqual([{ role: "", email: "" }]);
  });

  it("retains fail-closed scope even when the observer throws", async () => {
    const rows = await withUserScope({}, async tx => tx.$queryRaw<Array<{ role: string; email: string }>>`
      SELECT current_setting('app.user_role', true) AS role,
             current_setting('app.user_email', true) AS email`, {
      onTransactionAcquired: () => { throw new Error("observer unavailable"); },
    });
    expect(rows).toEqual([{ role: "VIEWER", email: "" }]);
  });

  it("records all four boundaries around the real preview transaction", async () => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const rows = await getHouseholdDirectoryPreview({ role: "OPERATIONS", email: "observer@example.invalid" });
      expect(rows.length).toBeLessThanOrEqual(100);
      const phases = log.mock.calls.map(([value]) => JSON.parse(String(value)))
        .filter(value => value.event === "directory.preview_phases");
      expect(phases).toHaveLength(1);
      expect(phases[0]).toMatchObject({ status: "success", failed_phase: null });
      const durations = ["acquire_begin_ms", "setup_ms", "sql_ms", "commit_ms"].map(key => phases[0][key]);
      expect(durations.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)).toBe(true);
      expect(Math.abs(durations.reduce((sum, value) => sum + value, 0) - phases[0].total_ms)).toBeLessThanOrEqual(2);
    } finally { log.mockRestore(); vi.unstubAllEnvs(); }
  });
});
