import { describe, expect, it } from "vitest";
import { SLA_WARNING_THRESHOLD_MS } from "@/types/domain";
import { assertPiiLight } from "@/jobs/slack";
import {
  alertAlreadyFiredThisCycle,
  alertKey,
  alertVerdict,
  classifySlaAlert,
  cycleResetWhere,
  formatMinutes,
  isUniqueViolation,
  orderAlerts,
  parseAlertVerdict,
  slaAlertLine,
  slaDigestHeader,
  slaDigestLines,
} from "@/jobs/sla-sweep";
import type { SlaAlertCandidate, SlaCandidate } from "@/jobs/sla-sweep";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const BASE = "https://desk.example";

function candidate(overrides: Partial<SlaCandidate> = {}): SlaCandidate {
  return {
    id: "tkt_1",
    number: 1482,
    priority: "HIGH",
    queueKey: "OPERATIONS",
    firstRespondedAt: null,
    firstResponseDueAt: new Date(NOW.getTime() + 60 * 60_000),
    resolutionDueAt: new Date(NOW.getTime() + 8 * 60 * 60_000),
    cycleStartedAt: null,
    ...overrides,
  };
}

function alert(overrides: Partial<SlaAlertCandidate> = {}): SlaAlertCandidate {
  return {
    ...candidate(),
    phase: "FIRST_RESPONSE",
    kind: "BREACHED",
    minutesOver: 185,
    minutesToDue: 0,
    ...overrides,
  };
}

describe("classifySlaAlert", () => {
  it("watches the first-response clock until a first response exists, then the resolution clock", () => {
    const beforeReply = candidate({ firstResponseDueAt: new Date(NOW.getTime() - 60_000) });
    expect(classifySlaAlert(beforeReply, NOW)).toMatchObject({ phase: "FIRST_RESPONSE", kind: "BREACHED" });

    const afterReply = candidate({
      firstRespondedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
      firstResponseDueAt: new Date(NOW.getTime() - 60_000),
      resolutionDueAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(classifySlaAlert(afterReply, NOW)).toMatchObject({ phase: "RESOLUTION", kind: "BREACHED", minutesOver: 10 });
  });

  it("matches the sla-where boundaries exactly: due === now is WARNING, due < now is BREACHED", () => {
    expect(classifySlaAlert(candidate({ firstResponseDueAt: NOW }), NOW)).toMatchObject({
      kind: "WARNING",
      minutesOver: 0,
      minutesToDue: 0,
    });
    expect(classifySlaAlert(candidate({ firstResponseDueAt: new Date(NOW.getTime() - 1) }), NOW)).toMatchObject({
      kind: "BREACHED",
      minutesOver: 0,
    });
  });

  it("warns strictly inside the 30-minute window and not at its far edge", () => {
    const justInside = new Date(NOW.getTime() + SLA_WARNING_THRESHOLD_MS - 1);
    const atEdge = new Date(NOW.getTime() + SLA_WARNING_THRESHOLD_MS);
    expect(classifySlaAlert(candidate({ firstResponseDueAt: justInside }), NOW)).toMatchObject({ kind: "WARNING" });
    expect(classifySlaAlert(candidate({ firstResponseDueAt: atEdge }), NOW)).toBeNull();
  });

  it("reports whole minutes over, rounded down", () => {
    const due = new Date(NOW.getTime() - (185 * 60_000 + 59_000));
    expect(classifySlaAlert(candidate({ firstResponseDueAt: due }), NOW)).toMatchObject({ minutesOver: 185 });
  });

  it("returns null when both clocks are comfortably in the future", () => {
    expect(classifySlaAlert(candidate(), NOW)).toBeNull();
  });
});

describe("alertKey", () => {
  it("is the unique constraint, so two kinds on one ticket are distinct alerts", () => {
    expect(alertKey("t", "FIRST_RESPONSE", "WARNING")).not.toBe(alertKey("t", "FIRST_RESPONSE", "BREACHED"));
    expect(alertKey("t", "FIRST_RESPONSE", "WARNING")).not.toBe(alertKey("t", "RESOLUTION", "WARNING"));
    expect(alertKey("t", "RESOLUTION", "BREACHED")).toBe(alertKey("t", "RESOLUTION", "BREACHED"));
  });
});

describe("formatMinutes", () => {
  it("renders minutes, hours and days compactly", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(185)).toBe("3h 05m");
    expect(formatMinutes(60 * 24 * 2 + 60 * 4)).toBe("2d 04h");
    expect(formatMinutes(-9)).toBe("0m");
  });
});

describe("slaAlertLine", () => {
  it("carries number, queue, priority, phase, how far over and the deep link — and nothing else", () => {
    const line = slaAlertLine(alert(), BASE);
    expect(line.text).toBe(
      ":red_circle: BREACHED | <https://desk.example/tickets/wm/1482|HD-1482> | OPERATIONS | HIGH | first response | 3h 05m over",
    );
  });

  it("says how long is left for a warning rather than how long it is over", () => {
    const line = slaAlertLine(alert({ kind: "WARNING", minutesOver: 0, minutesToDue: 12, phase: "RESOLUTION" }), BASE);
    expect(line.text).toContain(":large_yellow_circle: WARNING");
    expect(line.text).toContain("resolution | due in 12m");
  });

  it("is PII-light for every priority and queue", () => {
    for (const queueKey of ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"] as const) {
      for (const priority of ["URGENT", "HIGH", "STANDARD", "LOW"] as const) {
        expect(() => assertPiiLight(slaAlertLine(alert({ queueKey, priority }), BASE).text)).not.toThrow();
        expect(() => assertPiiLight(slaAlertLine(alert({ queueKey, priority }), undefined).text)).not.toThrow();
      }
    }
  });
});

describe("slaDigestHeader / slaDigestLines", () => {
  it("counts breached and warning separately and stays singular for one alert", () => {
    expect(slaDigestHeader([alert()]).text).toBe("*WM help desk — SLA sweep:* 1 new alert (1 breached, 0 warning)");
    expect(slaDigestHeader([alert(), alert({ kind: "WARNING" })]).text).toBe(
      "*WM help desk — SLA sweep:* 2 new alerts (1 breached, 1 warning)",
    );
  });

  it("puts the header first and one line per alert after it", () => {
    const lines = slaDigestLines([alert(), alert({ number: 7 })], BASE);
    expect(lines).toHaveLength(3);
    expect(lines[0].text).toContain("SLA sweep");
    expect(lines[2].text).toContain("HD-7");
  });
});

describe("orderAlerts", () => {
  it("puts breached first, then the most overdue, then the lowest ticket number", () => {
    const ordered = orderAlerts([
      alert({ number: 3, kind: "WARNING", minutesOver: 0, minutesToDue: 20 }),
      alert({ number: 2, minutesOver: 10 }),
      alert({ number: 1, minutesOver: 400 }),
      alert({ number: 9, kind: "WARNING", minutesOver: 0, minutesToDue: 4 }),
    ]);
    expect(ordered.map((a) => a.number)).toEqual([1, 2, 9, 3]);
  });

  it("does not mutate its input", () => {
    const input = [alert({ number: 2 }), alert({ number: 1, minutesOver: 900 })];
    orderAlerts(input);
    expect(input.map((a) => a.number)).toEqual([2, 1]);
  });
});

describe("isUniqueViolation", () => {
  it("recognises P2002 and nothing else", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe("alertVerdict / parseAlertVerdict", () => {
  it("round-trips every phase and kind the ledger can hold", () => {
    for (const phase of ["FIRST_RESPONSE", "RESOLUTION"] as const) {
      for (const kind of ["WARNING", "BREACHED"] as const) {
        expect(parseAlertVerdict(alertVerdict(phase, kind))).toEqual({ phase, kind });
      }
    }
  });

  it("writes exactly the newValue the audit catalog specifies", () => {
    expect(alertVerdict("FIRST_RESPONSE", "BREACHED")).toBe("FIRST_RESPONSE:BREACHED");
    expect(alertVerdict("RESOLUTION", "WARNING")).toBe("RESOLUTION:WARNING");
  });

  it("refuses anything it did not write, rather than guessing a phase or kind", () => {
    expect(parseAlertVerdict(null)).toBeNull();
    expect(parseAlertVerdict("")).toBeNull();
    expect(parseAlertVerdict("RESOLUTION")).toBeNull();
    expect(parseAlertVerdict("RESOLUTION:BREACHED:EXTRA")).toBeNull();
    expect(parseAlertVerdict("RESOLUTION:MELTDOWN")).toBeNull();
    expect(parseAlertVerdict("SOMEDAY_PHASE:BREACHED")).toBeNull();
    expect(parseAlertVerdict("resolution:breached")).toBeNull();
  });
});

describe("alertAlreadyFiredThisCycle", () => {
  const reopenedAt = new Date(NOW.getTime() - 20 * 60_000);

  it("does not suppress a ticket that has never alerted", () => {
    expect(alertAlreadyFiredThisCycle(undefined, null)).toBe(false);
    expect(alertAlreadyFiredThisCycle(undefined, reopenedAt)).toBe(false);
  });

  it("suppresses any earlier alert on a ticket that was never reopened — the original behaviour", () => {
    expect(alertAlreadyFiredThisCycle(new Date(NOW.getTime() - 9 * 24 * 60 * 60_000), null)).toBe(true);
    expect(alertAlreadyFiredThisCycle(NOW, null)).toBe(true);
  });

  it("lets a reopened ticket page again: an alert from the PREVIOUS lifecycle does not silence it", () => {
    const beforeReopen = new Date(reopenedAt.getTime() - 1);
    expect(alertAlreadyFiredThisCycle(beforeReopen, reopenedAt)).toBe(false);
  });

  it("still suppresses a second page within the SAME lifecycle", () => {
    const afterReopen = new Date(reopenedAt.getTime() + 60_000);
    expect(alertAlreadyFiredThisCycle(afterReopen, reopenedAt)).toBe(true);
  });

  it("treats an alert stamped at the reopen instant as belonging to the new lifecycle", () => {
    expect(alertAlreadyFiredThisCycle(reopenedAt, reopenedAt)).toBe(true);
  });
});

describe("cycleResetWhere", () => {
  it("matches both reopen paths and nothing else", () => {
    const where = cycleResetWhere(["t1", "t2"]);
    expect(where.ticketId).toEqual({ in: ["t1", "t2"] });
    expect(where.OR).toEqual([
      { action: "TICKET_REOPENED_BY_REQUESTER" },
      { action: "TICKET_STATUS_CHANGED", oldValue: "RESOLVED", newValue: "OPEN" },
    ]);
  });

  it("copies the id list, so a later mutation of the caller's array cannot widen the query", () => {
    const ids = ["t1"];
    const where = cycleResetWhere(ids);
    ids.push("t2");
    expect(where.ticketId).toEqual({ in: ["t1"] });
  });
});

describe("slaAlertLine — reopened tickets", () => {
  it("marks a repeat page on a reopened ticket, so it does not read as a duplicate", () => {
    const line = slaAlertLine(alert({ cycleStartedAt: new Date(NOW.getTime() - 30 * 60_000) }), BASE);
    expect(line.text).toBe(
      ":red_circle: BREACHED | <https://desk.example/tickets/wm/1482|HD-1482> | OPERATIONS | HIGH | first response | 3h 05m over | reopened",
    );
  });

  it("says nothing extra for a ticket on its first lifecycle", () => {
    expect(slaAlertLine(alert(), BASE).text).not.toContain("reopened");
  });

  it("stays PII-light: the marker is a fixed word, never a date or an actor", () => {
    const line = slaAlertLine(alert({ cycleStartedAt: NOW, queueKey: "CLIENT_SERVICE" }), undefined);
    expect(() => assertPiiLight(line.text)).not.toThrow();
    expect(line.text).not.toContain(NOW.toISOString());
  });
});
