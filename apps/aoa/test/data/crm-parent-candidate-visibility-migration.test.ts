import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(
  import.meta.dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260821190000_crm_parent_candidate_visibility",
  "migration.sql",
), "utf8");

describe("CRM parent candidate visibility migration", () => {
  it("canonicalizes only the approved Salesforce parent namespaces", () => {
    expect(SQL).toContain("ALTER POLICY crm_source_mapping_app_read");
    expect(SQL).toMatch(/source_namespace = 'household'[\s\S]*left\(h\.sf_id, 15\) = left\(source_key, 15\)/);
    expect(SQL).toMatch(/source_namespace = 'contact'[\s\S]*left\(c\.sf_id, 15\) = left\(source_key, 15\)/);
    expect(SQL).toMatch(/source_namespace = 'email'[\s\S]*e\.sf_id = source_key/);
    expect(SQL).toMatch(/source_namespace = 'activity'[\s\S]*a\.sf_id = source_key/);
  });

  it("adds canonical lookup indexes to both parent mirrors", () => {
    expect(SQL).toMatch(/ON mirror\.household \(left\(sf_id, 15\)\)/);
    expect(SQL).toMatch(/ON mirror\.client \(left\(sf_id, 15\)\)/);
  });
});
