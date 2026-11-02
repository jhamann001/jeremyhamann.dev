import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormLibraryCard } from "@/components/forms/FormLibraryCard";
import { IraBeneficiaryForm } from "@/components/forms/IraBeneficiaryForm";
import { AcatForm } from "@/components/forms/AcatForm";
import { MappedForm } from "@/components/forms/MappedForm";
import { MAPPED_FORM_SPECS } from "@/lib/forms/mapped-forms";
import { FORM_DEFINITIONS } from "@/lib/forms/registry";
import { accountHolderNameSource, beneficiaryDraftValues, hasBeneficiaryValues, formDownloadResponseIssue, formatBeneficiaryDateInput, formatBeneficiaryPhoneInput, formatIraBeneficiaryIssue, type EditableBeneficiary } from "@/components/forms/ira-beneficiary-ui";
import type { ApexAccount } from "@/lib/data/types";

const iraAccount: ApexAccount = {
  id: "synthetic-ira-one",
  type: "Roth IRA",
  num: "DEMO-0001",
  apexAccountNumber: "DEMO-0001",
  status: "OPEN",
  value: 0,
};

function renderLibrary(accounts: ApexAccount[]) {
  return renderToStaticMarkup(createElement(FormLibraryCard, {
    clientId: "synthetic-client-one",
    accounts,
  }));
}

describe("Form Library visibility", () => {
  it.each([{ accounts: [] }, { accounts: [iraAccount] }])("renders one default-closed native disclosure with a discoverable header", ({ accounts }) => {
    const html = renderLibrary(accounts);
    const disclosure = html.match(/<details\b[^>]*>/)?.[0];
    expect(disclosure).toBeDefined();
    expect(disclosure).not.toMatch(/\bopen(?:=|\s|>)/i);
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html).toMatch(/<details\b[^>]*>\s*<summary\b/);
    expect(html).toContain('role="region" aria-labelledby="form-library-heading"');
    const summary = html.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0];
    expect(summary).toContain('id="form-library-heading">Form Library</h2>');
    expect(summary).toContain("Internal Pilot");
    expect(summary).not.toMatch(/<(?:a|button|input)\b|aria-expanded=/i);
    expect(summary).toContain(accounts.length ? "Forms Available" : "No Eligible Forms");
  });

  it("keys the native disclosure by client so a reused portrait cannot carry expansion to another client", () => {
    function findDisclosure(node: ReactNode): ReactElement<{ children?: ReactNode }> | undefined {
      if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
      if (node.type === "details") return node;
      const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
      return children.map(findDisclosure).find(Boolean);
    }
    for (const clientId of ["synthetic-client-one", "synthetic-client-two"]) {
      const disclosure = findDisclosure(FormLibraryCard({ clientId, accounts: [iraAccount] }));
      expect(disclosure?.key).toBe(clientId);
    }
  });

  it("keeps the internal pilot visible for a client without accounts", () => {
    const html = renderLibrary([]);
    expect(html).toContain("Form Library");
    expect(html).toContain("Internal Pilot");
    expect(html).toContain("No accounts with a confirmed Apex account number available");
    expect(html).toContain("confirmed Apex account number");
    expect(html).not.toContain("href=");
    expect(html).not.toMatch(/\bdraft\b/i);
    expect(html).toContain("Review and complete all required information before sending");
  });

  it("does not offer the IRA form for non-IRA accounts", () => {
    const html = renderLibrary([{ ...iraAccount, type: "Individual Brokerage" }]);
    expect(html).toContain("Form Library");
    expect(html).toContain("Prepare Form: ACAT Transfer");
    expect(html).not.toContain("Prepare Form: IRA Beneficiary Designation");
  });

  it("offers both pilots for an IRA account with a verified account number", () => {
    const html = renderLibrary([iraAccount]);
    expect(html).toContain("Prepare Form: IRA Beneficiary Designation");
    expect(html).toContain('href="/client-portrait/synthetic-client-one/forms/ira-beneficiary"');
    expect(html).toContain('href="/client-portrait/synthetic-client-one/forms/acat"');
    expect(html).toContain("Review and complete all required information before sending");
    expect(html).toContain("Forms are not signed or submitted automatically");
    expect(html).not.toContain("No accounts with a confirmed Apex account number available");
  });

  it("offers the receiving-information draft even when account type is unknown", () => {
    const html = renderLibrary([{ ...iraAccount, type: "" }]);
    expect(html).toContain("Prepare Form: ACAT Transfer");
    expect(html).not.toContain("Prepare Form: IRA Beneficiary Designation");
  });

  it.each([null, undefined, "", "   "])(
    "does not substitute the display/custodian id when Apex number is %s",
    (apexAccountNumber) => {
      const html = renderLibrary([{ ...iraAccount, num: "custodian-id-only", apexAccountNumber }]);
      expect(html).toContain("No accounts with a confirmed Apex account number available");
      expect(html).not.toContain("href=");
    },
  );

  it.each([undefined, "", "   "])("requires a stable account id: %s", (id) => {
    const html = renderLibrary([{ ...iraAccount, id }]);
    expect(html).toContain("No accounts with a confirmed Apex account number available");
    expect(html).not.toContain("href=");
  });

  it("gives every eligible form a consistent action with a descriptive accessible name", () => {
    const html = renderLibrary([
      iraAccount,
      { ...iraAccount, id: "synthetic-traditional", type: "Traditional IRA" },
      { ...iraAccount, id: "synthetic-taxable", type: "Individual Brokerage" },
    ]);
    for (const definition of FORM_DEFINITIONS) {
      expect(html).toContain(`aria-label="Prepare Form: ${definition.name}"`);
      expect(html).toContain(`id="form-title-${definition.id}">${definition.name}</h3>`);
      expect(html).toContain(`href="/client-portrait/synthetic-client-one/forms/${definition.entryPathSegment}"`);
    }
    expect(html.match(/>Prepare Form<span aria-hidden="true">/g)).toHaveLength(FORM_DEFINITIONS.length);
    expect(html.match(/<article\b/g)).toHaveLength(FORM_DEFINITIONS.length);
    expect(html.match(/Review and complete all required information before sending/g)).toHaveLength(1);
    expect(html).not.toMatch(/\bdraft\b/i);
  });
});

describe("generic ACAT preparation UI", () => {
  const renderForm = () => renderToStaticMarkup(createElement(AcatForm, {
    clientId: "synthetic-client-one", clientName: "Jordan Sample",
    accounts: [{ accountId: "synthetic-account-one", maskedAccountNumber: "••••0001", accountType: "Individual", status: "OPEN" }],
  }));

  it("suggests a name but requires explicit receiving registration confirmation", () => {
    const html = renderForm();
    expect(html).toContain('value="Jordan Sample"');
    expect(html).toContain("AoA name suggestion");
    expect(html).toContain("not a verified legal registration");
    expect(html).toContain("I confirmed the full receiving account title");
    const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toMatch(/\bchecked=/i);
  });

  it("keeps the optional tax ID empty and transfer instructions outside this draft UI", () => {
    const html = renderForm();
    expect(html).toContain("Account-holder SSN or TIN (optional)");
    const taxInput = html.match(/<input\b[^>]*type="password"[^>]*>/)?.[0];
    expect(taxInput).toContain('value=""');
    expect(html).toContain("No full/partial, in-kind, liquidation or reinvestment choice is selected");
    expect(html).toContain("conditional letter of authorization");
    expect(html).toContain("Firm-address boxes refer to the delivering firm");
    expect(html).toContain("not ready to send");
    expect(html).toContain("No transfer is created or submitted");
    expect(html).toContain("There is no CRM or Transfer Tracker lookup");
    expect(html).toContain("Generate PDF");
    expect(html).not.toMatch(/\bdraft\b/i);
  });
});

describe("IRA beneficiary preparation UI", () => {
  const renderForm = () => renderToStaticMarkup(createElement(IraBeneficiaryForm, {
    clientId: "synthetic-client-one",
    clientName: "Jordan Sample",
    accounts: [{
      accountId: "synthetic-ira-one",
      maskedAccountNumber: "••••0001",
      accountType: "Roth IRA",
      status: "OPEN",
    }],
  }));

  it("starts the certification unchecked, editable and labeled as account-holder confirmation", () => {
    const html = renderForm();
    const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toMatch(/\b(?:checked|disabled|readonly)=/i);
    expect(html).toContain("The account holder has confirmed");
    expect(html).toContain("Leave unchecked unless they explicitly confirm");
  });

  it("explains source boundaries and always shows optional beneficiary fields without a mode choice", () => {
    const html = renderForm();
    expect(html).toContain("There is no CRM lookup");
    expect(html).toContain("Enter only information authorized for use in AoA");
    expect(html).toContain("Prefilled from the AoA display name");
    expect(html).toContain("corrections apply only to this form");
    expect(html).toContain('value="Jordan Sample"');
    expect(html).toContain("Telephone number");
    expect(html).toContain("Email address");
    expect(html).not.toContain("Client completes beneficiary details");
    expect(html).not.toContain("Who will complete the beneficiary details?");
    expect(html).toContain("Enter any beneficiary details you know");
    expect(html).toContain("Leave the rest blank for the client—even all fields");
    expect(html).not.toContain("enter a complete designation");
    expect(html).toContain("Required from client");
    expect(html).toContain("at least one primary beneficiary");
    expect(html).toContain("primary shares must total 100%");
    const radios = html.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(0);
    expect(html).toContain("Add primary");
    expect(html).toContain("Add contingent");
    expect(html).toContain('placeholder="MM/DD/YYYY"');
    expect(html).toContain('placeholder="XXX-XXX-XXXX"');
    const inputs = html.match(/<input\b[^>]*>/g) ?? [];
    expect(inputs.filter((input) => input.includes('value=""'))).toHaveLength(9);
    expect(inputs.every((input) => !/\brequired(?:=|\s|>)/i.test(input))).toBe(true);
  });

  it("marks the pending client work without claiming to enforce a signing workflow", () => {
    const html = renderForm();
    expect(html.match(/Required from client/g)).toHaveLength(10);
    expect(html).toContain("stay blank and editable in the PDF");
    expect(html).not.toContain("entered in this session are excluded");
    expect(html).toContain("PDF markers do not enforce completion or create a signing envelope");
    expect(html).toContain("assign missing fields to the client and make them required in your signing tool");
    expect(html).toContain("Generate with known details only");
    expect(html).toContain("Generate PDF");
    expect(html).not.toMatch(/\bdraft\b/i);
  });

  it("leaves the optional account-holder tax ID empty and explains client completion", () => {
    const html = renderForm();
    expect(html).toContain("Account-holder SSN or TIN (optional)");
    const taxInput = html.match(/<input\b[^>]*type="password"[^>]*>/)?.[0];
    expect(taxInput).toContain('value=""');
    expect(taxInput).not.toMatch(/\brequired(?:=|\s|>)/i);
    expect(html).toContain("Do not enter only the last four digits or a masked SSN");
    expect(html).toContain("Account-holder SSN or TIN · Required from client");
    expect(html).toContain("You can generate the form without it");
    expect(html).toContain("client must enter their full SSN or TIN before signing");
    expect(html).toContain("assign this field to the account holder and make it required in your signing tool");
  });

  it("marks an edited owner name as a manual correction without changing the original source", () => {
    expect(accountHolderNameSource("Jordan Sample", "Jordan Sample")).toBe("aoa");
    expect(accountHolderNameSource("Jordan Sample", "Jordan A. Sample")).toBe("correction");
    expect(accountHolderNameSource("Jordan Sample", "")).toBe("correction");
  });

  it.each([
    [{ path: "primary.0.emailAddress", message: "Required" }, "Primary beneficiary 1 — Email address: Required"],
    [{ path: "values.contingent.1.dateOfBirth", message: "Required" }, "Contingent beneficiary 2 — Date of birth: Required"],
    [{ path: "accountHolderTaxId", message: "Required" }, "Account-holder SSN or TIN: Required"],
    [{ path: "beneficiaryCompletion", message: "Select a valid mode" }, "Beneficiary completion: Select a valid mode"],
    [{ path: "primary", message: "Primary shares must total 100%" }, "Primary beneficiaries: Primary shares must total 100%"],
    [{ path: "form", message: "The draft could not be generated" }, "The draft could not be generated"],
  ])("provides a useful field/row label for %j", (issue, expected) => {
    expect(formatIraBeneficiaryIssue(issue)).toBe(expected);
  });
});

describe("mapped form preparation presentation", () => {
  it.each(MAPPED_FORM_SPECS)("uses form copy without removing completion and review boundaries: $definition.name", spec => {
    const html = renderToStaticMarkup(createElement(MappedForm, {
      spec, clientId: "synthetic-client-one", clientName: "Jordan Sample",
      accounts: [{ accountId: "synthetic-account-one", maskedAccountNumber: "••••0001", accountType: "Individual", status: "OPEN" }],
    }));
    expect(html).not.toMatch(/\bdraft\b/i);
    expect(html).toContain("Generate PDF");
    expect(html).toContain("Review and Completion");
    expect(html).toContain("Values are not saved to the client profile");
    expect(html).toContain("No CRM lookup");
    expect(html).toContain("Blank PDF fields remain editable");
    expect(html).toContain("No signature or submission");
    const confirmation = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(confirmation).toBeDefined();
    expect(confirmation).not.toMatch(/\bchecked=/i);
  });
});

describe("partial beneficiary draft values", () => {
  const empty: EditableBeneficiary = {
    fullName: "", relationship: "", dateOfBirth: "", telephoneNumber: "",
    sharePercentage: "", address: "", emailAddress: "", taxId: "",
  };

  it("retains sparse row positions and never substitutes zero or 100 for blank shares", () => {
    const rows = [empty, { ...empty, fullName: "John Sample", relationship: "Husband" }];
    expect(beneficiaryDraftValues(rows)).toEqual(rows.map(row => ({ ...row, sharePercentage: null })));
    expect(hasBeneficiaryValues(rows[0])).toBe(false);
    expect(hasBeneficiaryValues(rows[1])).toBe(true);
    expect(beneficiaryDraftValues([{ ...empty, sharePercentage: "  " }])[0].sharePercentage).toBeNull();
    expect(beneficiaryDraftValues([{ ...empty, sharePercentage: " 60 " }])[0].sharePercentage).toBe(60);
  });

  it.each(["NaN", "0.5", "1e2", "abc", "-10"])("preserves invalid entered shares for rejection rather than dropping them (%s)", (sharePercentage) => {
    expect(beneficiaryDraftValues([{ ...empty, sharePercentage }])[0].sharePercentage).toBe(sharePercentage);
    expect(hasBeneficiaryValues({ ...empty, sharePercentage })).toBe(true);
  });

  it("does not serialize an overflowing entered percentage as a missing value", () => {
    const sharePercentage = "9".repeat(400);
    const sent = JSON.parse(JSON.stringify(beneficiaryDraftValues([{ ...empty, sharePercentage }])));
    expect(sent[0].sharePercentage).toBe(sharePercentage);
  });
});

describe("beneficiary input formatting", () => {
  it.each([
    ["01021990", "01/02/1990"],
    [" 12251985 ", "12/25/1985"],
    ["02291991", "02/29/1991"], // Calendar validation still belongs to the server.
    ["01/02/1990", "01/02/1990"],
    ["", ""], ["0102", "0102"], ["01/02/199", "01/02/199"],
    ["010219900", "010219900"], ["DOB01021990", "DOB01021990"],
    ["1990-01-02", "1990-01-02"], ["1/2/1990", "1/2/1990"],
  ])("formats only a complete eight-digit DOB without guessing (%s)", (input, expected) => {
    expect(formatBeneficiaryDateInput(input)).toBe(expected);
    expect(formatBeneficiaryDateInput(expected)).toBe(expected);
  });

  it.each([
    ["2025550101", "202-555-0101"],
    [" (202) 555-0101 ", "202-555-0101"],
    ["202 555 0101", "202-555-0101"],
    ["202-555-0101", "202-555-0101"],
    ["", ""], ["202555", "202555"], ["202-555-010", "202-555-010"],
    ["12025550101", "12025550101"], ["+1 (202) 555-0101", "+1 (202) 555-0101"],
    ["2025550101 ext 4", "2025550101 ext 4"], ["call2025550101", "call2025550101"],
    ["+44 20 7946 0958", "+44 20 7946 0958"],
  ])("formats a complete domestic number without discarding other input (%s)", (input, expected) => {
    expect(formatBeneficiaryPhoneInput(input)).toBe(expected);
    expect(formatBeneficiaryPhoneInput(expected)).toBe(expected);
  });
});

describe("Form download response boundary", () => {
  it.each(["application/pdf", "Application/PDF", "APPLICATION/PDF; charset=binary", " application/pdf ; version=1.7"])(
    "accepts a non-redirected successful PDF with MIME %s",
    (contentType) => {
      expect(formDownloadResponseIssue({ status: 200, redirected: false, contentType })).toBeNull();
    },
  );

  it.each(["text/html; charset=utf-8", "application/json", "application/pdf-malformed", "", null])(
    "rejects a successful non-PDF response with MIME %s before download",
    (contentType) => {
      const issue = formDownloadResponseIssue({ status: 200, redirected: false, contentType });
      expect(issue).toContain("did not return a PDF");
      expect(issue).toContain("Sign in again, then retry");
      expect(issue).toContain("No file was downloaded");
    },
  );

  it.each(["text/html", "application/pdf"])("rejects redirects even if final MIME is %s", (contentType) => {
    expect(formDownloadResponseIssue({ status: 200, redirected: true, contentType })).toContain("Your session may have expired");
  });

  it.each([401, 302, 307])("gives sign-in guidance for HTTP %s", (status) => {
    expect(formDownloadResponseIssue({ status, redirected: false, contentType: "application/json" })).toContain("Sign in again, then retry");
  });

  it("leaves HTTP 422 JSON validation details to the existing error handler", () => {
    expect(formDownloadResponseIssue({ status: 422, redirected: false, contentType: "application/json" })).toBeNull();
  });
});
