import type { IntendedAction } from "@/lib/data/workflow-types";

// Seed catalog of intended actions → form requirements (ticket, Phase 1).
// Each action lists the forms it always needs plus conditional forms gated on
// ops-entered client state. Every `code` must key into DOCS (lib/mock/apex-docs).
// Conditional ACH: any disbursement/funding action needs an ACH Authorization
// Agreement when the client has no linked bank account on file.
export const INTENDED_ACTIONS: Record<string, IntendedAction> = {
  ira_distribution: {
    id: "ira_distribution",
    label: "IRA Distribution",
    requires: [
      { code: "iradist" },
      {
        code: "ach",
        when: { field: "hasLinkedBank", equals: false },
        reason: "ACH Authorization Agreement — no linked bank account on file",
      },
    ],
  },
  acat_transfer: {
    id: "acat_transfer",
    label: "ACAT Transfer In",
    requires: [{ code: "acat" }],
  },
  wire: {
    id: "wire",
    label: "Wire Transfer",
    requires: [
      { code: "wire" },
      {
        code: "ach",
        when: { field: "hasLinkedBank", equals: false },
        reason: "ACH Authorization Agreement — no linked bank account on file",
      },
    ],
  },
  ach_setup: {
    id: "ach_setup",
    label: "Link Bank Account (ACH)",
    requires: [{ code: "ach" }],
  },
  contribution: {
    id: "contribution",
    label: "IRA Contribution / Deposit",
    requires: [
      { code: "contribution" },
      {
        code: "ach",
        when: { field: "hasLinkedBank", equals: false },
        reason: "ACH Authorization Agreement — no linked bank account on file",
      },
    ],
  },
};
