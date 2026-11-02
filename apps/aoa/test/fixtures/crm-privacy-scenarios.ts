import type { CrmEdgeType, CrmIdType } from "@/lib/crm/contracts";

export type CrmPrivacyFixtureEntity = {
  id: string;
  type: CrmIdType;
};

export type CrmPrivacyFixtureEdge = {
  id: string;
  type: CrmEdgeType;
  from: string;
  to: string;
  status: "ACTIVE" | "REVOKED";
};

export type CrmPrivacyScenario = {
  id: string;
  description: string;
  principalId: string;
  resourceId: string;
  rlsVisible: boolean;
  relevantEdgeIds: string[];
  expectedDecision: "ALLOW" | "DENY";
  expectedReason: string;
};

// Synthetic contracts for later identity, graph, and authorization tests. They
// intentionally contain typed IDs only—no names, emails, account numbers, or
// source-system values that could be mistaken for client data.
export const CRM_PRIVACY_FIXTURE_ENTITIES: CrmPrivacyFixtureEntity[] = [
  { id: "hld_fixture_primary", type: "HOUSEHOLD" },
  { id: "hld_fixture_outside_book", type: "HOUSEHOLD" },
  { id: "hld_fixture_blended", type: "HOUSEHOLD" },
  { id: "hld_fixture_trust", type: "HOUSEHOLD" },
  { id: "con_fixture_advisor", type: "CONTACT" },
  { id: "con_fixture_spouse_a", type: "CONTACT" },
  { id: "con_fixture_spouse_b", type: "CONTACT" },
  { id: "con_fixture_child", type: "CONTACT" },
  { id: "con_fixture_trustee", type: "CONTACT" },
  { id: "con_fixture_merged_old", type: "CONTACT" },
  { id: "con_fixture_merged_survivor", type: "CONTACT" },
  { id: "acc_fixture_joint", type: "ACCOUNT" },
  { id: "acc_fixture_trust", type: "ACCOUNT" },
  { id: "doc_fixture_shared", type: "DOCUMENT" },
  { id: "doc_fixture_private", type: "DOCUMENT" },
  { id: "doc_fixture_tax", type: "DOCUMENT" },
  { id: "tpr_fixture_cpa", type: "THIRD_PARTY" },
];

export const CRM_PRIVACY_FIXTURE_EDGES: CrmPrivacyFixtureEdge[] = [
  {
    id: "rel_fixture_member_a",
    type: "HOUSEHOLD_HAS_MEMBER",
    from: "hld_fixture_primary",
    to: "con_fixture_spouse_a",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_member_b",
    type: "HOUSEHOLD_HAS_MEMBER",
    from: "hld_fixture_primary",
    to: "con_fixture_spouse_b",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_joint_owner_a",
    type: "PERSON_OWNS_ACCOUNT",
    from: "con_fixture_spouse_a",
    to: "acc_fixture_joint",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_joint_owner_b",
    type: "PERSON_OWNS_ACCOUNT",
    from: "con_fixture_spouse_b",
    to: "acc_fixture_joint",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_shared_document",
    type: "DOCUMENT_ABOUT_ENTITY",
    from: "doc_fixture_shared",
    to: "hld_fixture_primary",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_private_document",
    type: "DOCUMENT_ABOUT_ENTITY",
    from: "doc_fixture_private",
    to: "con_fixture_spouse_a",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_blended_child",
    type: "HOUSEHOLD_HAS_MEMBER",
    from: "hld_fixture_blended",
    to: "con_fixture_child",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_trust_account",
    type: "HOUSEHOLD_OWNS_ACCOUNT",
    from: "hld_fixture_trust",
    to: "acc_fixture_trust",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_trustee_authority",
    type: "PERSON_AUTHORIZES_PERSON",
    from: "con_fixture_spouse_a",
    to: "con_fixture_trustee",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_cpa_service",
    type: "THIRD_PARTY_SERVES_HOUSEHOLD",
    from: "tpr_fixture_cpa",
    to: "hld_fixture_primary",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_cpa_consent_active",
    type: "HOUSEHOLD_AUTHORIZES_THIRD_PARTY",
    from: "hld_fixture_primary",
    to: "tpr_fixture_cpa",
    status: "ACTIVE",
  },
  {
    id: "rel_fixture_cpa_consent_revoked",
    type: "HOUSEHOLD_AUTHORIZES_THIRD_PARTY",
    from: "hld_fixture_primary",
    to: "tpr_fixture_cpa",
    status: "REVOKED",
  },
  {
    id: "rel_fixture_tax_document",
    type: "DOCUMENT_ABOUT_ENTITY",
    from: "doc_fixture_tax",
    to: "hld_fixture_primary",
    status: "ACTIVE",
  },
];

export const CRM_PRIVACY_SCENARIOS: CrmPrivacyScenario[] = [
  {
    id: "advisor-in-book",
    description: "Existing RLS permits an advisor's household",
    principalId: "con_fixture_advisor",
    resourceId: "hld_fixture_primary",
    rlsVisible: true,
    relevantEdgeIds: [],
    expectedDecision: "ALLOW",
    expectedReason: "RLS_AND_ROLE_ALLOW",
  },
  {
    id: "advisor-outside-book",
    description: "No relationship can widen an RLS denial",
    principalId: "con_fixture_advisor",
    resourceId: "hld_fixture_outside_book",
    rlsVisible: false,
    relevantEdgeIds: ["rel_fixture_member_a"],
    expectedDecision: "DENY",
    expectedReason: "RLS_DENY",
  },
  {
    id: "spouse-shared-document",
    description: "Shared household document may be visible within approved client scope",
    principalId: "con_fixture_spouse_b",
    resourceId: "doc_fixture_shared",
    rlsVisible: true,
    relevantEdgeIds: ["rel_fixture_member_b", "rel_fixture_shared_document"],
    expectedDecision: "ALLOW",
    expectedReason: "APPROVED_SHARED_PATH",
  },
  {
    id: "spouse-private-document",
    description: "Household membership alone does not reveal a spouse-private document",
    principalId: "con_fixture_spouse_b",
    resourceId: "doc_fixture_private",
    rlsVisible: true,
    relevantEdgeIds: ["rel_fixture_member_b", "rel_fixture_private_document"],
    expectedDecision: "DENY",
    expectedReason: "CONSENT_REQUIRED",
  },
  {
    id: "blended-family-child",
    description: "Family membership does not imply access to a child's private record",
    principalId: "con_fixture_spouse_b",
    resourceId: "con_fixture_child",
    rlsVisible: true,
    relevantEdgeIds: ["rel_fixture_blended_child"],
    expectedDecision: "DENY",
    expectedReason: "NO_APPROVED_PATH",
  },
  {
    id: "third-party-service-only",
    description: "A service relationship is not third-party access authority",
    principalId: "tpr_fixture_cpa",
    resourceId: "doc_fixture_tax",
    rlsVisible: true,
    relevantEdgeIds: ["rel_fixture_cpa_service", "rel_fixture_tax_document"],
    expectedDecision: "DENY",
    expectedReason: "CONSENT_REQUIRED",
  },
  {
    id: "third-party-active-consent",
    description: "Active scoped consent can support a future third-party decision",
    principalId: "tpr_fixture_cpa",
    resourceId: "doc_fixture_tax",
    rlsVisible: true,
    relevantEdgeIds: [
      "rel_fixture_cpa_consent_active",
      "rel_fixture_tax_document",
    ],
    expectedDecision: "ALLOW",
    expectedReason: "ACTIVE_SCOPED_CONSENT",
  },
  {
    id: "third-party-revoked-consent",
    description: "Revocation denies access while retaining relationship history",
    principalId: "tpr_fixture_cpa",
    resourceId: "doc_fixture_tax",
    rlsVisible: true,
    relevantEdgeIds: [
      "rel_fixture_cpa_consent_revoked",
      "rel_fixture_tax_document",
    ],
    expectedDecision: "DENY",
    expectedReason: "CONSENT_REVOKED",
  },
];
