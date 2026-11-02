import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const deals = readFileSync(resolve(process.cwd(), "components/deals/DealSummaryCard.tsx"), "utf8");
const tasks = readFileSync(resolve(process.cwd(), "components/client-portrait/TasksCard.tsx"), "utf8");
const page = readFileSync(resolve(process.cwd(), "app/(authenticated)/households/[id]/page.tsx"), "utf8");

describe("household collapsible cards", () => {
  it("uses accessible native disclosure summaries and keeps Deals/Tasks in one responsive grid", () => {
    expect(deals).toContain("<details className={styles.dealsCard}>");
    expect(deals).toContain("<summary className={styles.summary}>");
    expect(deals).toContain("outstandingCount");
    expect(deals).toContain("fundedCount");
    expect(tasks).toContain("<details className={styles.tasksCard} open={expanded}");
    expect(tasks).toContain("<summary className={styles.summary}>");
    expect(tasks).toContain("completedCount} completed");
    expect(page).toContain("className={styles.workGrid}");
    expect(page).toContain("<HouseholdDeals deals={hh.deals} summary={hh.dealSummary} />");
    expect(page).toContain(
      'getHouseholdHistoryPage(identity, householdId, "tasks", { page, includeCompleted, assigneeFilter })',
    );
    expect(page).toContain('<Suspense fallback={<SectionLoading label="tasks" />}>');
  });
});
