import type { DocForm } from "@/lib/data/workflow-types";

// Static Apex-form catalog (Phase C, TDD §3/§7). Deterministic reference data —
// the 13 forms the Workflow screens can attach to a task, plus a keyword→codes
// map that `detectNeed` (lib/data/workflow.ts) scores decision text against.
// Future source (Phase D+): Apex DocuSign field analysis → reference table.

export const DOCS: Record<string, DocForm> = {
  acat: {
    code: "acat",
    name: "ACAT Transfer Initiation",
    fields: ["Delivering firm", "Account number", "Transfer type", "Assets"],
    signers: ["Account owner"],
  },
  ach: {
    code: "ach",
    name: "ACH Authorization Agreement",
    fields: ["Bank routing number", "Bank account number", "Account type"],
    signers: ["Account owner"],
    supporting: "voided check / bank statement / bank letter",
  },
  iradist: {
    code: "iradist",
    name: "IRA Distribution Request",
    fields: ["Distribution amount", "Federal withholding", "Reason code"],
    signers: ["Account owner"],
  },
  toa: {
    code: "toa",
    name: "Transfer on Account (Non-ACAT)",
    fields: ["Delivering institution", "Asset list", "Delivery instructions"],
    signers: ["Account owner"],
  },
  w9: {
    code: "w9",
    name: "Form W-9 (Taxpayer ID Certification)",
    fields: ["Taxpayer name", "TIN", "Tax classification"],
    signers: ["Account owner"],
  },
  beneficiary: {
    code: "beneficiary",
    name: "Beneficiary Designation",
    fields: ["Primary beneficiaries", "Contingent beneficiaries", "Allocations"],
    signers: ["Account owner"],
  },
  margin: {
    code: "margin",
    name: "Margin Account Agreement",
    fields: ["Account number", "Initial margin", "Risk acknowledgment"],
    signers: ["Account owner"],
  },
  options: {
    code: "options",
    name: "Options Trading Application",
    fields: ["Objective", "Experience", "Approval level"],
    signers: ["Account owner"],
  },
  trustcert: {
    code: "trustcert",
    name: "Certification of Trust",
    fields: ["Trust name", "Trustee(s)", "Date of trust", "Powers"],
    signers: ["Trustee"],
  },
  journal: {
    code: "journal",
    name: "Cash / Securities Journal Request",
    fields: ["From account", "To account", "Amount or positions"],
    signers: ["Account owner"],
  },
  wire: {
    code: "wire",
    name: "Wire Transfer Request",
    fields: ["Beneficiary bank", "Beneficiary account", "Amount"],
    signers: ["Account owner"],
  },
  contribution: {
    code: "contribution",
    name: "IRA Contribution Instruction",
    fields: ["Contribution amount", "Tax year", "Contribution type"],
    signers: ["Account owner"],
  },
  transition: {
    code: "transition",
    name: "Account Transition Kit",
    fields: ["New account type", "Registration", "Funding source"],
    signers: ["Account owner"],
  },
};

// Keyword substring → doc codes. `detectNeed` lowercases decision text and unions
// the codes for every matched keyword (Phase E replaces the scoring with a model).
export const DOC_NEEDS: Record<string, string[]> = {
  liquidat: ["acat", "journal"],
  transfer: ["acat", "toa"],
  acat: ["acat"],
  ira: ["iradist"],
  distribution: ["iradist"],
  rmd: ["iradist"],
  contribut: ["contribution"],
  bank: ["ach"],
  ach: ["ach"],
  wire: ["wire"],
  trust: ["trustcert"],
  beneficiar: ["beneficiary"],
  margin: ["margin"],
  option: ["options"],
  transition: ["transition"],
  journal: ["journal"],
  "w-9": ["w9"],
  "tax id": ["w9"],
};
