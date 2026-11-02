import { describe, expect, it } from "vitest";
import {
  defaultSnoozeDate,
  fmtSnoozeDate,
  isValidSnoozeDate,
  signalRoleBadge,
} from "@/components/command-center/cc-interactivity";

// Pure-helper coverage for the Command Center P2 interactivity (ticket).
// Component behavior (snooze/create-task/Resolved) is verified live — these
// pin the mockup-derived mappings the components lean on.

describe("signalRoleBadge", () => {
  it("maps the mockup sigRoleColor table", () => {
    expect(signalRoleBadge("Advisor")).toEqual({ tone: "green", label: "Advisor" });
    expect(signalRoleBadge("Client Service")).toEqual({ tone: "blue", label: "CS" });
    expect(signalRoleBadge("Operations")).toEqual({ tone: "amber", label: "Operations" });
    expect(signalRoleBadge("All")).toEqual({ tone: "gray", label: "All" });
  });

  it("falls back gray for unknown roles, preserving the label", () => {
    expect(signalRoleBadge("Compliance")).toEqual({ tone: "gray", label: "Compliance" });
  });
});

describe("fmtSnoozeDate", () => {
  it("formats ISO dates as 'Mon D' without zero padding", () => {
    expect(fmtSnoozeDate("2026-07-09")).toBe("Jul 9");
    expect(fmtSnoozeDate("2026-01-01")).toBe("Jan 1");
    expect(fmtSnoozeDate("2026-12-31")).toBe("Dec 31");
  });

  it("returns '' for empty or malformed input", () => {
    expect(fmtSnoozeDate("")).toBe("");
    expect(fmtSnoozeDate("not-a-date")).toBe("");
    expect(fmtSnoozeDate("2026-13-01")).toBe(""); // month out of range
    expect(fmtSnoozeDate("2026-7-9")).toBe(""); // not zero-padded ISO
  });
});

describe("defaultSnoozeDate", () => {
  it("defaults to +7 days, ISO-formatted", () => {
    expect(defaultSnoozeDate(new Date("2026-07-01T12:00:00Z"))).toBe("2026-07-08");
  });

  it("crosses month boundaries", () => {
    expect(defaultSnoozeDate(new Date("2026-07-28T12:00:00Z"))).toBe("2026-08-04");
  });

  it("honors a custom day count", () => {
    expect(defaultSnoozeDate(new Date("2026-07-01T12:00:00Z"), 1)).toBe("2026-07-02");
  });
});

describe("isValidSnoozeDate", () => {
  const today = "2026-07-01";
  it("accepts today and future dates", () => {
    expect(isValidSnoozeDate("2026-07-01", today)).toBe(true);
    expect(isValidSnoozeDate("2026-07-09", today)).toBe(true);
  });
  it("rejects past dates and malformed input", () => {
    expect(isValidSnoozeDate("2026-06-30", today)).toBe(false);
    expect(isValidSnoozeDate("", today)).toBe(false);
    expect(isValidSnoozeDate("tomorrow", today)).toBe(false);
  });
});
