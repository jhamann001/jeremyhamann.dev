// Synthetic people/accounts only; never copy production source rows here.
export const alice = "user-11111111-1111-4111-8111-111111111111";
export const bob = "user-22222222-2222-4222-8222-222222222222";
export const fingerprint = "a".repeat(64);
export function directoryRows(now = new Date().toISOString()): Array<Record<string, unknown>> {
  return [
    { row_kind: "manifest", contract_version: 1, complete: true, source: "synthetic-verified-directory",
      source_as_of: now, source_health: "FRESH", query_fingerprint: fingerprint,
      expected_clients: 2, expected_accounts: 1, expected_memberships: 2 },
    { row_kind: "client", cedar_ridge_user_id: alice, canonical_name: "Alex Example", eligibility: "ACTIVE", source: "synthetic" },
    { row_kind: "client", cedar_ridge_user_id: bob, canonical_name: "Alex Example", eligibility: "ACTIVE", source: "synthetic" },
    { row_kind: "account", investment_account_id: "synthetic-directory-account", custodian: "APEX", account_number: " 001AbC12 ", account_status: "open" },
    { row_kind: "membership", investment_account_id: "synthetic-directory-account", cedar_ridge_user_id: alice, relationship_type: "PRIMARY" },
    { row_kind: "membership", investment_account_id: "synthetic-directory-account", cedar_ridge_user_id: bob, relationship_type: "JOINT" },
  ];
}
