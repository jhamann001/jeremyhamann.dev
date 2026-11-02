import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "components/crm/ReportingWorkbench.tsx"), "utf8");
const viewToolsSource = readFileSync(resolve(process.cwd(), "components/crm/ReportingViewTools.tsx"), "utf8");
const pageSource = readFileSync(resolve(process.cwd(), "app/(authenticated)/reporting/page.tsx"), "utf8");

describe("CRM reporting filter affordances", () => {
  it("keeps primary filters visible and secondary display controls compact", () => {
    expect(source).toContain("PRIMARY_FILTER_KEYS");
    expect(source).toContain("className={styles.reportFilterBar}");
    expect(source).toContain("<details className={styles.filterPanel}");
    expect(source).toContain("More filters &amp; display");
    expect(source).toContain('name="page" value="1"');
    expect(source).toContain('aria-label="Active filters"');
    expect(source).toContain("Clear all");
    expect(source).toContain("className={styles.filterChip}");
  });

  it("adds compact pinned, saved, and shareable report views", () => {
    expect(source).toContain("<ReportingViewTools");
    expect(source).toContain("const currentHref = crmReportHref(currentQuery)");
    expect(source).toContain("const saveHref = crmReportHref({ ...currentQuery, page: 1 })");
    expect(source).toContain("key={currentHref}");
    expect(viewToolsSource).toContain("Return to the reports you use");
    expect(viewToolsSource).toContain("Copy current link");
    expect(viewToolsSource).toContain("Save this view");
    expect(viewToolsSource).toContain("Saved views stay on this browser");
  });

  it("scopes browser-saved views without exposing the signed-in email to the client", () => {
    expect(pageSource).toContain('createHash("sha256")');
    expect(pageSource).toContain("storageScope={storageScope}");
    expect(pageSource).not.toContain("storageScope={session.user.email");
  });
});
