import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { crmTaskUrl } from "@/lib/crm";

describe("CRM task links", () => {
  it("builds the canonical Task path for 15- and 18-character Task IDs", () => {
    expect(crmTaskUrl("00TX461635oPLyI")).toBe(
      "https://crm.example/lightning/r/Task/00TX461635oPLyI/view",
    );
    expect(crmTaskUrl("00TX461635oPLyIMAW")).toBe(
      "https://crm.example/lightning/r/Task/00TX461635oPLyIMAW/view",
    );
  });

  it("accepts a configured Salesforce Lightning origin", () => {
    expect(
      crmTaskUrl(
        "00TX461635oPLyIMAW",
        "https://crm-sandbox.example",
      ),
    ).toBe(
      "https://crm-sandbox.example/lightning/r/Task/00TX461635oPLyIMAW/view",
    );
  });

  it("returns null for non-Task IDs and unsafe or malformed origins", () => {
    expect(crmTaskUrl("001M374952D2WBSIA3")).toBeNull();
    expect(crmTaskUrl("TASK-123")).toBeNull();
    expect(crmTaskUrl(null)).toBeNull();
    expect(
      crmTaskUrl("00TX461635oPLyIMAW", "https://example.com"),
    ).toBeNull();
    expect(
      crmTaskUrl(
        "00TX461635oPLyIMAW",
        "https://crm.example/unexpected/path",
      ),
    ).toBeNull();
    expect(
      crmTaskUrl(
        "00TX461635oPLyIMAW",
        "http://crm.example",
      ),
    ).toBeNull();
  });

  it("opens valid records in a safe new tab while preserving invalid IDs as text", () => {
    const card = readFileSync(
      resolve(process.cwd(), "components/client-portrait/TasksCard.tsx"),
      "utf8",
    );

    expect(card).toContain("const taskUrl = crmTaskUrl(task.sf_id)");
    expect(card).toContain('target="_blank"');
    expect(card).toContain('rel="noopener noreferrer"');
    expect(card).toContain("taskUrl ? (");
    expect(card).toContain('<span className={styles.subject}>{subject}</span>');
  });
});
