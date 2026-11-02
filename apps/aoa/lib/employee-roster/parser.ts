import "server-only";

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { readSheet, type CellValue, type SheetData } from "read-excel-file/node";

export const EMPLOYEE_ROSTER_PARSER_VERSION = "read-excel-file@9.3.10";
export const EMPLOYEE_ROSTER_MAX_BYTES = 1_000_000;
export const EMPLOYEE_ROSTER_MAX_ROWS = 10_000;
export const EMPLOYEE_ROSTER_MAX_ZIP_ENTRIES = 512;
export const EMPLOYEE_ROSTER_MAX_ENTRY_BYTES = 12_000_000;
export const EMPLOYEE_ROSTER_MAX_UNCOMPRESSED_BYTES = 50_000_000;
export const EMPLOYEE_ROSTER_MAX_COMPRESSION_RATIO = 200;

export const EMPLOYEE_ROSTER_HEADERS = [
  "Employee - ID",
  "Employee",
  "Employment status",
  "Start date",
  "Last day of work",
  "Dependent Name",
  "Legal entity name",
] as const;

export type EmployeeEmploymentStateValue = "ACTIVE" | "FORMER";

export type ParsedEmployeeRosterEntry = {
  employeeId: string;
  displayName: string;
  sourceStatus: string;
  employmentState: EmployeeEmploymentStateValue;
  startDate: string | null;
  lastDay: string | null;
  legalEntity: string | null;
  dependentRowCount: number;
};

export type ParsedEmployeeRoster = {
  fileSha256: string;
  rowCount: number;
  employeeCount: number;
  dependentRowCount: number;
  activeCount: number;
  formerCount: number;
  entries: ParsedEmployeeRosterEntry[];
};

export type EmployeeRosterParseErrorCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSAFE_ARCHIVE"
  | "INVALID_WORKBOOK"
  | "MISSING_HEADER"
  | "DUPLICATE_HEADER"
  | "TOO_MANY_ROWS"
  | "MISSING_EMPLOYEE_ID"
  | "MISSING_EMPLOYEE_NAME"
  | "UNSUPPORTED_STATUS"
  | "INVALID_DATE"
  | "FIELD_TOO_LONG"
  | "INCONSISTENT_DUPLICATE";

export class EmployeeRosterParseError extends Error {
  constructor(
    readonly code: EmployeeRosterParseErrorCode,
    readonly rows: readonly number[] = [],
  ) {
    super(code);
    this.name = "EmployeeRosterParseError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_DEFLATE_OPTION_FLAGS = 0x0006;

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

function inflateEntireZipEntry(bytes: Buffer, maxOutputLength: number): Buffer {
  const options = { maxOutputLength, info: true } as const;
  const result = (inflateRawSync as unknown as (
    input: Buffer,
    settings: typeof options,
  ) => { buffer: Buffer; engine: { bytesWritten: number } })(bytes, options);
  if (result.engine.bytesWritten !== bytes.length) unsafeArchive();
  return result.buffer;
}

function unsafeArchive(): never {
  throw new EmployeeRosterParseError("UNSAFE_ARCHIVE");
}

function decodeZipPath(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unsafeArchive();
  }
}

function isSafeXlsxPath(path: string, isDirectory: boolean): boolean {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")
      || /^[a-zA-Z]:/.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
    return false;
  }
  if (isDirectory) return /^(?:_rels|docProps|xl)(?:\/|$)/.test(path);
  if (path === "[Content_Types].xml") return true;
  if (!/^(?:_rels|docProps|xl)\//.test(path)) return false;
  return /\.(?:xml|rels|png|jpe?g|gif|emf|wmf)$/i.test(path);
}

/**
 * Validate the ZIP central directory before any XML decompression occurs.
 * Rippling exports are ordinary XLSX packages; ZIP64, encryption, executable
 * payloads, path traversal, special files, and unusually expansive archives
 * are rejected before read-excel-file sees the bytes.
 */
export function preflightEmployeeRosterArchive(buffer: Buffer): void {
  if (buffer.length < 22) unsafeArchive();
  const searchStart = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) unsafeArchive();

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralBytes = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentBytes = buffer.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentBytes !== buffer.length || disk !== 0 || centralDisk !== 0
      || entriesOnDisk !== entryCount || entryCount === 0
      || entryCount > EMPLOYEE_ROSTER_MAX_ZIP_ENTRIES
      || entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralBytes > eocd) unsafeArchive();

  let cursor = centralOffset;
  let declaredUncompressed = 0;
  let actualUncompressed = 0;
  let totalCompressed = 0;
  const paths = new Set<string>();
  const localOffsets = new Set<number>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let hasContentTypes = false;
  let hasWorkbook = false;
  let hasWorksheet = false;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      unsafeArchive();
    }
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const entryCommentBytes = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const recordBytes = 46 + nameBytes + extraBytes + entryCommentBytes;
    const allowedFlags = ZIP_UTF8_FLAG | (method === 8 ? ZIP_DEFLATE_OPTION_FLAGS : 0);
    if (nameBytes === 0 || cursor + recordBytes > eocd || startDisk !== 0
        || localOffset === 0xffffffff || localOffset + 30 > centralOffset
        || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE
        || (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0
        || (flags & ~allowedFlags) !== 0 || ![0, 8].includes(method)
        || compressed === 0xffffffff || uncompressed === 0xffffffff
        || uncompressed > EMPLOYEE_ROSTER_MAX_ENTRY_BYTES) unsafeArchive();

    const path = decodeZipPath(buffer.subarray(cursor + 46, cursor + 46 + nameBytes));
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressed = buffer.readUInt32LE(localOffset + 18);
    const localUncompressed = buffer.readUInt32LE(localOffset + 22);
    const localNameBytes = buffer.readUInt16LE(localOffset + 26);
    const localExtraBytes = buffer.readUInt16LE(localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameBytes + localExtraBytes;
    if (localOffsets.has(localOffset) || localHeaderEnd + compressed > centralOffset
        || localFlags !== flags || localMethod !== method
        || localCrc !== expectedCrc
        || localCompressed !== compressed || localUncompressed !== uncompressed
        || localNameBytes !== nameBytes
        || decodeZipPath(buffer.subarray(localOffset + 30, localOffset + 30 + localNameBytes)) !== path) {
      unsafeArchive();
    }
    localOffsets.add(localOffset);
    localRanges.push({ start: localOffset, end: localHeaderEnd + compressed });
    const isDirectory = path.endsWith("/");
    const creatorOs = madeBy >>> 8;
    const unixType = creatorOs === 3 ? ((externalAttributes >>> 16) & 0o170000) : 0;
    if ((method === 0 && compressed !== uncompressed)
        || (isDirectory && (compressed !== 0 || uncompressed !== 0))
        || (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000)
        || (unixType !== 0 && (unixType === 0o040000) !== isDirectory)
        || !isSafeXlsxPath(path, isDirectory) || paths.has(path)) unsafeArchive();
    paths.add(path);

    if (!isDirectory && uncompressed > 0) {
      if (compressed === 0 || uncompressed / compressed > EMPLOYEE_ROSTER_MAX_COMPRESSION_RATIO) {
        unsafeArchive();
      }
      declaredUncompressed += uncompressed;
      totalCompressed += compressed;
      if (declaredUncompressed > EMPLOYEE_ROSTER_MAX_UNCOMPRESSED_BYTES) unsafeArchive();
    }

    if (!isDirectory) {
      const compressedBytes = buffer.subarray(localHeaderEnd, localHeaderEnd + compressed);
      let inflated: Buffer;
      try {
        inflated = method === 0
          ? compressedBytes
          : inflateEntireZipEntry(
            compressedBytes,
            Math.min(
              EMPLOYEE_ROSTER_MAX_ENTRY_BYTES,
              EMPLOYEE_ROSTER_MAX_UNCOMPRESSED_BYTES - actualUncompressed,
            ) || 1,
          );
      } catch {
        unsafeArchive();
      }
      actualUncompressed += inflated.length;
      if (inflated.length !== uncompressed || crc32(inflated) !== expectedCrc
          || inflated.length > EMPLOYEE_ROSTER_MAX_ENTRY_BYTES
          || actualUncompressed > EMPLOYEE_ROSTER_MAX_UNCOMPRESSED_BYTES) {
        unsafeArchive();
      }
    }
    hasContentTypes ||= path === "[Content_Types].xml";
    hasWorkbook ||= path === "xl/workbook.xml";
    hasWorksheet ||= /^xl\/worksheets\/[^/]+\.xml$/i.test(path);
    cursor += recordBytes;
  }
  localRanges.sort((a, b) => a.start - b.start);
  if (localRanges[0]?.start !== 0
      || localRanges.at(-1)?.end !== centralOffset
      || localRanges.some((range, index) => index > 0
        && localRanges[index - 1]!.end !== range.start)) {
    unsafeArchive();
  }
  if (cursor !== centralOffset + centralBytes || cursor !== eocd
      || !hasContentTypes || !hasWorkbook || !hasWorksheet
      || (totalCompressed > 0
        && declaredUncompressed / totalCompressed > EMPLOYEE_ROSTER_MAX_COMPRESSION_RATIO)) {
    unsafeArchive();
  }
}

const cleanString = (value: CellValue | null): string =>
  value == null ? "" : String(value).replace(/\s+/g, " ").trim();

function isoDate(value: CellValue | null, row: number): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const parsed = new Date(`${normalized}T00:00:00.000Z`);
      if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === normalized) {
        return normalized;
      }
    }
  }
  throw new EmployeeRosterParseError("INVALID_DATE", [row]);
}

function employmentState(value: string, row: number): EmployeeEmploymentStateValue {
  const status = value.toLowerCase();
  if (status === "active") return "ACTIVE";
  if (status === "terminated") return "FORMER";
  throw new EmployeeRosterParseError("UNSUPPORTED_STATUS", [row]);
}

function assertLength(value: string, max: number, row: number) {
  if (value.length > max) throw new EmployeeRosterParseError("FIELD_TOO_LONG", [row]);
}

function sameEmployeeFields(
  a: ParsedEmployeeRosterEntry,
  b: ParsedEmployeeRosterEntry,
): boolean {
  return a.displayName === b.displayName
    && a.sourceStatus === b.sourceStatus
    && a.employmentState === b.employmentState
    && a.startDate === b.startDate
    && a.lastDay === b.lastDay
    && a.legalEntity === b.legalEntity;
}

/**
 * Parse the official Rippling monthly report into a deduplicated employee-only
 * snapshot. The Buffer is discarded by the caller after this function returns;
 * the dependent-name cell is used only as a boolean row counter and is never
 * copied into the returned value.
 */
export async function parseEmployeeRosterWorkbook(
  buffer: Buffer,
): Promise<ParsedEmployeeRoster> {
  if (buffer.length === 0) throw new EmployeeRosterParseError("EMPTY_FILE");
  if (buffer.length > EMPLOYEE_ROSTER_MAX_BYTES) {
    throw new EmployeeRosterParseError("FILE_TOO_LARGE");
  }
  preflightEmployeeRosterArchive(buffer);

  let sheet: SheetData;
  try {
    sheet = await readSheet(buffer);
  } catch {
    throw new EmployeeRosterParseError("INVALID_WORKBOOK");
  }
  if (sheet.length < 2) throw new EmployeeRosterParseError("INVALID_WORKBOOK");

  const headers = sheet[0]?.map(cleanString) ?? [];
  const indexByHeader = new Map<string, number>();
  for (const required of EMPLOYEE_ROSTER_HEADERS) {
    const matches = headers
      .map((header, index) => header === required ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length === 0) throw new EmployeeRosterParseError("MISSING_HEADER");
    if (matches.length > 1) throw new EmployeeRosterParseError("DUPLICATE_HEADER");
    indexByHeader.set(required, matches[0]!);
  }

  const dataRows = sheet.slice(1).filter((row) => row.some((cell) => cell != null && cell !== ""));
  if (dataRows.length > EMPLOYEE_ROSTER_MAX_ROWS) {
    throw new EmployeeRosterParseError("TOO_MANY_ROWS");
  }

  const at = (row: (CellValue | null)[], header: typeof EMPLOYEE_ROSTER_HEADERS[number]) =>
    row[indexByHeader.get(header)!] ?? null;
  const entries = new Map<string, ParsedEmployeeRosterEntry>();
  let dependentRowCount = 0;

  dataRows.forEach((row, rowIndex) => {
    const spreadsheetRow = rowIndex + 2;
    const employeeId = cleanString(at(row, "Employee - ID"));
    const displayName = cleanString(at(row, "Employee"));
    const sourceStatus = cleanString(at(row, "Employment status"));
    const legalEntityValue = cleanString(at(row, "Legal entity name"));
    const hasDependent = cleanString(at(row, "Dependent Name")).length > 0;

    if (!employeeId) throw new EmployeeRosterParseError("MISSING_EMPLOYEE_ID", [spreadsheetRow]);
    if (!displayName) throw new EmployeeRosterParseError("MISSING_EMPLOYEE_NAME", [spreadsheetRow]);
    assertLength(employeeId, 128, spreadsheetRow);
    assertLength(displayName, 240, spreadsheetRow);
    assertLength(sourceStatus, 64, spreadsheetRow);
    assertLength(legalEntityValue, 240, spreadsheetRow);

    const parsed: ParsedEmployeeRosterEntry = {
      employeeId,
      displayName,
      sourceStatus,
      employmentState: employmentState(sourceStatus, spreadsheetRow),
      startDate: isoDate(at(row, "Start date"), spreadsheetRow),
      lastDay: isoDate(at(row, "Last day of work"), spreadsheetRow),
      legalEntity: legalEntityValue || null,
      dependentRowCount: hasDependent ? 1 : 0,
    };

    const existing = entries.get(employeeId);
    if (existing) {
      if (!sameEmployeeFields(existing, parsed)) {
        throw new EmployeeRosterParseError("INCONSISTENT_DUPLICATE", [spreadsheetRow]);
      }
      existing.dependentRowCount += parsed.dependentRowCount;
    } else {
      entries.set(employeeId, parsed);
    }
    if (hasDependent) dependentRowCount += 1;
  });

  const rosterEntries = [...entries.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName) || a.employeeId.localeCompare(b.employeeId));
  const activeCount = rosterEntries.filter((row) => row.employmentState === "ACTIVE").length;
  const formerCount = rosterEntries.length - activeCount;

  return {
    fileSha256: createHash("sha256").update(buffer).digest("hex"),
    rowCount: dataRows.length,
    employeeCount: rosterEntries.length,
    dependentRowCount,
    activeCount,
    formerCount,
    entries: rosterEntries,
  };
}
