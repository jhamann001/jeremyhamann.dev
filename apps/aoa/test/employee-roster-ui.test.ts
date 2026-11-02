import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const page = readFileSync(join(root, "app/(authenticated)/crm/employees/page.tsx"), "utf8");
const matchReview = readFileSync(join(root, "app/(authenticated)/crm/employees/EmployeeMatchReview.tsx"), "utf8");
const actions = readFileSync(join(root, "app/(authenticated)/crm/employees/actions.ts"), "utf8");
const households = readFileSync(join(root, "components/households/HouseholdsTable.tsx"), "utf8");
const clients = readFileSync(join(root, "components/client-portrait/ClientsTable.tsx"), "utf8");
const portrait = readFileSync(join(root, "app/(authenticated)/client-portrait/[id]/page.tsx"), "utf8");
const topbar = readFileSync(join(root, "components/shell/Topbar.tsx"), "utf8");

describe("employee roster UI contract", () => {
  it("makes confirmation human-owned and explains complete replacement", () => {
    expect(page).toContain("A name match never confirms itself");
    expect(page).toContain("Apply complete snapshot");
    expect(matchReview).toContain("Exact-name suggestion");
    expect(matchReview).toContain("No matching CRM contacts found.");
    expect(matchReview).toContain("Previous rejections");
    expect(matchReview).toContain("Reverse rejection and confirm");
  });

  it("uses opaque entry ids and POST state instead of employee PII in URLs", () => {
    expect(page).toContain("entry=${encodeURIComponent(row.entryId)}");
    expect(page).not.toContain("row.employeeId");
    expect(page).not.toContain("sp.q");
    expect(matchReview).toContain("action={searchAction}");
    expect(matchReview).not.toContain('name="evidence"');
    expect(actions).toContain("entry: entryId");
    expect(actions).not.toContain("employee: employeeId");
  });

  it("renders active and former badges on household and client surfaces", () => {
    for (const source of [page, households, clients, portrait]) {
      expect(source).toContain('"Employee"');
      expect(source).toContain('"Former employee"');
    }
  });

  it("routes the quarterly notification directly to the roster workflow", () => {
    expect(page).toContain("after each quarter");
    expect(topbar).toContain("Operations notifications");
    expect(topbar).toContain("notification.href");
  });
});
