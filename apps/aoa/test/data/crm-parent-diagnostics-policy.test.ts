import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "lib/crm/parent-diagnostics.ts"),
  "utf8",
);

const sqlStart = SOURCE.indexOf("const DIAGNOSTICS_SQL");
const sqlEnd = SOURCE.indexOf("function record", sqlStart);
const SQL = SOURCE.slice(sqlStart, sqlEnd);

describe("CRM missing-parent diagnostic policy", () => {
  it("reads only the seven approved parent-bearing domains", () => {
    for (const type of [
      "CONTACT",
      "DEAL",
      "TRANSFER",
      "EMAIL",
      "ACTIVITY",
      "TASK",
      "APPOINTMENT",
    ]) {
      expect(SQL).toContain(`'${type}'`);
    }
    expect(SQL).not.toMatch(/'ACCOUNT'\s*,\s*'CRM'/i);
  });

  it("does not read source content or financial fields", () => {
    for (const forbidden of [
      ".first_name",
      ".last_name",
      ".lead_advisor_email",
      ".subject",
      ".body",
      ".note",
      ".owner_name",
      ".account_number",
      ".value",
    ]) {
      expect(SQL).not.toContain(forbidden);
    }
  });

  it("treats only typed key-only parent feed rows as parent evidence", () => {
    expect(SQL).toContain("mirror.crm_parent_source");
    expect(SQL).toContain("p.parent_type = 'HOUSEHOLD'");
    expect(SQL).toContain("p.parent_type = 'CONTACT'");
    expect(SQL).toContain("p.normalized_key");
  });

  it("uses tombstones only to classify unresolved parents and active data to validate merge targets", () => {
    expect(SQL).toContain("mirror.crm_parent_orphan_evidence");
    expect(SQL).toContain("o.evidence_type = 'DELETED'");
    expect(SQL).toContain("o.evidence_type = 'MERGED'");
    expect(SQL).toContain("MERGED_TO_ACTIVE_PARENT");
    expect(SQL).toContain("MERGED_TO_MISSING_PARENT");
    expect(SQL).toContain("authoritative_household_keys");
    expect(SQL).toContain("authoritative_contact_keys");
  });

  it("returns aggregate dimensions and never emits raw source or parent keys", () => {
    const outputSection = SQL.slice(SQL.indexOf("SELECT jsonb_build_object"));
    expect(outputSection).not.toMatch(/'source_key'/i);
    expect(outputSection).not.toMatch(/'household_parent_key'/i);
    expect(outputSection).not.toMatch(/'contact_parent_key'/i);
    expect(outputSection).toContain("'distinct_unresolved_household_keys'");
    expect(outputSection).toContain("'household_key_findings'");
    expect(outputSection).toContain("'household_cross_domain'");
    expect(outputSection).toContain("'orphan_classification'");
    expect(outputSection).not.toMatch(/'replacement_key'/i);
    expect(outputSection).not.toMatch(/'normalized_key'/i);
  });

  it("uses exact-key evidence and contains no fuzzy matcher", () => {
    expect(SQL).not.toMatch(/ILIKE|similarity\s*\(|levenshtein\s*\(/i);
    expect(SQL).toMatch(
      /household_raw_normalized\.key = left\(m\.household_parent_key, 15\)/i,
    );
    expect(SQL).toMatch(/contact_raw_exact\.key = m\.contact_parent_key/i);
    expect(SQL).not.toMatch(/EXISTS\s*\(/i);
  });

  it("forces a read-only bounded transaction", () => {
    expect(SOURCE).toContain("SET TRANSACTION READ ONLY");
    expect(SOURCE).toContain("CRM_PARENT_DIAGNOSTICS_TIMEOUT_MS = 240_000");
  });
});
