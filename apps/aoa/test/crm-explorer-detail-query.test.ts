import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CRM Explorer detail query", () => {
  it("runs only type-compatible relationship branches anchored to the selected identity", () => {
    const source = readFileSync("lib/data/crm-explorer.ts", "utf8");
    const helper = source.slice(
      source.indexOf("function connectionLinksForIdentity("),
      source.indexOf("export async function getCrmIdentityDetail("),
    );

    for (const identityType of [
      "HOUSEHOLD", "CONTACT", "DEAL", "TRANSFER", "EMAIL", "ACTIVITY", "TASK", "APPOINTMENT",
    ]) {
      expect(helper).toContain(`case "${identityType}":`);
    }
    expect(helper.match(/identity_id = \$\{identityId\}/g)).toHaveLength(22);
    expect(helper).not.toMatch(/identity_id = \$\{identityId\}\s+OR/);
    expect(helper).not.toMatch(/OR\s+\w+\.identity_id = \$\{identityId\}/);
    expect(source).toContain("const connectionLinks = connectionLinksForIdentity(row.identity_type, row.id)");
    expect(source).toContain("WITH links AS (${connectionLinks}), selected AS (");
    expect(source).not.toContain("const otherIdentityRows");
    expect(source).toContain("SELECT m.id, m.identity_id, i.identity_type");
    expect(source).toContain("const detailRows = await tx.$queryRaw");
    expect(source).toContain("'MERGED_FROM'::text");
  });

  it("pages identities before aggregating their mappings", () => {
    const source = readFileSync("lib/data/crm-explorer.ts", "utf8");
    const list = source.slice(
      source.indexOf("export async function listCrmIdentities("),
      source.indexOf("type ConnectionCode"),
    );

    expect(list).toContain("WITH page_rows AS MATERIALIZED (");
    expect(list).not.toContain("open_identity AS MATERIALIZED (");
    expect(list).not.toContain("count(*) OVER()::bigint");
    expect(list).toContain("mapping_summary AS (");
    expect(list).toContain("exception_summary AS (");
    expect(list).toContain("JOIN page_rows p ON p.id = m.identity_id");
    expect(list).toContain("ORDER BY i.updated_at DESC, i.id");
    expect(list).not.toContain("ORDER BY (oi.identity_id IS NOT NULL) DESC");
    expect(list).not.toContain("WHERE m.identity_id = i.id)::bigint");
    expect(list).toContain("rawRows.map((row) => row.id),\n      false,");
  });

  it("batches parent routes on list pages but preserves inline detail routes", () => {
    const source = readFileSync("lib/data/crm-explorer.ts", "utf8");
    const mappings = source.slice(
      source.indexOf("async function mappingsForIdentityIds("),
      source.indexOf("export async function listCrmIdentities("),
    );

    expect(mappings).toContain("includeInlineParentRoutes = true");
    expect(mappings.match(/AND \$\{includeInlineParentRoutes\} THEN \(/g)).toHaveLength(3);
    expect(mappings).toContain("if (!includeInlineParentRoutes) {");
    expect(mappings).toContain("SELECT DISTINCT ON (left(m.source_key, 15))");
    expect(mappings).toContain("AND left(m.source_key, 15) IN (${Prisma.join(parentKeys)})");
    expect(source).toContain("mappingsForIdentityIds(tx, [row.id])");
    expect(source).toContain("mappingsForIdentityIds(tx, otherIds)");
  });

  it("uses fresh scoped totals for a consistent progressive sequence", () => {
    const source = readFileSync("lib/data/crm-explorer.ts", "utf8");
    const list = source.slice(
      source.indexOf("export async function listCrmIdentities("),
      source.indexOf("type ConnectionCode"),
    );

    expect(list).toContain("let totalNumber = navigation.stats.identities;");
    expect(list).toContain("readCrmNavigationState(tx)");
    expect(list).toContain("Prisma.TransactionIsolationLevel.RepeatableRead");
    expect(list).toContain("if (filtered) {");
    expect(list).toContain("SELECT count(*)::bigint AS total FROM app.crm_identity i ${where}");
  });

  it("emits dev-only timings without logging CRM IDs or search text", () => {
    const source = readFileSync("lib/data/crm-explorer.ts", "utf8");
    const timing = source.slice(
      source.indexOf("function logCrmExplorerTiming("),
      source.indexOf("export function canReadCrmExplorer("),
    );

    expect(timing).toContain('process.env.APP_ENV?.toLowerCase() !== "dev"');
    expect(timing).toContain('event: "crm_explorer_timing"');
    expect(timing).not.toContain("crmId");
    expect(timing).not.toContain("identity.email");
    expect(timing).not.toContain("query.q");
  });
});
