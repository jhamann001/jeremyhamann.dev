import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const explorer = readFileSync(join(process.cwd(), "app/(authenticated)/crm/page.tsx"), "utf8");
const results = readFileSync(join(process.cwd(), "components/crm/CrmProgressiveResults.tsx"), "utf8");
const detail = readFileSync(join(
  process.cwd(), "app/(authenticated)/crm/duplicates/[id]/page.tsx",
), "utf8");

describe("CRM duplicate review UI", () => {
  it("keeps candidate review inside CRM Explorer with a visible count and filter", () => {
    expect(explorer).toContain('initialPage.firstPage + ":" + initialPage.snapshot');
    expect(results).toContain('label="Potential duplicates"');
    expect(results).toContain('<option value="potential">Potential duplicates</option>');
    expect(results).toContain("Compare →");
    expect(explorer).toContain("CRM_DUPLICATE_ENTITY_TYPES");
    expect(results).toContain("duplicateEntityType");
  });

  it("keeps the two manual duplicate finders collapsed until needed", () => {
    expect(explorer.match(/className=\{styles\.manualDuplicateDisclosure\}/g)).toHaveLength(2);
    expect(explorer).toContain("open={Boolean(FLAG_MESSAGES[flagMessage])}");
    expect(explorer).toContain("open={Boolean(CONTACT_FLAG_MESSAGES[contactFlagMessage])}");
    expect(explorer).toContain("disclosureChevron");
  });

  it("renders a side-by-side comparison with structured, non-executing decisions", () => {
    expect(detail).toContain("duplicateComparison");
    expect(detail).toContain("Not duplicate");
    expect(detail).toContain("Snooze");
    expect(detail).toContain("AOA shadow recommendation");
    expect(detail).toContain("Shadow only");
    expect(detail).toContain("Confirm duplicate");
    expect(detail).toContain('name="canonicalIdentityId"');
    expect(detail).toContain("CRM record to preserve");
    expect(detail).toContain("Choose the CRM ID to preserve");
    expect(detail).toContain("crmRecordLabel(candidate.left)");
    expect(detail).toContain("crmRecordLabel(candidate.right)");
    expect(detail).toContain("Record to preserve: ${crmRecordLabel(canonicalSide)}");
    expect(detail).toContain('name="decisionReason"');
    expect(detail).toContain("This does not merge or change either record.");
    expect(detail).toContain("AOA canonicalization is active");
    expect(detail).toContain("Reopen review and remove AOA canonicalization");
    expect(detail).toContain("The AOA canonicalization has been removed.");
    expect(detail).toContain('name="decision" value="NEW"');
    expect(detail).not.toContain("<option value={candidate.leftIdentityId}>{candidate.left.name}</option>");
    expect(detail).not.toContain("<option value={candidate.rightIdentityId}>{candidate.right.name}</option>");
    expect(detail).not.toMatch(/Merge records|Apply recommendation/);
  });
});
