import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HouseholdHistoryPage } from "@/lib/data/household-history";
import type { HouseholdActivity, HouseholdEmail, HouseholdTaskHistoryRow, ZendeskTicket } from "@/lib/data/types";
import { utcDateLabel, utcDateTimeLabel } from "@/lib/display-date";

vi.mock("next/navigation", () => ({
  usePathname: () => "/households/SYNTHETIC",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

import { ActivityCard } from "@/components/client-portrait/ActivityCard";
import { EmailCard } from "@/components/client-portrait/EmailCard";
import { TasksCard } from "@/components/client-portrait/TasksCard";
import { ZendeskTicketsCard } from "@/components/client-portrait/ZendeskTicketsCard";

const nativeDate = Date.prototype.toLocaleDateString;
const nativeDateTime = Date.prototype.toLocaleString;

// Model the differing defaults of a UTC server and users' browsers without
// mutating process-wide TZ or depending on the test worker's host locale.
// Explicit formatter options still win, and the native Intl implementation
// produces every label. Assertions below also prove these defaults differ.
function ambientDefaults(locale: string, timeZone: string) {
  vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, locales, options) {
    return nativeDate.call(this, locales ?? locale, { timeZone, ...options });
  });
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date, locales, options) {
    return nativeDateTime.call(this, locales ?? locale, { timeZone, ...options });
  });
}

function page<Row>(rows: Row[]) {
  return {
    rows, page: 1, pageSize: 100, total: rows.length, pageCount: 1,
    snapshot: "synthetic", meta: { openCount: rows.length, completedCount: 0 },
  };
}

const dates = [new Date("2026-09-18T02:30:00Z"), new Date("2026-01-01T01:30:00Z")];
const tasks = dates.map((date, index): HouseholdTaskHistoryRow => ({
  sf_id: `SYNTHETIC-TASK-${index}`, subject: `Synthetic task ${index}`,
  status: "Not Started", priority: null, description: null, source_modified_at: date,
  assignment_state: "UNAVAILABLE", assignee_type: null, assignee_name: null,
}));
const emails = dates.map((date, index): HouseholdEmail => ({
  sf_id: `SYNTHETIC-EMAIL-${index}`, subject: `Synthetic email ${index}`,
  body: "Synthetic message", sent_at: date, source_modified_at: date,
}));
const activities = dates.map((date, index): HouseholdActivity => ({
  sf_id: `SYNTHETIC-CALL-${index}`, subject: `Synthetic call ${index}`,
  note: null, owner_name: "Synthetic owner", activity_at: index === 0 ? date : null,
  source_modified_at: date,
}));
const tickets = dates.map((date, index): ZendeskTicket => ({
  zendesk_ticket_id: `SYNTHETIC-TICKET-${index}`, requester_id: "synthetic-client",
  subject: `Synthetic ticket ${index}`, description: null, status: "open",
  priority: null, ticket_type: null, ticket_url: "https://example.test/ticket",
  created_at: date, source_updated_at: date, comments_truncated: false,
  comments: [{
    zendesk_comment_id: `SYNTHETIC-COMMENT-${index}`, author_id: "synthetic-client",
    body: "Synthetic comment", created_at: date,
  }],
}));

function renderCards(serialized = false) {
  // Paged history API rows are JSON strings, whereas initial RSC props retain
  // Date objects. Exercise that runtime seam with the same synthetic records.
  const payload = <T,>(value: T): T => serialized ? JSON.parse(JSON.stringify(value)) as T : value;
  const common = { householdId: "SYNTHETIC", scope: "synthetic" };
  return {
    tasks: renderToStaticMarkup(createElement(TasksCard, {
      ...common, initialPage: payload(page(tasks)), includeCompleted: false,
    })),
    email: renderToStaticMarkup(createElement(EmailCard, {
      ...common, initialPage: payload(page(emails)),
    })),
    activity: renderToStaticMarkup(createElement(ActivityCard, {
      ...common, initialPage: payload(page(activities)),
    })),
    zendesk: renderToStaticMarkup(createElement(ZendeskTicketsCard, {
      scope: "household", tickets: payload(tickets),
    })),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("household card date rendering", () => {
  it("normalizes timestamp offsets and preserves empty display values", () => {
    expect(utcDateLabel("2026-09-17T22:30:00-04:00")).toBe("9/18/2026");
    expect(utcDateTimeLabel("2026-09-17T22:30:00-04:00")).toBe("9/18/2026, 2:30:00 AM UTC");
    for (const empty of [null, undefined, ""]) {
      expect(utcDateLabel(empty)).toBe("");
      expect(utcDateTimeLabel(empty)).toBe("");
    }
  });

  it.each([
    ["en-US", "America/New_York"],
    ["en-GB", "Europe/London"],
    ["de-DE", "Europe/Berlin"],
    ["ja-JP", "Asia/Tokyo"],
  ])("preserves identical card HTML with %s / %s browser defaults", (locale, timeZone) => {
    ambientDefaults("en-US", "UTC");
    const server = renderCards();
    const serverDefault = dates[0].toLocaleDateString();
    vi.restoreAllMocks();
    ambientDefaults(locale, timeZone);
    expect(dates[0].toLocaleDateString()).not.toBe(serverDefault);
    const browser = renderCards();
    for (const kind of ["tasks", "email", "activity", "zendesk"] as const) {
      expect(browser[kind], `${kind} must retain its server HTML`).toBe(server[kind]);
      expect(browser[kind]).toContain("9/18/2026");
      expect(browser[kind]).toContain("1/1/2026");
    }
  });

  it("labels full comment timestamps as UTC and accepts JSON date strings", () => {
    ambientDefaults("en-US", "UTC");
    const cards = renderCards();
    expect(cards.zendesk).toContain("9/18/2026, 2:30:00 AM UTC");
    expect(cards.zendesk).toContain("1/1/2026, 1:30:00 AM UTC");
    expect(renderCards(true)).toEqual(cards);
  });

  it("keeps absent task, email, and activity dates empty", () => {
    const common = { householdId: "SYNTHETIC", scope: "synthetic" };
    const taskPage: HouseholdHistoryPage<"tasks"> = page([{ ...tasks[0], source_modified_at: null }]);
    const emailPage: HouseholdHistoryPage<"email"> = page([{ ...emails[0], sent_at: null, source_modified_at: null }]);
    const activityPage: HouseholdHistoryPage<"activity"> = page([{ ...activities[0], activity_at: null, source_modified_at: null }]);
    const html = [
      renderToStaticMarkup(createElement(TasksCard, { ...common, initialPage: taskPage, includeCompleted: false })),
      renderToStaticMarkup(createElement(EmailCard, { ...common, initialPage: emailPage })),
      renderToStaticMarkup(createElement(ActivityCard, { ...common, initialPage: activityPage })),
    ].join("");
    expect(html).not.toMatch(/Invalid Date|1970|9\/18\/2026/);
    expect(html).toContain("Synthetic owner</div>");
  });
});
