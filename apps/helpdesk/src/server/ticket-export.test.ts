/**
 * S6 ticket-export tests. Pure — no database: the CSV writer, the
 * column contract, the formula-injection guard on ticket text, and the filter set recorded on the
 * TICKET_LIST_EXPORTED row. The DB-backed half (queue scoping, the count matching the file, the audit
 * row landing before the first byte) is in ticket-export.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { TicketExportScope, TicketListQuery, TicketListRow } from "@/types/domain";
import {
  exportFilters,
  TICKET_CSV_COLUMNS,
  TICKET_CSV_COLUMNS_FULL,
  ticketCsvColumns,
  ticketRowToCsvLine,
  ticketRowsToCsv,
} from "@/server/ticket-export";

const ROW: TicketListRow = {
  id: "t_export_1",
  number: 1042,
  subject: "Outgoing wire to Schwab",
  category: "WIRE_TRANSFER",
  priority: "URGENT",
  status: "OPEN",
  queueKey: "OPERATIONS",
  assignee: { id: "u_ops", name: "Mia Ops", email: "mia.ops@wm-helpdesk.local", image: null },
  requesterName: "Margaret Thompson",
  brand: "CEDAR_RIDGE_WEALTH",
  source: "EMAIL",
  isComplaint: false,
  complaintFiledAt: null,
  escalationTarget: "NONE",
  followUpAt: "2026-09-25T13:00:00.000Z",
  externalRef: "ACAT-778812",
  // --- Wave B columns. Defaults that make a pre-Wave-B row correct. ---
  resolution: "NONE",
  mergedIntoId: null,
  mergedIntoNumber: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:30:00.000Z",
  firstResponseDueAt: "2026-09-19T12:30:00.000Z",
  resolutionDueAt: "2026-09-19T14:00:00.000Z",
  firstRespondedAt: "2026-09-19T12:11:00.000Z",
  resolvedAt: null,
  piiRedacted: true,
  piiRedactionCount: 2,
  version: 7,
  sla: {
    phase: "RESOLUTION",
    status: "WARNING",
    dueAt: "2026-09-19T14:00:00.000Z",
    remainingMs: 900_000,
    firstResponseMet: true,
    resolutionMet: null,
  },
};

/** Split one CSV line into cells, honoring RFC 4180 quoting. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.length === 0) {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function cellsFor(row: TicketListRow, scope: TicketExportScope = "standard", extra?: { description?: string; comments?: string }) {
  const columns = ticketCsvColumns(scope);
  const cells = parseCsvLine(ticketRowToCsvLine(row, scope, extra));
  expect(cells).toHaveLength(columns.length);
  return Object.fromEntries(columns.map((c, i) => [c, cells[i]])) as Record<string, string>;
}

describe("TICKET_CSV_COLUMNS", () => {
  it("standard carries no record content — no description, no comment body, no requester email", () => {
    for (const forbidden of ["description", "comments", "requesterEmail", "requesterPhone", "clientReference"]) {
      expect(TICKET_CSV_COLUMNS, forbidden).not.toContain(forbidden);
    }
  });

  it("full is standard plus exactly description and comments, in that order", () => {
    expect(TICKET_CSV_COLUMNS_FULL).toEqual([...TICKET_CSV_COLUMNS, "description", "comments"]);
    expect(ticketCsvColumns("standard")).toEqual(TICKET_CSV_COLUMNS);
    expect(ticketCsvColumns("full")).toEqual(TICKET_CSV_COLUMNS_FULL);
  });

  it("has no duplicate column names", () => {
    expect(new Set(TICKET_CSV_COLUMNS_FULL).size).toBe(TICKET_CSV_COLUMNS_FULL.length);
  });
});

describe("ticketRowToCsvLine", () => {
  it("maps every column to the row's stored value", () => {
    const c = cellsFor(ROW);
    expect(c.number).toBe("1042");
    expect(c.link).toBe("/tickets/wm/1042");
    expect(c.subject).toBe("Outgoing wire to Schwab");
    expect(c.status).toBe("OPEN");
    expect(c.priority).toBe("URGENT");
    expect(c.category).toBe("WIRE_TRANSFER");
    expect(c.queueKey).toBe("OPERATIONS");
    expect(c.brand).toBe("CEDAR_RIDGE_WEALTH");
    expect(c.source).toBe("EMAIL");
    expect(c.requesterName).toBe("Margaret Thompson");
    expect(c.assigneeName).toBe("Mia Ops");
    expect(c.assigneeEmail).toBe("mia.ops@wm-helpdesk.local");
    expect(c.isComplaint).toBe("false");
    expect(c.complaintFiledAt).toBe("");
    expect(c.escalationTarget).toBe("NONE");
    expect(c.followUpAt).toBe("2026-09-25T13:00:00.000Z");
    expect(c.externalRef).toBe("ACAT-778812");
    expect(c.firstRespondedAt).toBe("2026-09-19T12:11:00.000Z");
    expect(c.resolvedAt).toBe("");
    expect(c.slaPhase).toBe("RESOLUTION");
    expect(c.slaStatus).toBe("WARNING");
    expect(c.firstResponseMet).toBe("true");
    expect(c.resolutionMet).toBe("");
    expect(c.piiRedacted).toBe("true");
    expect(c.piiRedactionCount).toBe("2");
  });

  it("renders an unassigned ticket as empty cells, never 'null'", () => {
    const c = cellsFor({ ...ROW, assignee: null, externalRef: null, followUpAt: null });
    expect(c.assigneeName).toBe("");
    expect(c.assigneeEmail).toBe("");
    expect(c.externalRef).toBe("");
    expect(c.followUpAt).toBe("");
  });

  it("neutralizes a spreadsheet formula a client could put in a subject (the injection guard)", () => {
    const line = ticketRowToCsvLine({ ...ROW, subject: "=HYPERLINK(\"http://evil\",\"click\")" }, "standard");
    expect(parseCsvLine(line)[2]).toBe("'=HYPERLINK(\"http://evil\",\"click\")");
    for (const lead of ["+1+1", "-2+3", "@SUM(A1)", "\tTabbed"]) {
      const cells = parseCsvLine(ticketRowToCsvLine({ ...ROW, subject: lead }, "standard"));
      expect(cells[2].startsWith("'"), lead).toBe(true);
    }
  });

  it("quotes and escapes a subject containing a comma, a quote or a newline (RFC 4180)", () => {
    const subject = 'Wire, "urgent"\nsecond line';
    const line = ticketRowToCsvLine({ ...ROW, subject }, "standard");
    expect(line).toContain('"Wire, ""urgent""\nsecond line"');
    expect(parseCsvLine(line)[2]).toBe(subject);
  });

  it("full scope appends the description and the comments; empty when the extra is missing", () => {
    const c = cellsFor({ ...ROW }, "full", { description: "Original text", comments: "[t] INTERNAL a@b: note" });
    expect(c.description).toBe("Original text");
    expect(c.comments).toBe("[t] INTERNAL a@b: note");
    const none = cellsFor({ ...ROW }, "full");
    expect(none.description).toBe("");
    expect(none.comments).toBe("");
  });
});

describe("ticketRowsToCsv", () => {
  it("writes the header in column order and CRLF-terminates every line", () => {
    const csv = ticketRowsToCsv([ROW], true, "standard");
    const lines = csv.split("\r\n");
    expect(lines[lines.length - 1]).toBe("");
    expect(parseCsvLine(lines[0])).toEqual([...TICKET_CSV_COLUMNS]);
    expect(parseCsvLine(lines[1])[0]).toBe("1042");
    expect(lines).toHaveLength(3);
  });

  it("omits the header on a continuation page", () => {
    const csv = ticketRowsToCsv([ROW, { ...ROW, id: "t2", number: 1043 }], false, "standard");
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(parseCsvLine(lines[0])[0]).toBe("1042");
    expect(parseCsvLine(lines[1])[0]).toBe("1043");
  });

  it("an empty page with the header is still a well-formed file; without it, nothing", () => {
    expect(ticketRowsToCsv([], true, "standard").split("\r\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(ticketRowsToCsv([], false, "standard")).toBe("");
  });

  it("looks up each row's extras by ticket id, so a page is never mis-paired", () => {
    const rowB: TicketListRow = { ...ROW, id: "t_export_2", number: 1043 };
    const extras = new Map([
      ["t_export_1", { description: "first" }],
      ["t_export_2", { description: "second" }],
    ]);
    const lines = ticketRowsToCsv([rowB, ROW], false, "full", extras).split("\r\n").filter((l) => l.length > 0);
    const descriptionIndex = TICKET_CSV_COLUMNS_FULL.indexOf("description");
    expect(parseCsvLine(lines[0])[descriptionIndex]).toBe("second");
    expect(parseCsvLine(lines[1])[descriptionIndex]).toBe("first");
  });
});

describe("exportFilters", () => {
  it("keeps what selects rows and drops paging and ordering, which do not", () => {
    const query: TicketListQuery = {
      queueKey: "OPERATIONS",
      status: ["OPEN"],
      isComplaint: true,
      followUp: "overdue",
      createdFrom: "2026-09-01T00:00:00.000Z",
      requesterEmail: "margaret@example.com",
      sort: "createdAt",
      dir: "desc",
      page: 4,
      pageSize: 200,
    };
    const filters = exportFilters(query) as Record<string, unknown>;
    expect(filters).toEqual({
      queueKey: "OPERATIONS",
      status: ["OPEN"],
      isComplaint: true,
      followUp: "overdue",
      createdFrom: "2026-09-01T00:00:00.000Z",
      requesterEmail: "margaret@example.com",
    });
    for (const dropped of ["sort", "dir", "page", "pageSize"]) {
      expect(filters, dropped).not.toHaveProperty(dropped);
    }
  });

  it("does not mutate the query it is given", () => {
    const query: TicketListQuery = { sort: "updatedAt", dir: "asc", page: 1, pageSize: 50 };
    exportFilters(query);
    expect(query.page).toBe(1);
    expect(query.sort).toBe("updatedAt");
  });
});
