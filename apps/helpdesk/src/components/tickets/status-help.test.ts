/**
 * The status vocabulary CS is trained on.
 *
 * The point of the test is TOTALITY plus the three statuses that do not mean what they mean in
 * legacy help desk: a status with no "watch out" line is a status somebody will assume behaves the old way.
 */
import { describe, expect, it } from "vitest";
import { TICKET_STATUSES } from "@/types/domain";
import { STATUS_HELP, statusHelpFor, statusHelpText } from "@/components/tickets/status-help";

describe("STATUS_HELP", () => {
  it("covers every status — the map is exhaustive by construction and by assertion", () => {
    for (const status of TICKET_STATUSES) {
      expect(STATUS_HELP[status]?.means, status).toBeTruthy();
    }
    expect(Object.keys(STATUS_HELP).sort()).toEqual([...TICKET_STATUSES].sort());
  });

  it("warns on the three that behave differently from the legacy help desk", () => {
    expect(statusHelpFor("PENDING_CLIENT").watchOut).toMatch(/sends nothing/i);
    expect(statusHelpFor("CLOSED").watchOut).toMatch(/terminal/i);
    expect(statusHelpFor("PENDING_INTERNAL").watchOut).toMatch(/clock still runs/i);
  });

  it("says what a void actually costs, in the sentence beside the control", () => {
    const help = statusHelpFor("VOIDED");
    expect(help.watchOut).toMatch(/counter/i);
    expect(help.watchOut).toMatch(/cannot be undone/i);
  });

  it("renders one string for a title or a live region", () => {
    expect(statusHelpText("NEW")).toBe(STATUS_HELP.NEW.means);
    expect(statusHelpText("OPEN")).toContain(STATUS_HELP.OPEN.watchOut ?? "");
  });
});
