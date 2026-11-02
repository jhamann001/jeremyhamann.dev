import { beforeEach, describe, expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";

const { readSheetSpy } = vi.hoisted(() => ({ readSheetSpy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("read-excel-file/node", () => ({ readSheet: readSheetSpy }));

import {
  EMPLOYEE_ROSTER_HEADERS,
  EMPLOYEE_ROSTER_MAX_ENTRY_BYTES,
  EMPLOYEE_ROSTER_MAX_BYTES,
  EMPLOYEE_ROSTER_MAX_ZIP_ENTRIES,
  EmployeeRosterParseError,
  parseEmployeeRosterWorkbook,
  preflightEmployeeRosterArchive,
} from "@/lib/employee-roster/parser";

type ZipEntry = {
  path: string;
  compressed?: number;
  uncompressed?: number;
  method?: 0 | 8;
  data?: Buffer;
  compressedPayload?: Buffer;
  flags?: number;
  crc?: number;
  localCrc?: number;
  localCompressed?: number;
  localUncompressed?: number;
  gapBefore?: number;
  externalAttributes?: number;
  creatorOs?: number;
};

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function archive(entries: ZipEntry[] = [
  { path: "[Content_Types].xml" },
  { path: "xl/workbook.xml" },
  { path: "xl/worksheets/sheet1.xml" },
]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const method = entry.method ?? 0;
    const payload = entry.compressedPayload ?? (entry.data == null
      ? Buffer.alloc(entry.compressed ?? 0)
      : method === 8 ? deflateRawSync(entry.data) : entry.data);
    const compressed = entry.compressed ?? payload.length;
    const uncompressed = entry.uncompressed ?? entry.data?.length ?? compressed;
    const expectedCrc = entry.crc ?? (entry.data == null ? 0 : crc32(entry.data));
    const gap = Buffer.alloc(entry.gapBefore ?? 0, 0xa5);
    localOffset += gap.length;
    locals.push(gap);
    const local = Buffer.alloc(30 + name.length + compressed);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.localCrc ?? expectedCrc, 14);
    local.writeUInt32LE(entry.localCompressed ?? compressed, 18);
    local.writeUInt32LE(entry.localUncompressed ?? uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    payload.subarray(0, compressed).copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.creatorOs ?? 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(expectedCrc, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

const header = [...EMPLOYEE_ROSTER_HEADERS];
const row = (
  id: string,
  name: string,
  status: string,
  dependent: string | null = null,
) => [
  id, name, status, new Date("2024-02-12T00:00:00.000Z"), null,
  dependent, "Cedar Ridge Wealth Corporation",
];

describe("Rippling employee roster parser", () => {
  beforeEach(() => readSheetSpy.mockReset());

  it("deduplicates by Employee ID, counts dependents, and never returns dependent names", async () => {
    readSheetSpy.mockResolvedValue([
      header,
      row("emp-1", "Alex Example", "Active"),
      row("emp-1", "Alex Example", "Active", "Dependent One"),
      row("emp-2", "Sam Example", "Terminated"),
    ]);
    const parsed = await parseEmployeeRosterWorkbook(archive());
    expect(parsed).toMatchObject({
      rowCount: 3, employeeCount: 2, dependentRowCount: 1,
      activeCount: 1, formerCount: 1,
    });
    expect(parsed.entries[0]).toMatchObject({
      employeeId: "emp-1", employmentState: "ACTIVE",
      startDate: "2024-02-12", dependentRowCount: 1,
    });
    expect(JSON.stringify(parsed)).not.toContain("Dependent One");
    expect(parsed.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects inconsistent employee fields across repeated employee rows", async () => {
    readSheetSpy.mockResolvedValue([
      header,
      row("emp-1", "Alex Example", "Active"),
      row("emp-1", "Different Name", "Active", "Dependent One"),
    ]);
    await expect(parseEmployeeRosterWorkbook(archive()))
      .rejects.toMatchObject({ code: "INCONSISTENT_DUPLICATE", rows: [3] });
  });

  it("requires the official columns and controlled status vocabulary", async () => {
    readSheetSpy.mockResolvedValueOnce([
      header.filter((value) => value !== "Employee - ID"),
      row("emp-1", "Alex Example", "Active"),
    ]);
    await expect(parseEmployeeRosterWorkbook(archive()))
      .rejects.toMatchObject({ code: "MISSING_HEADER" });

    readSheetSpy.mockResolvedValueOnce([
      header,
      row("emp-1", "Alex Example", "Leave of absence"),
    ]);
    await expect(parseEmployeeRosterWorkbook(archive()))
      .rejects.toMatchObject({ code: "UNSUPPORTED_STATUS", rows: [2] });
  });

  it("fails before parsing when the payload exceeds the server limit", async () => {
    await expect(parseEmployeeRosterWorkbook(Buffer.alloc(EMPLOYEE_ROSTER_MAX_BYTES + 1)))
      .rejects.toBeInstanceOf(EmployeeRosterParseError);
    expect(readSheetSpy).not.toHaveBeenCalled();
  });

  it("accepts fully covered deflate entries whose sizes and CRCs agree", () => {
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml", method: 8, data: Buffer.from("<Types/>") },
      { path: "xl/workbook.xml", method: 8, data: Buffer.from("<workbook/>") },
      {
        path: "xl/worksheets/sheet1.xml", method: 8,
        data: Buffer.from("<worksheet/>"),
      },
    ]))).not.toThrow();
  });

  it("rejects unsafe ZIP paths, payload types, and special files before parsing", () => {
    for (const unsafe of [
      { path: "../xl/worksheets/sheet1.xml" },
      { path: "xl/vbaProject.bin" },
      {
        path: "xl/worksheets/link.xml", creatorOs: 3,
        externalAttributes: 0o120000 * 65_536,
      },
    ]) {
      expect(() => preflightEmployeeRosterArchive(archive([
        { path: "[Content_Types].xml" },
        { path: "xl/workbook.xml" },
        { path: "xl/worksheets/sheet1.xml" },
        unsafe,
      ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
    }
  });

  it("caps ZIP entry count, expansion size, and compression ratio", () => {
    const tooMany = Array.from({ length: EMPLOYEE_ROSTER_MAX_ZIP_ENTRIES + 1 }, (_, index) => ({
      path: `xl/worksheets/sheet${index}.xml`,
    }));
    expect(() => preflightEmployeeRosterArchive(archive(tooMany)))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml" }, { path: "xl/workbook.xml" },
      {
        path: "xl/worksheets/sheet1.xml", method: 8, compressed: 100_000,
        uncompressed: EMPLOYEE_ROSTER_MAX_ENTRY_BYTES + 1,
      },
    ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml" }, { path: "xl/workbook.xml" },
      ...Array.from({ length: 5 }, (_, index) => ({
        path: `xl/worksheets/sheet${index}.xml`, method: 8 as const,
        compressed: 60_000, uncompressed: 11_000_000,
      })),
    ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml" }, { path: "xl/workbook.xml" },
      { path: "xl/worksheets/sheet1.xml", method: 8, compressed: 1, uncompressed: 1_000 },
    ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
  });

  it("rejects local-header metadata mismatches and data descriptors", () => {
    for (const sheet of [
      { path: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"), localCrc: 0 },
      {
        path: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"),
        localCompressed: 999,
      },
      {
        path: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"),
        localUncompressed: 999,
      },
      {
        path: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"), flags: 0x0008,
      },
    ]) {
      expect(() => preflightEmployeeRosterArchive(archive([
        { path: "[Content_Types].xml" }, { path: "xl/workbook.xml" }, sheet,
      ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
    }
  });

  it("rejects gaps between local records instead of allowing hidden archive bytes", () => {
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml" },
      { path: "xl/workbook.xml", gapBefore: 8 },
      { path: "xl/worksheets/sheet1.xml" },
    ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
  });

  it("rejects trailing bytes hidden inside a declared deflate payload", () => {
    const data = Buffer.from("<worksheet/>");
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml" }, { path: "xl/workbook.xml" },
      {
        path: "xl/worksheets/sheet1.xml", method: 8, data,
        compressedPayload: Buffer.concat([deflateRawSync(data), Buffer.from("hidden")]),
      },
    ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
  });

  it("caps actual inflation even when central and local sizes under-report it", () => {
    const oversized = Buffer.alloc(EMPLOYEE_ROSTER_MAX_ENTRY_BYTES + 1, 0x41);
    expect(() => preflightEmployeeRosterArchive(archive([
      { path: "[Content_Types].xml" }, { path: "xl/workbook.xml" },
      {
        path: "xl/worksheets/sheet1.xml", method: 8, data: oversized,
        uncompressed: 1_000_000,
      },
    ]))).toThrowError(expect.objectContaining({ code: "UNSAFE_ARCHIVE" }));
  });
});
