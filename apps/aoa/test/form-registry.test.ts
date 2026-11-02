import { describe, expect, it } from "vitest";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { isDefinitionEligibleForAccountType, type FormDefinition } from "@/lib/forms/form-definition";
import {
  FORM_DEFINITIONS,
  getEligibleFormDefinitions,
  getFormDefinition,
} from "@/lib/forms/registry";

describe("form-definition registry", () => {
  it("uses canonical form names and consistent actions without draft wording in downloads", () => {
    const canonicalNames: Record<string, string> = {
      ira_beneficiary_designation: "IRA Beneficiary Designation",
      "apex-acat-generic": "ACAT Transfer",
      "apex-ach-agreement": "ACH Agreement",
      direct_conversion_request: "Direct Conversion Request",
      ira_distribution_request: "Traditional IRA Distribution Request",
      roth_ira_distribution_request: "Roth IRA Distribution Request",
      "apex-transfer-on-death": "Transfer on Death",
      "apex-domestic-wire": "Domestic Wire Request",
    };
    // Assert every enabled form while allowing a form registration to be
    // independently reverted without changing unrelated presentation behavior.
    for (const definition of FORM_DEFINITIONS) {
      expect(definition.name, definition.id).toBe(canonicalNames[definition.id]);
      expect(definition.callToAction, definition.id).toBe("Prepare Form");
      expect(definition.summary, definition.id).not.toMatch(/\bdraft\b/i);
      expect(definition.outputFilenamePattern, definition.id).not.toMatch(/draft/i);
      expect(definition.reviewState).toBe("ready_for_human_review");
    }
  });

  it("has unique IDs and complete version/template metadata", () => {
    const ids = FORM_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of FORM_DEFINITIONS) {
      expect(definition.version).toMatch(/^(?:(?:tracker-baseline|user-supplied|supplied|source)-)?\d{4}-\d{2}-\d{2}$/);
      expect(definition.template.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(definition.template.fieldCount).toBeGreaterThan(0);
      expect(definition.outputFilenamePattern).not.toContain("{clientName}");
      expect(definition.reviewState).toBe("ready_for_human_review");
    }
  });

  it("resolves definitions by stable form ID", () => {
    for (const definition of FORM_DEFINITIONS) expect(getFormDefinition(definition.id)).toBe(definition);
    expect(getFormDefinition("unknown_form")).toBeNull();
    expect(getFormDefinition(ACAT_DEFINITION.id)).toBe(ACAT_DEFINITION);
  });

  it("uses account context rather than keywords to determine eligibility", () => {
    // These pre-existing forms must retain their behavior whether zero, one or
    // all new form registrations are enabled. Each form PR owns its own exact
    // registration and account-family expectations.
    const baselineIds = new Set<string>([IRA_BENEFICIARY_DEFINITION.id, ACAT_DEFINITION.id]);
    const baseline = (types: readonly (string | null | undefined)[]) =>
      getEligibleFormDefinitions(types).filter(definition => baselineIds.has(definition.id));
    expect(baseline(["Roth IRA"])).toEqual([
      IRA_BENEFICIARY_DEFINITION,
      ACAT_DEFINITION,
    ]);
    expect(baseline(["Individual Brokerage"])).toEqual([ACAT_DEFINITION]);
    expect(baseline(["Miranda Brokerage"])).toEqual([ACAT_DEFINITION]);
    expect(baseline([null])).toEqual([ACAT_DEFINITION]);
    expect(getEligibleFormDefinitions([])).toEqual([]);
    expect(baseline(["ROTH_IRA"])).toEqual([
      IRA_BENEFICIARY_DEFINITION,
      ACAT_DEFINITION,
    ]);
  });

  it("supports include, any-of and exclusion constraints independently of a concrete new form", () => {
    const definition: FormDefinition = {
      ...ACAT_DEFINITION,
      eligibility: {
        context: "single_account", accountTypeIncludes: ["example"],
        accountTypeAny: ["alpha", "beta"], accountTypeExcludes: ["blocked"], description: "Synthetic eligibility fixture",
      },
    };
    for (const type of ["EXAMPLE_ALPHA", "example beta"]) expect(isDefinitionEligibleForAccountType(definition, type)).toBe(true);
    for (const type of [undefined, null, "", "example", "alpha", "example alphabetical", "example alpha blocked"]) {
      expect(isDefinitionEligibleForAccountType(definition, type)).toBe(false);
    }
  });

  it("records source, sensitivity, and transformation for every mapped field", () => {
    for (const field of FORM_DEFINITIONS.flatMap(definition => [...definition.fields])) {
      expect(field.canonicalKey).toBeTruthy();
      expect(field.pdfFieldIds.length).toBeGreaterThan(0);
      expect(field.sensitivity).toBeTruthy();
      if (field.source === "aoa") expect(field.sourcePath).toBeTruthy();
      if (field.sensitivity === "restricted_pii") {
        expect(field).not.toHaveProperty("originalValue");
      }
    }
  });

  it("makes holder SSN draft-optional and client-required before signing without approving an AoA source", () => {
    expect(IRA_BENEFICIARY_DEFINITION.fields.find(field => field.canonicalKey === "account.owner.tax_id")).toMatchObject({
      requirement: "conditional", source: "manual", sourcePath: null, sensitivity: "restricted_pii",
      transformation: "remove-spaces-and-hyphens",
    });
    expect(IRA_BENEFICIARY_DEFINITION.rules).toContain("Account-holder SSN or TIN is optional for form generation in every completion mode; when blank, the client must complete it before signing.");
  });
});
