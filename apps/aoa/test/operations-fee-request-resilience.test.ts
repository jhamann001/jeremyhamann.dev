import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const feeRequests = read("lib/data/operations-fee-requests.ts");
const intake = read("components/operations/FeeRequestIntake.tsx");
const actions = read("app/(authenticated)/operations/fee-requests/actions.ts");

describe("Operations fee-request page resilience", () => {
  it("keeps initial page reads bounded to displayed request history", () => {
    expect(feeRequests).toContain("await withUserScope(");
    expect(feeRequests).not.toContain("await listClientsWithinUserScope(tx)");
    expect(feeRequests).not.toContain("LIMIT 10000");
    expect(feeRequests).toContain("take: 100");
    expect(feeRequests).toContain("custodian_account_id IN");
    expect(feeRequests).not.toContain("await Promise.all([");
  });

  it("searches clients on demand through the same authorized RLS boundary", () => {
    expect(intake).toContain("searchOperationsFeeClients(query)");
    expect(intake).toContain("query.length < 2");
    expect(actions).toContain("canAccessOperationsTools(role)");
    expect(actions).toContain("searchOperationsFeeClientOptions");
    expect(feeRequests).toContain("LIMIT 20");
    expect(feeRequests).toContain("matching_client_name AS MATERIALIZED");
    expect(feeRequests).toContain("matching_client_household AS MATERIALIZED");
    expect(intake).toContain("17_000");
    expect(intake).toContain('setClientSearchState("error")');
    expect(feeRequests).toContain("resolve_crm_canonical_contact_overlays");
    expect(feeRequests).toContain("{ maxWait: 10_000, timeout: 15_000 }");
  });
});
