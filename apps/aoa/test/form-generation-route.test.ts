import { beforeEach, describe, expect, it, vi } from "vitest";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";

const { authSpy, generateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  generateSpy: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/forms/generate-form.server", () => ({ generateForm: generateSpy }));

import { POST } from "../app/api/forms/generate/route";

const validBody = {
  formId: IRA_BENEFICIARY_DEFINITION.id,
  clientId: "C-1",
  accountIds: ["custodian-account-1"],
  values: {
    beneficiaryCompletion: "client",
    accountHolderName: "Jordan Sample",
    accountHolderTaxId: "900000001",
    certifyNotMarried: false,
    primary: [],
    contingent: [],
  },
};

function request(body: unknown = validBody) {
  return new Request("https://ops-portal.test/api/forms/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/forms/generate", () => {
  beforeEach(() => {
    authSpy.mockReset();
    generateSpy.mockReset();
    authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" } });
    generateSpy.mockResolvedValue({
      ok: true,
      bytes: new Uint8Array([37, 80, 68, 70]),
      filename: "5050P-UBEN-0001.pdf",
      definition: IRA_BENEFICIARY_DEFINITION,
      reviewState: "ready_for_human_review",
      clientCompletionRequired: true,
      provenance: IRA_BENEFICIARY_DEFINITION.fields.map((field) => ({
        ...field,
        overridden: false,
        valueRetention: "transient_only",
      })),
      audit: {
        generatedAt: "2026-09-08T12:00:00.000Z",
        generatedBy: "ops@example.test",
        formId: IRA_BENEFICIARY_DEFINITION.id,
        formVersion: IRA_BENEFICIARY_DEFINITION.version,
        templateSha256: IRA_BENEFICIARY_DEFINITION.template.sha256,
      },
    });
  });

  it("requires an authenticated user before handing work to the form service", async () => {
    authSpy.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even when no content-length header is provided", async () => {
    const response = await POST(
      new Request("https://ops-portal.test/api/forms/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(100_001) }),
      }),
    );
    expect(response.status).toBe(413);
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("passes the generic form, client, account, and values contract to the service", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(generateSpy).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.test" },
      validBody,
    );
  });

  it.each(["client", "staff"])("passes an omitted holder SSN through and exposes pending client completion in %s mode", async (beneficiaryCompletion) => {
    const body = { ...validBody, values: {
      beneficiaryCompletion, accountHolderName: "Jordan Sample",
      primary: beneficiaryCompletion === "client" ? [] : [{
        fullName: "Adah Sample", relationship: "Family", dateOfBirth: "01/02/1980",
        telephoneNumber: "202-555-0100", sharePercentage: 100,
        address: "100 Example Avenue, Sample City, NY 10001", emailAddress: "taylor@example.test", taxId: "900000002",
      }],
      contingent: [],
    } };
    const response = await POST(request(body));
    expect(generateSpy).toHaveBeenCalledExactlyOnceWith({ role: "OPERATIONS", email: "ops@example.test" }, body);
    expect(generateSpy.mock.calls[0][1].values).not.toHaveProperty("accountHolderTaxId");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-aoa-client-completion-required")).toBe("true");
    expect(response.headers.get("x-aoa-review-state")).toBe("ready_for_human_review");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify([...response.headers])).not.toContain("Jordan Sample");
  });

  it("returns partial holder-SSN validation errors without a PDF or completion claim", async () => {
    generateSpy.mockResolvedValue({
      ok: false, status: 422, code: "validation_failed",
      issues: [{ path: "accountHolderTaxId", message: "Enter a nine-digit SSN or TIN, or leave blank for the client" }],
    });
    const response = await POST(request({ ...validBody, values: { ...validBody.values, accountHolderTaxId: "0001" } }));
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-aoa-client-completion-required")).toBeNull();
    expect(await response.json()).toEqual({ error: "validation_failed", details: [{ path: "accountHolderTaxId", message: "Enter a nine-digit SSN or TIN, or leave blank for the client" }] });
  });

  it("preserves partial rows and nullable shares in the service request and marks pending completion", async () => {
    const body = { ...validBody, values: {
      beneficiaryCompletion: "partial", accountHolderName: "Morgan Sample",
      primary: [{}, { fullName: "John", relationship: "husband", sharePercentage: null }], contingent: [],
    } };
    const response = await POST(request(body));
    expect(generateSpy).toHaveBeenCalledExactlyOnceWith({ role: "OPERATIONS", email: "ops@example.test" }, body);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-aoa-client-completion-required")).toBe("true");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify([...response.headers])).not.toContain("John");
  });

  it("routes the generic ACAT draft with no-store metadata and no entered values in headers", async () => {
    const body = {
      ...validBody, formId: ACAT_DEFINITION.id,
      values: { accountHolderName: "Jordan Sample", accountHolderTaxId: "900000001", confirmAccountTitle: true },
    };
    const generated = await generateSpy();
    generateSpy.mockResolvedValue({ ...generated, definition: ACAT_DEFINITION, filename: "APEX-ACAT-0001.pdf", clientCompletionRequired: false });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(generateSpy).toHaveBeenCalledWith({ role: "OPERATIONS", email: "ops@example.test" }, body);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-aoa-form-id")).toBe(ACAT_DEFINITION.id);
    expect(response.headers.get("x-aoa-review-state")).toBe("ready_for_human_review");
    expect(JSON.stringify([...response.headers])).not.toContain("Jordan Sample");
    expect(JSON.stringify([...response.headers])).not.toContain("900000001");
  });

  it("returns service validation details without creating a PDF", async () => {
    generateSpy.mockResolvedValue({
      ok: false,
      status: 422,
      code: "validation_failed",
      issues: [{ path: "primary", message: "Add at least one primary beneficiary" }],
    });
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "validation_failed",
      details: [{ path: "primary", message: "Add at least one primary beneficiary" }],
    });
  });

  it("preserves service ownership restrictions for client-completion drafts", async () => {
    generateSpy.mockResolvedValue({ ok: false, status: 404, code: "client_account_not_found" });
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "client_account_not_found" });
    expect(response.headers.get("x-aoa-client-completion-required")).toBeNull();
  });

  it.each([true, false])("exposes client completion as metadata without changing review state (%s)", async (clientCompletionRequired) => {
    const generated = await generateSpy();
    generateSpy.mockResolvedValue({ ...generated, clientCompletionRequired });
    const response = await POST(request());
    expect(response.headers.get("x-aoa-client-completion-required")).toBe(String(clientCompletionRequired));
    expect(response.headers.get("x-aoa-review-state")).toBe("ready_for_human_review");
  });

  it("returns a no-store draft with registry and review-state headers", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="5050P-UBEN-0001.pdf"',
    );
    expect(response.headers.get("x-aoa-form-id")).toBe(IRA_BENEFICIARY_DEFINITION.id);
    expect(response.headers.get("x-aoa-form-version")).toBe("2025-07-17");
    expect(response.headers.get("x-aoa-review-state")).toBe("ready_for_human_review");
    expect(response.headers.get("x-aoa-client-completion-required")).toBe("true");
    expect(Number(response.headers.get("x-aoa-provenance-fields"))).toBeGreaterThan(0);
  });
});
