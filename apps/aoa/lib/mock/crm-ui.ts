// Deterministic, unmistakably synthetic fixtures for the dev-only CRM UI
// prototypes. These records never pass through Prisma, RLS, ingest, or the CRM
// identity registry. Production cannot render their consumers because each
// route also requires APP_ENV=dev.

export type CrmPreviewNodeType =
  | "household"
  | "person"
  | "account"
  | "document"
  | "thirdParty"
  | "deal";

export type CrmPreviewNode = {
  id: string;
  label: string;
  subtitle: string;
  type: CrmPreviewNodeType;
  x: number;
  y: number;
  pointer: string;
};

export type CrmPreviewEdge = {
  id: string;
  from: string;
  to: string;
  relationship: string;
  scope: "household" | "private" | "consent" | "workflow";
};

export type CrmPreviewHousehold = {
  id: string;
  name: string;
  advisor: string;
  aum: number;
  nodes: CrmPreviewNode[];
  edges: CrmPreviewEdge[];
};

export const CRM_PREVIEW_HOUSEHOLDS: CrmPreviewHousehold[] = [
  {
    id: "hld_demo_northstar",
    name: "Northstar Demo Household",
    advisor: "Demo Advisor",
    aum: 8420000,
    nodes: [
      { id: "hld_demo_northstar", label: "Northstar Demo", subtitle: "Household", type: "household", x: 50, y: 13, pointer: "CRM Account · demo" },
      { id: "con_demo_avery", label: "Lonie Carroll", subtitle: "Primary client", type: "person", x: 25, y: 36, pointer: "CRM Contact · demo" },
      { id: "con_demo_morgan", label: "Brennan Balistreri", subtitle: "Spouse", type: "person", x: 75, y: 36, pointer: "CRM Contact · demo" },
      { id: "acc_demo_joint", label: "Joint Brokerage", subtitle: "$5.8M · Apex", type: "account", x: 17, y: 67, pointer: "Apex account · demo" },
      { id: "acc_demo_trust", label: "Family Trust", subtitle: "$2.6M · Schwab", type: "account", x: 43, y: 76, pointer: "Custodian account · demo" },
      { id: "doc_demo_estate", label: "Estate Plan", subtitle: "Shared document", type: "document", x: 70, y: 70, pointer: "Egnyte pointer · demo" },
      { id: "tpr_demo_cpa", label: "Demo CPA", subtitle: "External professional", type: "thirdParty", x: 88, y: 58, pointer: "Firm directory · demo" },
      { id: "dea_demo_rollover", label: "Rollover", subtitle: "$425K · Funding", type: "deal", x: 55, y: 48, pointer: "AOA deal · demo" },
    ],
    edges: [
      { id: "rel_demo_1", from: "hld_demo_northstar", to: "con_demo_avery", relationship: "HAS_MEMBER", scope: "household" },
      { id: "rel_demo_2", from: "hld_demo_northstar", to: "con_demo_morgan", relationship: "HAS_MEMBER", scope: "household" },
      { id: "rel_demo_3", from: "con_demo_avery", to: "acc_demo_joint", relationship: "OWNS", scope: "household" },
      { id: "rel_demo_4", from: "con_demo_morgan", to: "acc_demo_joint", relationship: "OWNS", scope: "household" },
      { id: "rel_demo_5", from: "con_demo_avery", to: "acc_demo_trust", relationship: "TRUSTEE_OF", scope: "private" },
      { id: "rel_demo_6", from: "con_demo_morgan", to: "doc_demo_estate", relationship: "HAS_SHARED_FILE", scope: "household" },
      { id: "rel_demo_7", from: "doc_demo_estate", to: "tpr_demo_cpa", relationship: "CPA_AUTHORIZED", scope: "consent" },
      { id: "rel_demo_8", from: "dea_demo_rollover", to: "acc_demo_joint", relationship: "FUNDS_INTO", scope: "workflow" },
      { id: "rel_demo_9", from: "hld_demo_northstar", to: "dea_demo_rollover", relationship: "HAS_DEAL", scope: "workflow" },
    ],
  },
  {
    id: "hld_demo_harbor",
    name: "Harbor Demo Household",
    advisor: "Demo Advisor",
    aum: 3180000,
    nodes: [
      { id: "hld_demo_harbor", label: "Harbor Demo", subtitle: "Household", type: "household", x: 50, y: 14, pointer: "CRM Account · demo" },
      { id: "con_demo_riley", label: "Abel Bechtelar", subtitle: "Primary client", type: "person", x: 33, y: 40, pointer: "CRM Contact · demo" },
      { id: "con_demo_jordan", label: "Ryder Abernathy", subtitle: "Adult child", type: "person", x: 70, y: 43, pointer: "CRM Contact · demo" },
      { id: "acc_demo_ira", label: "Traditional IRA", subtitle: "$2.1M · Schwab", type: "account", x: 25, y: 72, pointer: "Custodian account · demo" },
      { id: "acc_demo_taxable", label: "Individual Brokerage", subtitle: "$1.1M · Apex", type: "account", x: 55, y: 72, pointer: "Apex account · demo" },
      { id: "doc_demo_tax", label: "2025 Tax Return", subtitle: "Private document", type: "document", x: 82, y: 70, pointer: "Egnyte pointer · demo" },
    ],
    edges: [
      { id: "rel_demo_10", from: "hld_demo_harbor", to: "con_demo_riley", relationship: "HAS_MEMBER", scope: "household" },
      { id: "rel_demo_11", from: "hld_demo_harbor", to: "con_demo_jordan", relationship: "HAS_MEMBER", scope: "household" },
      { id: "rel_demo_12", from: "con_demo_riley", to: "acc_demo_ira", relationship: "OWNS", scope: "private" },
      { id: "rel_demo_13", from: "con_demo_riley", to: "acc_demo_taxable", relationship: "OWNS", scope: "household" },
      { id: "rel_demo_14", from: "con_demo_riley", to: "doc_demo_tax", relationship: "HAS_PRIVATE_FILE", scope: "private" },
    ],
  },
];

export type CrmPreviewDocument = {
  id: string;
  name: string;
  category: string;
  vault: string;
  scope: "Shared" | "Private";
  externalAccess: string;
  updated: string;
};

export const CRM_PREVIEW_DOCUMENTS: CrmPreviewDocument[] = [
  { id: "doc_demo_estate", name: "Demo Estate Plan.pdf", category: "Estate", vault: "Egnyte pointer", scope: "Shared", externalAccess: "Demo CPA · authorized", updated: "Jul 24, 2026" },
  { id: "doc_demo_tax", name: "Demo 2025 Tax Return.pdf", category: "Tax", vault: "Egnyte pointer", scope: "Private", externalAccess: "Household only", updated: "Jul 18, 2026" },
  { id: "doc_demo_ips", name: "Demo Investment Policy.pdf", category: "Investment", vault: "Egnyte pointer", scope: "Shared", externalAccess: "Household only", updated: "Jul 9, 2026" },
];

