import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HouseholdTaskHistoryRow } from "@/lib/data/types";
import type { HouseholdHistoryPage } from "@/lib/data/household-history";

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/households/SYNTHETIC",
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: vi.fn() }),
}));

import { TasksCard } from "@/components/client-portrait/TasksCard";

const task: HouseholdTaskHistoryRow = {
  sf_id: "00TSYN000000001", subject: "Invented task", status: "Not Started",
  priority: "High", description: "Synthetic task detail", source_modified_at: null,
  assignment_state: "UNAVAILABLE", assignee_type: null, assignee_name: null,
};

function renderTask(overrides: Partial<HouseholdTaskHistoryRow>, meta: HouseholdHistoryPage<"tasks">["meta"] = {
  openCount: 1, completedCount: 0,
}) {
  return renderToStaticMarkup(createElement(TasksCard, {
    householdId: "SYNTHETIC", scope: "synthetic", includeCompleted: false,
    initialPage: {
      rows: [{ ...task, ...overrides }], page: 1, pageSize: 100, total: 1,
      pageCount: 1, snapshot: "synthetic", meta,
    },
  }));
}

afterEach(() => { navigation.search = ""; });

describe("household task assignment display", () => {
  it.each([
    ["USER", "Avery Example", "Person"],
    ["QUEUE", "Operations", "Queue"],
    ["QUEUE", "Client Service", "Queue"],
    ["USER", "Operations", "Person"],
  ] as const)("shows source-confirmed %s assignment %s without guessing its type from its name", (type, name, label) => {
    const html = renderTask({ assignment_state: "ASSIGNED", assignee_type: type, assignee_name: name });
    expect(html).toContain(`Assigned to: ${name} · ${label}`);
    expect(html).toContain("Invented task");
    expect(html).toContain("Synthetic task detail");
    expect(html).toContain("Not Started");
    expect(html).toContain("High");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows unassigned only when the source explicitly says so", () => {
    expect(renderTask({ assignment_state: "UNASSIGNED" })).toContain(">Unassigned</p>");
    const unavailable = renderTask({});
    expect(unavailable).toContain("Assignment unavailable");
    expect(unavailable).not.toContain(">Unassigned</p>");
  });

  it.each([
    { assignment_state: "ASSIGNED", assignee_type: "USER", assignee_name: null },
    { assignment_state: "ASSIGNED", assignee_type: "QUEUE", assignee_name: "  " },
    { assignment_state: "ASSIGNED", assignee_type: null, assignee_name: "Unresolved name" },
    { assignment_state: "UNAVAILABLE", assignee_type: "USER", assignee_name: "Unreadable owner" },
  ] satisfies Partial<HouseholdTaskHistoryRow>[])("keeps unresolved or unavailable assignment honest: %j", value => {
    const html = renderTask(value);
    expect(html).toContain("Assignment unavailable");
    expect(html).not.toContain("Assigned to:");
    expect(html).not.toContain(">Unassigned</p>");
    expect(html).not.toContain("Unresolved name");
    expect(html).not.toContain("Unreadable owner");
  });

  it("preserves long source names as escaped text", () => {
    const name = `${"Synthetic long queue ".repeat(10)}<script>alert('invented')</script>`;
    const html = renderTask({ assignment_state: "ASSIGNED", assignee_type: "QUEUE", assignee_name: name });
    expect(html).toContain("Synthetic long queue ".repeat(10));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("starts each task collapsed with a linked compact summary and the retained content inside details", () => {
    const html = renderTask({ source_modified_at: new Date("2026-09-25T03:00:00Z") });
    const row = html.slice(html.indexOf('data-list-row-id="00TSYN000000001"'));
    const openingDetails = row.match(/<details[^>]*>/)?.[0];
    expect(openingDetails).toBeDefined();
    expect(openingDetails).not.toContain("open=");
    const summary = row.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1];
    expect(summary).toContain("Invented task");
    expect(summary).toContain("Not Started");
    expect(summary).toContain("Assignment unavailable");
    expect(summary).toContain("Updated 9/25/2026");
    expect(summary).toContain("View details");
    expect(summary).toContain("Hide details");
    expect(summary).not.toContain("Synthetic task detail");
    expect(summary).not.toContain("Priority:");
    const body = row.slice(row.indexOf("</summary>"));
    expect(body).toContain("Invented task</h3>");
    expect(body).toContain("Synthetic task detail");
    expect(body).toContain("Priority: High");
    expect(body).toContain("Open in CRM");
  });

  it("keeps missing task content useful without inventing a title, priority or date", () => {
    const html = renderTask({ subject: null, priority: null, description: null });
    expect(html).toContain("Untitled task");
    expect(html).toContain("No task description is available.");
    expect(html).not.toContain("Priority:");
    expect(html).not.toContain("Updated ");
  });

  it("groups complete-population assignment options without guessing membership from names", () => {
    const queueToken = "a".repeat(64);
    const personToken = "b".repeat(64);
    navigation.search = `tasksAssignee=${personToken}&tasksCompleted=1`;
    const html = renderTask({}, {
      openCount: 1, completedCount: 3,
      assigneeOptions: [
        { token: queueToken, label: "Later-page queue", type: "QUEUE" },
        { token: personToken, label: "Operations", type: "USER" },
      ],
    });
    expect(html).toContain("Assigned to</span><select");
    expect(html).toContain('<option value="">All assignments</option>');
    expect(html).toContain(`<optgroup label="Queues"><option value="${queueToken}">Later-page queue</option></optgroup>`);
    expect(html).toContain(`<optgroup label="People"><option value="${personToken}" selected="">Operations</option></optgroup>`);
    expect(html).toContain('<option value="unassigned">Unassigned</option>');
    expect(html).toContain('<option value="unavailable">Assignment unavailable</option>');
    // Current URL wins over the outgoing includeCompleted=false server prop.
    expect(html).toContain("Hide completed</button>");
  });

  it("retains a selected filter when its owner no longer occurs in the authorized options", () => {
    const token = "c".repeat(64);
    navigation.search = `tasksAssignee=${token}`;
    const html = renderTask({});
    expect(html).toContain(`<option value="${token}" selected="">Selected assignment</option>`);
    expect(html).not.toContain("<optgroup");
  });
});
