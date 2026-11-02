import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseEmployeeRosterWorkbook } from "@/lib/employee-roster/parser";

const fixture = process.env.EMPLOYEE_ROSTER_FIXTURE;
const gated = fixture ? describe : describe.skip;

gated("real Rippling workbook parser", () => {
  it("parses the operator-provided workbook without retaining dependent names", async () => {
    const parsed = await parseEmployeeRosterWorkbook(await readFile(fixture!));
    expect(parsed.rowCount).toBeGreaterThan(0);
    expect(parsed.employeeCount).toBeGreaterThan(0);
    expect(parsed.activeCount + parsed.formerCount).toBe(parsed.employeeCount);
    expect(parsed.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.entries.every((entry) => !("dependentName" in entry))).toBe(true);
  });
});
