/**
 * Pure unit tests for the download-filename stamp. The rule under test is "no character that a desktop
 * filesystem refuses or rewrites", which in practice means: no colon.
 */
import { describe, expect, it } from "vitest";
import { csvExportFilename, exportFileStamp } from "@/lib/export-filename";

/** Windows refuses these outright; Finder rewrites the first. */
const ILLEGAL = [":", "/", "\\", "?", "*", '"', "<", ">", "|"];

describe("exportFileStamp", () => {
  it("renders ISO 8601 basic format in UTC to the second", () => {
    expect(exportFileStamp(new Date("2026-09-20T00:26:13.120Z"))).toBe("20260920T002613Z");
    expect(exportFileStamp(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });

  it("is UTC regardless of the input's construction", () => {
    expect(exportFileStamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe("20261231T235959Z");
  });

  it("carries no character a filesystem refuses or rewrites", () => {
    const stamp = exportFileStamp(new Date("2026-09-20T00:26:13.120Z"));
    for (const ch of ILLEGAL) expect(stamp).not.toContain(ch);
  });

  it("still sorts chronologically as plain text", () => {
    const earlier = exportFileStamp(new Date("2026-09-20T00:26:13.120Z"));
    const later = exportFileStamp(new Date("2026-09-20T00:26:14.000Z"));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("csvExportFilename", () => {
  it("names a scoped ticket export", () => {
    expect(csvExportFilename("ticket-export", "standard", new Date("2026-09-20T00:26:13.120Z"))).toBe(
      "ticket-export-standard-20260920T002613Z.csv",
    );
  });

  it("omits the scope segment when there is none", () => {
    expect(csvExportFilename("audit-export", null, new Date("2026-09-20T00:26:13.120Z"))).toBe(
      "audit-export-20260920T002613Z.csv",
    );
  });

  it("never emits a character that would break the quoted Content-Disposition value", () => {
    const name = csvExportFilename('tick"et/export', "sco pe", new Date("2026-09-20T00:26:13.120Z"));
    for (const ch of ILLEGAL) expect(name).not.toContain(ch);
    expect(name).toBe("tick-et-export-sco-pe-20260920T002613Z.csv");
  });

  it("never collapses a segment to nothing", () => {
    expect(csvExportFilename("***", "!!!", new Date("2026-09-20T00:26:13.120Z"))).toBe("x-x-20260920T002613Z.csv");
  });
});
