import { describe, expect, it } from "vitest";
import { dataQualityFocusFor } from "./data-quality-focus";

describe("dataQualityFocusFor", () => {
  it("routes missing CRM tickets to the editable ticket field", () => {
    expect(dataQualityFocusFor({
      ruleKey: "missing_crm_ticket",
      title: "Required CRM ticket is missing",
      detail: "Add the CRM ticket.",
    })).toMatchObject({ tab: "details", field: "crmTicket", fieldLabel: "CRM Ticket" });
  });

  it("routes fee problems to the Fees tab", () => {
    expect(dataQualityFocusFor({
      ruleKey: "invalid_fee_amount",
      title: "Fee amount is not valid",
      detail: "Enter a numeric fee amount.",
    })).toMatchObject({ tab: "fees", field: "feeAmount" });
  });

  it("uses the exception detail to identify the invalid date field", () => {
    expect(dataQualityFocusFor({
      ruleKey: "invalid_date",
      title: "Date cannot be interpreted",
      detail: "Residual Follow-Up Date must be a valid date.",
    })).toMatchObject({ tab: "details", field: "residualFollowUpDate" });
  });
});
