import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { MAPPED_FORM_SPECS } from "@/lib/forms/mapped-forms";
import { mappedInputs } from "@/lib/forms/mapped-form-spec";

vi.mock("server-only", () => ({}));
const { accountSpy, clientSpy } = vi.hoisted(() => ({ accountSpy: vi.fn(), clientSpy: vi.fn() }));
vi.mock("@/lib/data/account-aum", () => ({ apexAccountByCustodianId: accountSpy }));
vi.mock("@/lib/data/clients", () => ({ getClientWithHousehold: clientSpy }));
import { generateForm } from "@/lib/forms/generate-form.server";

const identity = { role: "OPERATIONS", email: "ops@example.test" };
const client = { sf_id: "FICTIONAL-CLIENT", name: "Jordan Sample" };

describe.each(MAPPED_FORM_SPECS)("authorized generation for $definition.name", spec => {
  const constraints = spec.definition.eligibility;
  const accountType = [...constraints.accountTypeIncludes, ...(constraints.accountTypeAny?.slice(0, 1) ?? [])].join(" ") || "Individual Brokerage";
  const account = { clientSfId: client.sf_id, accountType, apexAccountNumber: "SYN-00001", custodianAccountId: "FICTIONAL-ACCOUNT" };
  const request = { formId: spec.definition.id, clientId: client.sf_id, accountIds: [account.custodianAccountId], values: { fields: {}, confirmAccount: true } };
  beforeEach(() => { clientSpy.mockReset().mockResolvedValue(client); accountSpy.mockReset().mockResolvedValue(account); });
  it("renders a draft with optional fields blank, no values retained and all instruction pages", async () => {
    const result = await generateForm(identity, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviewState).toBe("ready_for_human_review");
    expect(result.clientCompletionRequired).toBe(true);
    expect(result.filename).toMatch(/0001\.pdf$/);
    expect(result.filename).not.toContain("Jordan");
    expect(result.filename).not.toMatch(/draft/i);
    expect(JSON.stringify(result.provenance)).not.toMatch(/Jordan|SYN-00001/);
    expect(result.provenance.every(field => field.valueRetention === "transient_only")).toBe(true);
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(spec.definition.template.pageCount);
    expect(pdf.getTitle()).toBe(spec.definition.name);
    expect(pdf.getTitle()).not.toMatch(/\bdraft\b/i);
    expect(pdf.getSubject()).toMatch(/human review/i);
    expect(pdf.getSubject()).toMatch(/No submission/i);
  });
  it("rejects a forged server account field rather than filling it", async () => {
    const input = mappedInputs(spec).find(field => field.source === "accountNumber")!;
    const result = await generateForm(identity, { ...request, values: { fields: { [input.key]: "FORGED-ACCOUNT" }, confirmAccount: true } });
    expect(result).toMatchObject({ ok: false, status: 422, code: "validation_failed" });
    expect(JSON.stringify(result)).not.toContain("FORGED-ACCOUNT");
  });
  it("fails closed for another client's account", async () => {
    accountSpy.mockResolvedValue({ ...account, clientSfId: "OTHER-CLIENT" });
    expect(await generateForm(identity, request)).toEqual({ ok: false, status: 404, code: "client_account_not_found" });
  });
  it("requires the client and account to be visible and the Apex number to exist", async () => {
    clientSpy.mockResolvedValue(null);
    expect(await generateForm(identity, request)).toMatchObject({ ok: false, status: 404 });
    clientSpy.mockResolvedValue(client); accountSpy.mockResolvedValue(null);
    expect(await generateForm(identity, request)).toMatchObject({ ok: false, status: 404 });
    accountSpy.mockResolvedValue({ ...account, apexAccountNumber: null });
    expect(await generateForm(identity, request)).toMatchObject({ ok: false, status: 404 });
  });
  it("does not replace a missing confirmation with inferred authorization", async () => {
    expect(await generateForm(identity, { ...request, values: { fields: {} } })).toMatchObject({ ok: false, status: 422, code: "validation_failed" });
  });
  it("rejects extra account context", async () => {
    expect(await generateForm(identity, { ...request, accountIds: [account.custodianAccountId, "OTHER"] })).toMatchObject({ ok: false, status: 400, code: "missing_context" });
  });
  if (constraints.accountTypeIncludes.length || constraints.accountTypeAny?.length) {
    it("rejects an account with none of the required type tokens on the server", async () => {
      accountSpy.mockResolvedValue({ ...account, accountType: "UNMATCHED-SYNTHETIC-TYPE" });
      expect(await generateForm(identity, request)).toMatchObject({ ok: false, status: 422, code: "account_not_eligible" });
    });
  }
  it.each(constraints.accountTypeExcludes ?? [])("enforces the excluded account-type token %s on the server", async excluded => {
    accountSpy.mockResolvedValue({ ...account, accountType: `${accountType} ${excluded}` });
    expect(await generateForm(identity, request)).toMatchObject({ ok: false, status: 422, code: "account_not_eligible" });
  });
});

describe("unregistered mapped form boundary", () => {
  beforeEach(() => { clientSpy.mockReset(); accountSpy.mockReset(); });
  it("rejects an unavailable form before reading client or account data, even with no new forms enabled", async () => {
    const result = await generateForm(identity, {
      formId: "unregistered-synthetic-form", clientId: client.sf_id, accountIds: ["FICTIONAL-ACCOUNT"], values: { fields: {}, confirmAccount: true },
    });
    expect(result).toEqual({ ok: false, status: 404, code: "form_not_found" });
    expect(clientSpy).not.toHaveBeenCalled();
    expect(accountSpy).not.toHaveBeenCalled();
  });
});
