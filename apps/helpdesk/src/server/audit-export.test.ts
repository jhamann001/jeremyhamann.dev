/**
 * audit-export.ts unit tests (docs/ARCHITECTURE.md §g S3 tests): RFC 4180 quoting, the spreadsheet
 * formula-injection guard for every leading character, header order, CRLF line endings.
 */
import { describe, expect, it } from "vitest";
import type { AuditRow } from "@/types/domain";
import { AUDIT_CSV_COLUMNS, auditRowsToCsv, csvCell } from "@/server/audit-export";

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "clx_row_1",
    seq: "42",
    occurredAt: "2026-09-16T12:00:00.000Z",
    actorId: "user_1",
    actorEmail: "ops.dev@wm-helpdesk.local",
    actorGroups: ["ops_team", "compliance_officers"],
    dualRole: true,
    action: "TICKET_FIELD_CHANGED",
    entityType: "TICKET",
    entityId: "ticket_1",
    ticketId: "ticket_1",
    ticketNumber: 1042,
    fieldChanged: "subject",
    oldValue: "Old subject",
    newValue: "New subject",
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    requestId: "req-abcdef12",
    metadata: { note: "outside the hash" },
    prevHash: "GENESIS",
    hash: "a".repeat(64),
    ...overrides,
  };
}

describe("csvCell — RFC 4180", () => {
  it("null and undefined become the empty cell", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("plain values and numbers pass through unquoted", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(1042)).toBe("1042");
    expect(csvCell("")).toBe("");
  });

  it("quotes a value containing a comma", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("quotes a value containing a double quote and doubles the quote", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a value containing LF or CR", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvCell("x\ry")).toBe('"x\ry"');
  });

  it("does not quote values that need no quoting even when they contain spaces or semicolons", () => {
    expect(csvCell("SSN=1;CARD=0")).toBe("SSN=1;CARD=0");
    expect(csvCell("two words")).toBe("two words");
  });
});

describe("csvCell — formula-injection guard", () => {
  const leads: Array<[string, string]> = [
    ["=", "=SUM(A1:A9)"],
    ["+", "+1+1"],
    ["-", "-23m"],
    ["@", "@cmd"],
    ["\\t", "\tdata"],
    ["\\r", "\rdata"],
  ];
  for (const [label, value] of leads) {
    it(`prefixes a leading ${label} with a single quote`, () => {
      const out = csvCell(value);
      // The guard runs before quoting; a CR-led value is then also quoted because it contains CR.
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.slice(1)).toBe(value);
    });
  }

  it("does not alter the same characters when they are not leading", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("1+1")).toBe("1+1");
    expect(csvCell("x-y")).toBe("x-y");
    expect(csvCell("user@example.com")).toBe("user@example.com");
  });

  it("guards a leading formula that also needs quoting", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
  });
});

describe("auditRowsToCsv", () => {
  it("header order equals AUDIT_CSV_COLUMNS and lines end with CRLF", () => {
    const csv = auditRowsToCsv([], true);
    expect(csv).toBe(`${AUDIT_CSV_COLUMNS.join(",")}\r\n`);
    expect(AUDIT_CSV_COLUMNS).toEqual([
      "seq",
      "occurredAt",
      "actorEmail",
      "actorGroups",
      "action",
      "entityType",
      "entityId",
      "ticketNumber",
      "fieldChanged",
      "oldValue",
      "newValue",
      "ipAddress",
      "userAgent",
      "requestId",
      "prevHash",
      "hash",
    ]);
  });

  it("emits nothing for no rows and no header", () => {
    expect(auditRowsToCsv([], false)).toBe("");
  });

  it("writes one CRLF-terminated line per row with actorGroups joined by |", () => {
    const csv = auditRowsToCsv([row(), row({ seq: "43", actorGroups: ["advisors"] })], false);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3); // two rows + trailing empty segment after the final CRLF
    expect(lines[2]).toBe("");
    expect(csv).not.toMatch(/[^\r]\n/);
    const first = lines[0].split(",");
    expect(first).toHaveLength(AUDIT_CSV_COLUMNS.length);
    expect(first[0]).toBe("42");
    expect(first[1]).toBe("2026-09-16T12:00:00.000Z");
    expect(first[2]).toBe("ops.dev@wm-helpdesk.local");
    expect(first[3]).toBe("ops_team|compliance_officers");
    expect(first[4]).toBe("TICKET_FIELD_CHANGED");
    expect(first[7]).toBe("1042");
    expect(first[14]).toBe("GENESIS");
    expect(first[15]).toBe("a".repeat(64));
    expect(lines[1].split(",")[3]).toBe("advisors");
  });

  it("does not include metadata, dualRole, id or ticketId columns (only the contract columns)", () => {
    const csv = auditRowsToCsv([row({ metadata: { secret: "never-exported" } })], true);
    expect(csv).not.toContain("never-exported");
    expect(csv).not.toContain("clx_row_1");
    expect(csv.split("\r\n")[0].split(",")).not.toContain("metadata");
  });

  it("quotes cells with commas, quotes and newlines and guards formula-led values", () => {
    const csv = auditRowsToCsv(
      [
        row({
          oldValue: 'said "hello", then\nleft',
          newValue: "=1+1",
          ticketNumber: null,
          userAgent: null,
        }),
      ],
      false,
    );
    expect(csv).toContain('"said ""hello"", then\nleft"');
    expect(csv).toContain(",'=1+1,");
    // Empty ticketNumber and userAgent cells.
    const cells = csv.replace(/\r\n$/, "").match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
    expect(cells.length).toBeGreaterThanOrEqual(AUDIT_CSV_COLUMNS.length);
  });
});
