import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260807210000_crm_relationship_contact_visibility/migration.sql",
  ),
  "utf8",
);

const sqlOnly = SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("CRM relationship Cloud SQL contact visibility migration", () => {
  it("targets the exact constrained snapshot function owner", () => {
    expect(sqlOnly).toContain(
      "app.reconcile_crm_relationship_snapshot(text,boolean,boolean,boolean)",
    );
    expect(sqlOnly).toMatch(/pg_get_userbyid\(p\.proowner\)/i);
    expect(sqlOnly).not.toMatch(/WHERE rolname IN/i);
  });

  it("adds only a SELECT policy on mirror.client", () => {
    expect(sqlOnly).toMatch(
      /CREATE POLICY client_crm_relationship_definer_read[\s\S]*?ON mirror\.client FOR SELECT TO %s USING \(true\)/i,
    );
    expect(sqlOnly).not.toMatch(/FOR\s+(?:ALL|INSERT|UPDATE|DELETE)/i);
    expect(sqlOnly).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/i);
    expect(sqlOnly).not.toMatch(/ALTER TABLE\s+mirror\.client\s+NO FORCE/i);
  });

  it("fails closed if the deployed reconciliation function is absent", () => {
    expect(sqlOnly).toMatch(/IF reconciler_function IS NULL/i);
    expect(sqlOnly).toContain(
      "RAISE EXCEPTION 'CRM relationship reconciliation function is missing'",
    );
  });
});
