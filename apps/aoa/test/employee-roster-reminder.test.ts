import { describe, expect, it } from "vitest";
import { evaluateEmployeeRosterReminder } from "@/lib/data/employee-roster-reminder";

describe("quarterly employee roster reminder", () => {
  it("becomes due on the first business day after quarter end", () => {
    const before = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-03-31",
      now: new Date("2026-06-30T16:00:00.000Z"),
    });
    expect(before.state).toBe("CURRENT");

    const nextDay = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-03-31",
      now: new Date("2026-07-01T12:00:00.000Z"),
    });
    expect(nextDay.state).toBe("DUE");
    expect(nextDay.requiredThrough).toBe("2026-06-30");
    expect(nextDay.dueDate).toBe("2026-07-01");
    expect(nextDay.notification?.href).toBe("/crm/employees");
  });

  it("uses the New York business date and skips the New Year holiday", () => {
    const stillQuarterEndInNewYork = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-09-30",
      now: new Date("2027-01-01T02:00:00.000Z"),
    });
    expect(stillQuarterEndInNewYork.state).toBe("CURRENT");

    const firstBusinessDay = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-09-30",
      now: new Date("2027-01-04T17:00:00.000Z"),
    });
    expect(firstBusinessDay.state).toBe("DUE");
    expect(firstBusinessDay.dueDate).toBe("2027-01-04");
  });

  it("clears after an applied snapshot covers the completed quarter", () => {
    const reminder = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-07-02",
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(reminder.state).toBe("CURRENT");
    expect(reminder.notification).toBeNull();
    expect(reminder.nextReminderDate).toBe("2026-10-01");
  });

  it("becomes overdue after ten business days and never duplicates", () => {
    const first = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-03-31",
      now: new Date("2026-07-16T12:00:00.000Z"),
    });
    const second = evaluateEmployeeRosterReminder({
      activeEffectiveDate: "2026-03-31",
      now: new Date("2026-07-16T19:00:00.000Z"),
    });
    expect(first.state).toBe("OVERDUE");
    expect(first.notification?.id).toBe("employee-roster:2026-06-30");
    expect(second.notification?.id).toBe(first.notification?.id);
  });

  it("requires a refresh when no roster has ever been applied", () => {
    const reminder = evaluateEmployeeRosterReminder({
      activeEffectiveDate: null,
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(reminder.state).toBe("OVERDUE");
    expect(reminder.notification?.title).toContain("overdue");
  });
});
