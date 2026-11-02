import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every native write names catalog tables as trade_request.<table>, uses AOA's Prisma client (no second pool),
// and never touches the stored execution plan or the engine (ticket, epic AC-5).
const DIR = join(process.cwd(), "lib/trade-requests/native/writes");
const CATALOG = [
  "users", "clients", "accounts", "trade_requests", "audit_logs", "notifications", "client_exclusions", "account_exclusions",
  "digest_runs", "registry_drift_runs", "position_drift_accounts", "drift_alert_sends", "drift_status_overrides", "security_sector",
];
const sources = () => readdirSync(DIR).filter((f) => f.endsWith(".ts")).map((f) => ({ file: f, text: readFileSync(join(DIR, f), "utf8") }));

describe("native write SQL guard", () => {
  it("qualifies every catalog table it reads or writes with trade_request.", () => {
    const unqualified: string[] = [];
    let qualified = 0;
    for (const { file, text } of sources()) {
      for (const match of text.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([A-Za-z_][\w.]*)/g)) {
        const name = match[1];
        if (name.startsWith("trade_request.")) qualified += 1;
        else if (CATALOG.includes(name.split(".").pop()!)) unqualified.push(`${file}: ${name}`);
      }
    }
    expect(unqualified).toEqual([]);
    expect(qualified).toBeGreaterThanOrEqual(15);
  });

  it("uses no second database client and never names the plan column or the engine", () => {
    const offenders = sources()
      .filter(({ text }) => /from "pg"|new PrismaClient|execution_plan|executionPlan|assetLocationEngine|runAssetLocationEngine/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    expect(sources().length).toBeGreaterThanOrEqual(8);
  });
});
