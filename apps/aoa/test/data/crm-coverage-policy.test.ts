import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "lib/crm/coverage.ts"),
  "utf8",
);
const sqlStart = SOURCE.indexOf("const COVERAGE_SQL");
const sqlEnd = SOURCE.indexOf("export const CRM_COVERAGE_TIMEOUT_MS", sqlStart);
const SQL = SOURCE.slice(sqlStart, sqlEnd);

describe("CRM coverage diagnostic policy", () => {
  it("measures all eight approved identity domains and the deal alias", () => {
    for (const type of [
      "HOUSEHOLD",
      "CONTACT",
      "DEAL",
      "TRANSFER",
      "TASK",
      "EMAIL",
      "ACTIVITY",
      "APPOINTMENT",
    ]) {
      expect(SQL).toContain(`'${type}'`);
    }
    expect(SQL).toContain("'opportunity'");
    expect(SQL).not.toMatch(/'ACCOUNT'|'DOCUMENT'|'THIRD_PARTY'/);
  });

  it("runs read-only and returns aggregates rather than source keys", () => {
    expect(SOURCE).toMatch(/SET TRANSACTION READ ONLY/);
    expect(SQL).toMatch(/GROUP BY identity_type, source_system, source_namespace/);
    expect(SQL).not.toMatch(/SELECT[\s\S]*?source_key\s+FROM coverage_rows/i);
  });

  it("does not read client content or financial fields", () => {
    expect(SQL).not.toMatch(
      /\b(?:first_name|last_name|name|email_address|subject|body|description|note|value|amount|account_number)\b/i,
    );
  });
});
