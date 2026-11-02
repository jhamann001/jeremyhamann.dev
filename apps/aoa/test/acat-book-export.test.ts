import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import { acatBookCsvFilename, buildAcatBookCsv } from "@/lib/data/acat-book-export";
import { bookGroup, type AcatBookRow } from "@/lib/data/acat-book";

const SUITE = "acat-book-export";

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  const id = over.id ?? "rec-1";
  return {
    acatTransferId: id,
    clientName: "Client",
    controlNumber: null,
    direction: "In",
    type: "Full",
    accountType: "Brokerage",
    status: "Submitted",
    transferringContra: "Schwab",
    statementAmount: 100000,
    acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z",
    apexAccountId: "****1111",
    statementAccountNumber: null,
    dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null,
    crmDealId: null,
    tradeInstructionsBlank: false,
    notes: null,
    tradeInstructions: null,
    custodianName: "",
    textLoadError: null,
    feeCharged: null,
    feeRequestCompleted: null,
    hasIssue: false,
    removedAt: null,
    ...over,
    id,
  };
}

const TRACKER_COLUMNS = [
  { id: "clientName", label: "Client" },
  { id: "status", label: "Status" },
  { id: "transferringContra", label: "Contra" },
  { id: "direction", label: "Direction" },
  { id: "statementAmount", label: "Statement Amount" },
  { id: "link", label: "Link" },
];

const LEGACY_COLUMNS = [
  { id: "client", label: "Client" },
  { id: "account", label: "Account" },
  { id: "status", label: "Status" },
  { id: "contra", label: "Contra" },
  { id: "direction", label: "Direction" },
  { id: "type", label: "Type" },
  { id: "date", label: "Date" },
  { id: "link", label: "Link" },
];

const lines = (csv: string) => csv.split("\r\n").filter((l) => l !== "");

describe("book CSV export", () => {
  it("tkt332 export: the header row is the shown column labels in order", () => {
    const csv = buildAcatBookCsv({ rows: [bookRow()], columns: TRACKER_COLUMNS, tracker: true, linkedFor: () => false });
    expect(lines(csv)[0]).toBe("Client,Status,Contra,Direction,Statement Amount,Link");
    const narrowed = buildAcatBookCsv({ rows: [bookRow()], columns: [TRACKER_COLUMNS[1], TRACKER_COLUMNS[0]], tracker: true, linkedFor: () => false });
    expect(lines(narrowed)[0]).toBe("Status,Client");
    markCase(SUITE, "tkt332 export: the header row is the shown column labels in order");
  });

  it("tkt332 export: rows follow the group order and include every row of every group", () => {
    const rows = [
      bookRow({ id: "rec-done", clientName: "Done Client", status: "Completed" }),
      bookRow({ id: "rec-open", clientName: "Open Client", status: "Submitted" }),
      bookRow({ id: "rec-rej", clientName: "Rejected Client", status: "Rejected" }),
      bookRow({ id: "rec-open-2", clientName: "Second Open", status: "Submitted" }),
    ];
    const ordered = bookGroup(rows).flatMap((g) => g.rows);
    const csv = buildAcatBookCsv({ rows: ordered, columns: [TRACKER_COLUMNS[0]], tracker: true, linkedFor: () => false });
    const names = lines(csv).slice(1);
    expect(names).toEqual(ordered.map((r) => r.clientName));
    expect(names).toHaveLength(4);
    expect(names.indexOf("Done Client")).toBeGreaterThan(names.indexOf("Open Client"));
    markCase(SUITE, "tkt332 export: rows follow the group order and include every row of every group");
  });

  it("tkt332 export: tracker columns use the book cell text and blank where the book shows a dash", () => {
    const row = bookRow({ transferringContra: null, statementAmount: null, direction: "Out", status: "Completed" });
    const csv = buildAcatBookCsv({ rows: [row], columns: TRACKER_COLUMNS, tracker: true, linkedFor: () => true });
    expect(lines(csv)[1]).toBe("Client,Completed,,OUT,,Linked");
    const priced = buildAcatBookCsv({ rows: [bookRow()], columns: TRACKER_COLUMNS, tracker: true, linkedFor: () => false });
    expect(lines(priced)[1]).toBe('Client,Submitted,Schwab,IN,"$1,000.00",Not linked');
    markCase(SUITE, "tkt332 export: tracker columns use the book cell text and blank where the book shows a dash");
  });

  it("tkt332 export: legacy columns use the text the table shows", () => {
    const row = bookRow({ apexAccountId: "Fzmgab45nX2", statementAccountNumber: "STMT2", acatDate: "2026-07-10" });
    const csv = buildAcatBookCsv({ rows: [row, bookRow({ id: "rec-2", clientName: null, apexAccountId: null, transferringContra: null })], columns: LEGACY_COLUMNS, tracker: false, linkedFor: (r) => r.id === "rec-1" });
    expect(lines(csv)).toEqual([
      "Client,Account,Status,Contra,Direction,Type,Date,Link",
      "Client,Fzmgab45nX2 · STMT2,Submitted,Schwab,In,Full,2026-07-10,Linked",
      ",,Submitted,,In,Full,2026-07-10,Not linked",
    ]);
    markCase(SUITE, "tkt332 export: legacy columns use the text the table shows");
  });

  it("tkt332 export: an empty view yields the header row only", () => {
    const csv = buildAcatBookCsv({ rows: [], columns: TRACKER_COLUMNS, tracker: true, linkedFor: () => false });
    expect(csv).toBe("Client,Status,Contra,Direction,Statement Amount,Link\r\n");
    markCase(SUITE, "tkt332 export: an empty view yields the header row only");
  });

  it("tkt332 export: quotes, commas, and line breaks are escaped", () => {
    const row = bookRow({ clientName: 'Smith, "Jr."\nExample' });
    const csv = buildAcatBookCsv({ rows: [row], columns: [TRACKER_COLUMNS[0]], tracker: true, linkedFor: () => false });
    expect(csv).toBe('Client\r\n"Smith, ""Jr.""\nExample"\r\n');
    markCase(SUITE, "tkt332 export: quotes, commas, and line breaks are escaped");
  });

  it("tkt332 export: the file name is dated like the tracker file", () => {
    expect(acatBookCsvFilename(new Date("2026-10-12T23:59:00.000Z"))).toBe("acat-records-2026-10-12.csv");
    expect(acatBookCsvFilename(new Date("2027-01-02T00:00:00.000Z"))).toBe("acat-records-2027-01-02.csv");
    markCase(SUITE, "tkt332 export: the file name is dated like the tracker file");
  });
});
