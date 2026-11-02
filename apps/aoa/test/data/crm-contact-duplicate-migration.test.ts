import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260827190500_crm_contact_duplicate_review/migration.sql",
), "utf8");
const reasonConstraintHotfix = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260828150000_crm_contact_duplicate_reason_constraint/migration.sql",
), "utf8");
const identityConflictOverride = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260828190000_crm_contact_identity_conflict_override/migration.sql",
), "utf8");
const operatorContactOverride = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260828211500_crm_operator_contact_identity_override/migration.sql",
), "utf8");
const resolver = readFileSync(join(process.cwd(), "lib/crm/resolve.ts"), "utf8");
const clients = readFileSync(join(process.cwd(), "lib/data/clients.ts"), "utf8");
const households = readFileSync(join(process.cwd(), "lib/data/households.ts"), "utf8");
const navCounts = readFileSync(join(process.cwd(), "lib/data/nav-counts.ts"), "utf8");
const review = readFileSync(join(process.cwd(), "lib/data/crm-duplicate-review.ts"), "utf8");

describe("CRM contact duplicate review", () => {
  it("detects only exact-name contacts inside one canonical household", () => {
    expect(migration).toContain("EXACT_NORMALIZED_CONTACT_NAME");
    expect(migration).toContain("SAME_CANONICAL_HOUSEHOLD");
    expect(migration).toContain("canonical_household_key");
    expect(migration).toContain("right_side.rank_in_cluster = 2");
    expect(migration).toContain("left_side.rank_in_cluster = 1");
    expect(migration).not.toMatch(/UPDATE\s+mirror\.client/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+mirror\.client/i);
  });

  it("keeps the decision human, reversible, and contact-specific", () => {
    expect(migration).toContain("resolve_crm_canonical_contact_source_key");
    expect(migration).toContain("review_crm_duplicate_candidate_v4");
    expect(migration).toContain("SAME_PERSON_SOURCE_DUPLICATE");
    expect(review).toContain("app.review_crm_duplicate_candidate_v5");
    expect(review).toContain("CONFLICTING_CONTACT_IDENTITY");
  });

  it("permits the controlled contact confirmation reason at the table boundary", () => {
    expect(reasonConstraintHotfix).toContain(
      "DROP CONSTRAINT crm_duplicate_candidate_reason_controlled",
    );
    expect(reasonConstraintHotfix).toContain("SAME_PERSON_SOURCE_DUPLICATE");
    expect(reasonConstraintHotfix).toMatch(
      /ADD CONSTRAINT crm_duplicate_candidate_reason_controlled CHECK/,
    );
    expect(reasonConstraintHotfix).not.toMatch(/free[_ ]?text|decision_note|comment_text/i);
  });

  it("limits evidence access and audits a later unsafe conflict", () => {
    expect(migration).toContain("client_account_aum_duplicate_definer_read");
    expect(migration).toContain("deal_duplicate_definer_read");
    expect(migration).toContain("crm_contact_duplicate_invalidation");
    expect(migration).toContain("INVALIDATED_BY_CONFLICT");
    expect(migration).not.toMatch(
      /GRANT\s+SELECT[^;]+client_account_aum[^;]+identity_reconciler/is,
    );
  });

  it("bounds the identity-conflict override to one audited contact warning", () => {
    expect(identityConflictOverride).toContain("review_crm_duplicate_candidate_v5");
    expect(identityConflictOverride).toContain("accepted_hard_conflict_codes");
    expect(identityConflictOverride).toContain("conflict_override_at");
    expect(identityConflictOverride).toContain("conflict_override_by");
    expect(identityConflictOverride).toContain("EXACT_NORMALIZED_CONTACT_NAME");
    expect(identityConflictOverride).toContain("SAME_CANONICAL_HOUSEHOLD");
    expect(identityConflictOverride).toContain("CONFLICTING_CONTACT_IDENTITY");
    expect(identityConflictOverride).toContain("INVALIDATED_BY_CONFLICT");
    expect(identityConflictOverride).not.toMatch(/UPDATE\s+mirror\.client/i);
    expect(identityConflictOverride).not.toMatch(/DELETE\s+FROM\s+mirror\.client/i);
  });

  it("lets a reviewed Operations nickname pair use only the same bounded override", () => {
    expect(operatorContactOverride).toContain(
      "DROP CONSTRAINT crm_duplicate_candidate_conflict_override_consistent",
    );
    expect(operatorContactOverride).toContain(
      "ADD CONSTRAINT crm_duplicate_candidate_conflict_override_consistent CHECK",
    );
    expect(operatorContactOverride).toContain(
      "DROP CONSTRAINT crm_duplicate_candidate_ready_without_conflicts",
    );
    expect(operatorContactOverride).toContain(
      "ADD CONSTRAINT crm_duplicate_candidate_ready_without_conflicts CHECK",
    );
    expect(operatorContactOverride).toContain("candidate.operator_flagged");
    expect(operatorContactOverride).toContain("OPERATOR_SUBMITTED");
    expect(operatorContactOverride).toContain("SAME_CANONICAL_HOUSEHOLD");
    expect(operatorContactOverride).toContain("CONFLICTING_CONTACT_IDENTITY");
    expect(operatorContactOverride).toContain("accepted_hard_conflict_codes");
    expect(operatorContactOverride).toContain("revalidate_accepted_contact_identity_conflicts");
    expect(operatorContactOverride).not.toMatch(/UPDATE\s+mirror\.client/i);
    expect(operatorContactOverride).not.toMatch(/DELETE\s+FROM\s+mirror\.client/i);
  });

  it("hides only confirmed contact shells from normal AOA browsing", () => {
    expect(resolver).toContain("resolve_crm_canonical_contact_source_key");
    expect(clients).toContain("resolve_crm_canonical_contact_overlays");
    expect(households).toContain("resolve_crm_canonical_contact_overlays");
    expect(navCounts).toContain("resolve_crm_canonical_contact_overlays");
    expect(clients).toContain("contact_overlay.source_key IS NULL");
    expect(households).toContain("contact_overlay.source_key IS NULL");
  });
});
