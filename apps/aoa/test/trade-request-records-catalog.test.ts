import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORD_KINDS } from "@/lib/trade-requests/records/catalog";

const tables = RECORD_KINDS.map((k) => k.table);

describe("Trade Request record catalog", () => {
  it("has the 14 record kinds", () => {
    expect(RECORD_KINDS).toHaveLength(14);
  });

  it("names exactly the tables the DDL generator dumps", () => {
    const script = readFileSync(join(import.meta.dirname, "..", "scripts/trade-requests/build-trade-request-schema.sh"), "utf8");
    const line = script.match(/^TABLES="([^"]+)"$/m);
    expect(line).not.toBeNull();
    expect(tables).toEqual(line![1].split(" "));
  });

  it("orders every standalone foreign-key parent before its child", () => {
    const edges: Array<[string, string]> = [
      ["users", "trade_requests"],
      ["users", "audit_logs"],
      ["users", "notifications"],
      ["users", "client_exclusions"],
      ["users", "account_exclusions"],
      ["users", "drift_status_overrides"],
      ["clients", "accounts"],
      ["trade_requests", "audit_logs"],
      ["trade_requests", "notifications"],
    ];
    for (const [parent, child] of edges) expect(tables.indexOf(parent), `${parent} before ${child}`).toBeLessThan(tables.indexOf(child));
  });
});
