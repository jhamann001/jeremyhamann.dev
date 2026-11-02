import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NAV_GROUPS } from "@/components/shell/nav-config";
import { dataHealthEnabled, reviewQueueSchedulerActive } from "@/lib/flags";

const page = readFileSync(
  resolve(process.cwd(), "app/(authenticated)/data-health/page.tsx"),
  "utf8",
);
const saved = process.env.DATA_HEALTH;
const savedSchedulerActive = process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE;

afterEach(() => {
  if (saved === undefined) delete process.env.DATA_HEALTH;
  else process.env.DATA_HEALTH = saved;
  if (savedSchedulerActive === undefined) delete process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE;
  else process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE = savedSchedulerActive;
});

describe("source-health rollout and UI contract", () => {
  it("enables the feature only for exact 1", () => {
    for (const value of [undefined, "", "0", "true", "yes", "2"]) {
      if (value === undefined) delete process.env.DATA_HEALTH;
      else process.env.DATA_HEALTH = value;
      expect(dataHealthEnabled()).toBe(false);
    }
    process.env.DATA_HEALTH = "1";
    expect(dataHealthEnabled()).toBe(true);
  });

  it("trusts only the exact scheduler-active runtime statement", () => {
    for (const value of [undefined, "", "0", "true", "yes", "2"]) {
      if (value === undefined) delete process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE;
      else process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE = value;
      expect(reviewQueueSchedulerActive()).toBe(false);
    }
    process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE = "1";
    expect(reviewQueueSchedulerActive()).toBe(true);
  });

  it("gates navigation to Operations/Admin and the independent flag", () => {
    const item = NAV_GROUPS.flatMap((group) => group.items)
      .find((entry) => entry.href === "/data-health");
    expect(item).toMatchObject({
      label: "Data Health",
      requiredRoles: ["ADMIN", "OPERATIONS"],
      requiresDataHealth: true,
    });
  });

  it("shows distinct evidence fields, monitoring coverage, and honest availability wording", () => {
    expect(page).toContain("Source business as-of");
    expect(page).toContain("Latest completed success");
    expect(page).toContain("Last attempted run");
    expect(page).toContain("Latest recorded failure or issue");
    expect(page).toContain("Monitoring coverage");
    expect(page).toContain("Available now");
    expect(page).toContain("Live availability checked");
    expect(page).toContain("Not published");
    expect(page).toContain("Not recorded");
    expect(page).toContain("No durable record");
    expect(page).toContain("does not prove no attempt or failure occurred");
    expect(page).toContain("row.metrics");
    expect(page).toContain("row.latestSuccessLabel");
    expect(page).toContain("row.lastAttemptLabel");
  });

  it("keeps source health compact while preserving evidence behind native disclosure", () => {
    expect(page).toContain("<details className={styles.sourceDetails}>");
    expect(page).toContain("<summary className={styles.sourceSummary}>");
    expect(page).not.toContain("defaultOpen");
    expect(page).toContain("row.latestSuccessAt ?? row.availabilityCheckedAt ?? row.lastAttemptAt");
    expect(page).toContain("className={styles.expandedEvidence}");
  });
});
