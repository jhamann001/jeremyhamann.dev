import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), parse: vi.fn(), create: vi.fn(), apply: vi.fn(), decide: vi.fn(), search: vi.fn(),
  revalidate: vi.fn(), redirect: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/employee-roster/parser", () => ({
  EMPLOYEE_ROSTER_MAX_BYTES: 1_000_000,
  EmployeeRosterParseError: class EmployeeRosterParseError extends Error {},
  parseEmployeeRosterWorkbook: mocks.parse,
}));
vi.mock("@/lib/data/employee-roster", () => ({
  canManageEmployeeRoster: (role: string) => ["ADMIN", "OPERATIONS"].includes(role),
  createEmployeeRosterPreview: mocks.create,
  applyEmployeeRoster: mocks.apply,
  decideEmployeeContactMapping: mocks.decide,
  employeeContactCandidates: mocks.search,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import {
  applyEmployeeRosterSnapshot,
  previewEmployeeRoster,
  saveEmployeeContactDecision,
  searchEmployeeContacts,
} from "@/app/(authenticated)/crm/employees/actions";

describe("employee roster server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.com" } });
    mocks.parse.mockResolvedValue({ employeeCount: 1 });
    mocks.create.mockResolvedValue({ status: "created", uploadId: "c123456789012345678901234" });
    mocks.apply.mockResolvedValue("applied");
    mocks.decide.mockResolvedValue("saved");
    mocks.search.mockResolvedValue({ candidates: [], previousRejections: [] });
  });

  it("passes only the parsed snapshot and effective date into preview persistence", async () => {
    const form = new FormData();
    form.set("workbook", new File(["xlsx"], "employees.xlsx"));
    form.set("effectiveDate", "2026-08-22");
    await previewEmployeeRoster(form);
    expect(mocks.create).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.com" },
      { employeeCount: 1 },
      "2026-08-22",
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/crm/employees");
    expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining("message=created"));
  });

  it("rejects unauthorized roles before reading the workbook", async () => {
    mocks.auth.mockResolvedValue({ user: { role: "ADVISOR", email: "advisor@example.com" } });
    const form = new FormData();
    form.set("workbook", new File(["xlsx"], "employees.xlsx"));
    form.set("effectiveDate", "2026-08-22");
    await previewEmployeeRoster(form);
    expect(mocks.redirect).toHaveBeenCalledWith("/crm/employees?message=forbidden");
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refreshes roster and badge surfaces after applying a complete snapshot", async () => {
    const form = new FormData();
    form.set("uploadId", "c123456789012345678901234");
    await applyEmployeeRosterSnapshot(form);
    expect(mocks.apply).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.com" },
      "c123456789012345678901234",
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/households");
    expect(mocks.revalidate).toHaveBeenCalledWith("/client-portrait");
  });

  it("does not reflect a tampered upload id into an apply redirect", async () => {
    const form = new FormData();
    form.set("uploadId", "<script>tampered</script>");
    await applyEmployeeRosterSnapshot(form);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/crm/employees?message=invalid");
  });

  it("records an explicit human contact decision", async () => {
    const form = new FormData();
    form.set("uploadId", "c123456789012345678901234");
    form.set("entryId", "12345678-1234-4234-9234-123456789012");
    form.set("crmId", "con_example");
    form.set("clientSfId", "003EXAMPLE");
    form.set("decision", "CONFIRMED");
    await saveEmployeeContactDecision(form);
    expect(mocks.decide).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.com" },
      expect.objectContaining({
        entryId: "12345678-1234-4234-9234-123456789012",
        crmId: "con_example", decision: "CONFIRMED",
      }),
    );
  });

  it("rejects unknown decision values instead of coercing them to confirmation", async () => {
    const form = new FormData();
    form.set("uploadId", "c123456789012345678901234");
    form.set("entryId", "12345678-1234-4234-9234-123456789012");
    form.set("crmId", "con_example");
    form.set("clientSfId", "003EXAMPLE");
    form.set("decision", "APPROVE");
    await saveEmployeeContactDecision(form);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining("message=invalid"));
  });

  it("does not reflect tampered upload or entry ids into a decision redirect", async () => {
    const form = new FormData();
    form.set("uploadId", "c123456789012345678901234");
    form.set("entryId", "bad-entry?next=/admin");
    form.set("crmId", "con_example");
    form.set("clientSfId", "003EXAMPLE");
    form.set("decision", "CONFIRMED");
    await saveEmployeeContactDecision(form);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/crm/employees?message=invalid");
  });

  it("keeps CRM search terms in POST action state", async () => {
    const form = new FormData();
    form.set("entryId", "12345678-1234-4234-9234-123456789012");
    form.set("query", "Alex Example");
    const state = await searchEmployeeContacts({
      query: "", candidates: [], previousRejections: [], error: null,
    }, form);
    expect(mocks.search).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.com" },
      "12345678-1234-4234-9234-123456789012",
      "Alex Example",
    );
    expect(state.query).toBe("Alex Example");
  });
});
