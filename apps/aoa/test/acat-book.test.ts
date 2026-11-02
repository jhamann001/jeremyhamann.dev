import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pill } from "@/components/ui/Pill";
import { acatOpsBookEnabled } from "@/lib/flags";
import { ACAT_BOOK_HUES } from "@/lib/data/acat-status-catalog";
import {
  ACAT_BOOK_COLUMNS,
  ACAT_BOOK_EMPTY_MATCH,
  ACAT_BOOK_LIST_QUERY,
  ACAT_BOOK_LOAD_FAILURE,
  ACAT_BOOK_REMOVED_QUERY,
  acatTrackingSurface,
  applyAcatBookFilter,
  bookGroup,
  mapAcatBookRow,
  parseAcatBookPrefs,
  resolveAcatBookStatus,
  type AcatBookRow,
} from "@/lib/data/acat-book";
import { markCase } from "./acat-book-flywheel";

const SUITE = "acat-book";

function bookRow(over: Partial<AcatBookRow> & { id: string }): AcatBookRow {
  return {
    acatTransferId: over.id,
    clientName: "Client",
    controlNumber: null,
    direction: "In",
    type: "Full",
    accountType: "Brokerage",
    status: "Submitted",
    transferringContra: "Fidelity",
    statementAmount: 1000,
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
  };
}

const ids = (rows: AcatBookRow[]) => rows.map((r) => r.id).sort();
const TERMINAL = ["Completed", "Rejected", "Purged", "Canceled", "Deferred"];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ACAT book flags", () => {
  it("is on when both the epic flag and the book flag are exactly 1", () => {
    vi.stubEnv("EPIC_ACAT_OPS_WORKSPACE_TKT290", "1");
    vi.stubEnv("SHOW_ACAT_OPS_BOOK_TKT293", "1");
    expect(acatOpsBookEnabled()).toBe(true);
    markCase(SUITE, "flag on");
  });

  it("is off when either variable is unset, empty, 0, or true", () => {
    for (const name of ["EPIC_ACAT_OPS_WORKSPACE_TKT290", "SHOW_ACAT_OPS_BOOK_TKT293"]) {
      const other = name === "EPIC_ACAT_OPS_WORKSPACE_TKT290" ? "SHOW_ACAT_OPS_BOOK_TKT293" : "EPIC_ACAT_OPS_WORKSPACE_TKT290";
      for (const value of [undefined, "", "0", "true"]) {
        vi.unstubAllEnvs();
        vi.stubEnv(other, "1");
        vi.stubEnv(name, value);
        expect(acatOpsBookEnabled(), `${name}=${String(value)}`).toBe(false);
      }
    }
    markCase(SUITE, "flag off");
  });

  it("keeps today's page when off and renders the book only on tracking when on", () => {
    expect(acatTrackingSurface(false, "tracking")).toBe("legacy");
    expect(acatTrackingSurface(false, "library")).toBe("legacy");
    expect(acatTrackingSurface(true, "tracking")).toBe("book");
    expect(acatTrackingSurface(true, "library")).toBe("library");
    markCase(SUITE, "page surface");
  });
});

describe("ACAT book filters", () => {
  it("Active drops the five terminal statuses and keeps Submitted", () => {
    const rows = [...TERMINAL.map((status) => bookRow({ id: status, status })), bookRow({ id: "s", status: "Submitted" })];
    expect(ids(applyAcatBookFilter(rows, "active", "", null))).toEqual(["s"]);
    markCase(SUITE, "active");
  });

  it("My Queue keeps a case-insensitive advisor match and drops others", () => {
    const rows = [bookRow({ id: "a", wealthAdvisor: "Willie Doe, CFP" }), bookRow({ id: "b", wealthAdvisor: "Alf Brekke" })];
    expect(ids(applyAcatBookFilter(rows, "mine", "", "willie doe"))).toEqual(["a"]);
    markCase(SUITE, "my queue match");
  });

  it("My Queue with a blank or null user name returns no rows", () => {
    const rows = [bookRow({ id: "a", wealthAdvisor: "Willie Doe" })];
    expect(applyAcatBookFilter(rows, "mine", "", null)).toEqual([]);
    expect(applyAcatBookFilter(rows, "mine", "", "   ")).toEqual([]);
    markCase(SUITE, "my queue blank user");
  });

  it("Issues keeps only rows with an issue", () => {
    const rows = [bookRow({ id: "a", hasIssue: true }), bookRow({ id: "b" })];
    expect(ids(applyAcatBookFilter(rows, "issues", "", null))).toEqual(["a"]);
    markCase(SUITE, "issues");
  });

  it("Fee to Submit keeps charged rows with no completed request", () => {
    const rows = [
      bookRow({ id: "yes", feeCharged: "Yes", type: "Partial" }),
      bookRow({ id: "fullOut", direction: "Out", type: "Full" }),
      bookRow({ id: "residual", feeCharged: "Yes", type: "Residual Credit" }),
      bookRow({ id: "rejected", feeCharged: "Yes", status: "Rejected" }),
      bookRow({ id: "done", feeCharged: "Yes", feeRequestCompleted: "2026-07-01" }),
    ];
    expect(ids(applyAcatBookFilter(rows, "fee", "", null))).toEqual(["fullOut", "yes"]);
    markCase(SUITE, "fee to submit");
  });

  it("Missing Trade Instructions keeps Full and Partial rows with blank instructions", () => {
    const rows = [
      bookRow({ id: "full", type: "Full", tradeInstructionsBlank: true }),
      bookRow({ id: "partial", type: "Partial", tradeInstructionsBlank: true }),
      bookRow({ id: "long", type: "Full account transfer", tradeInstructionsBlank: true }),
      bookRow({ id: "residual", type: "Residual Credit", tradeInstructionsBlank: true }),
      bookRow({ id: "canceled", type: "Full", status: "Canceled", tradeInstructionsBlank: true }),
    ];
    expect(ids(applyAcatBookFilter(rows, "instructions", "", null))).toEqual(["full", "partial"]);
    markCase(SUITE, "missing trade instructions");
  });

  it("search matches the masked account value the book shows", () => {
    const rows = [bookRow({ id: "a", apexAccountId: "****1111" }), bookRow({ id: "b", apexAccountId: "****2222" })];
    expect(ids(applyAcatBookFilter(rows, "all", " ****1111 ", null))).toEqual(["a"]);
    markCase(SUITE, "search masked account");
  });
});

describe("ACAT book statuses and groups", () => {
  it("places Waiting for Statement between Waiting on Client and ACAT Received", () => {
    expect(resolveAcatBookStatus("WaitingForStatement")).toMatchObject({ label: "Waiting for Statement", hue: "amber" });
    const labels = bookGroup([
      bookRow({ id: "r", status: "AcatReceived" }),
      bookRow({ id: "w", status: "WaitingForStatement" }),
      bookRow({ id: "c", status: "WaitingOnClient" }),
    ]).map((g) => g.label);
    expect(labels).toEqual(["Waiting on Client", "Waiting for Statement", "ACAT Received"]);
    markCase(SUITE, "waiting for statement");
  });

  it("shows an unknown status in its own readable group with the neutral hue", () => {
    expect(resolveAcatBookStatus("SomeNewStatus")).toMatchObject({ label: "Some New Status", hue: "unknown" });
    const groups = bookGroup([bookRow({ id: "n", status: "SomeNewStatus" }), bookRow({ id: "s", status: "Submitted" })]);
    expect(groups.find((g) => g.label === "Some New Status")).toMatchObject({ count: 1, hue: "unknown" });
    markCase(SUITE, "unknown status");
  });

  it("paints Completed green and Rejected red", () => {
    expect(resolveAcatBookStatus("Completed").hue).toBe("green");
    expect(resolveAcatBookStatus("Rejected").hue).toBe("red");
    markCase(SUITE, "completed and rejected hues");
  });

  it("collapses the five terminal groups by default and leaves Submitted open", () => {
    const groups = bookGroup([...TERMINAL.map((status) => bookRow({ id: status, status })), bookRow({ id: "s", status: "Submitted" })]);
    const collapsed = Object.fromEntries(groups.map((g) => [g.label, g.collapsedByDefault]));
    expect(collapsed).toEqual({ Submitted: false, Completed: true, Rejected: true, Purged: true, Canceled: true, Deferred: true });
    markCase(SUITE, "terminal groups collapsed");
  });

  it("reads book=full and keeps load failure distinct from an empty match", () => {
    expect(ACAT_BOOK_LIST_QUERY).toBe("book=full");
    expect(ACAT_BOOK_LOAD_FAILURE).toBe("Unable to load transfers — try again");
    expect(ACAT_BOOK_LOAD_FAILURE).not.toBe(ACAT_BOOK_EMPTY_MATCH);
    markCase(SUITE, "query and copy");
  });

  it("reads removed rows with their own query and keeps removedAt", () => {
    expect(ACAT_BOOK_REMOVED_QUERY).toBe("book=full&removed=only");
    expect(mapAcatBookRow({ id: "r", removedAt: "2026-09-02T00:00:00.000Z" })?.removedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(mapAcatBookRow({ id: "r" })?.removedAt).toBeNull();
    expect(mapAcatBookRow({ id: "r", removedAt: null })?.removedAt).toBeNull();
    markCase(SUITE, "removed-contract");
  });
});

describe("ACAT book hues and preferences", () => {
  it("leaves a Pill with no hue unchanged and tags a hued Pill", () => {
    const plain = renderToStaticMarkup(createElement(Pill, { tone: "green", children: "x" }));
    const hued = renderToStaticMarkup(createElement(Pill, { tone: "green", hue: "green", children: "x" }));
    expect(plain).toContain(">x</span>");
    expect(plain).not.toContain("data-hue");
    expect(hued).toContain('data-hue="green"');
    markCase(SUITE, "pill hue");
  });

  it("defines every book hue in both themes and in the Pill stylesheet", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    const pillCss = readFileSync("components/ui/Pill.module.css", "utf8");
    const block = (selector: string) => {
      const start = globals.indexOf(`${selector} {`);
      return globals.slice(start, globals.indexOf("}", start));
    };
    expect(ACAT_BOOK_HUES).toHaveLength(17);
    for (const theme of [block(":root"), block("html.dark")]) {
      for (const hue of ACAT_BOOK_HUES) {
        expect(theme).toMatch(new RegExp(`--acat-${hue}:#[0-9a-f]{6};`));
        expect(theme).toMatch(new RegExp(`--acat-${hue}-bg:#[0-9a-f]{6};`));
      }
    }
    for (const hue of ACAT_BOOK_HUES) expect(pillCss).toContain(`.hue_${hue} {`);
    markCase(SUITE, "hue tokens");
  });

  it("restores stored columns and density and falls back to all columns", () => {
    expect(parseAcatBookPrefs(JSON.stringify({ columns: ["status", "client", "bogus"], density: "compact" })))
      .toEqual({ columns: ["client", "status"], density: "compact" });
    expect(parseAcatBookPrefs(JSON.stringify({ columns: [] })))
      .toEqual({ columns: ACAT_BOOK_COLUMNS.map((c) => c.id), density: "comfortable" });
    markCase(SUITE, "view preferences");
  });
});
