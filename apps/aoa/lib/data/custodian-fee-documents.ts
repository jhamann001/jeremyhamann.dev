import { createHash } from "node:crypto";

export const MAX_FEE_SCHEDULE_BYTES = 10 * 1024 * 1024;

export class FeeScheduleUploadError extends Error {
  constructor(message: string, public readonly status: 400 | 413 | 415) {
    super(message);
    this.name = "FeeScheduleUploadError";
  }
}

const supportedTypes = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
} as const;

export function safeFeeScheduleFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const safe = basename.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "");
  const extension = safe.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "";
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  return `${stem.slice(0, 150) || "fee-schedule"}${extension}`;
}

export function buildFeeScheduleDocument(input: {
  filename: string;
  contentType: string;
  content: Uint8Array;
}) {
  if (input.content.byteLength === 0) {
    throw new FeeScheduleUploadError("Choose a non-empty file", 400);
  }
  if (input.content.byteLength > MAX_FEE_SCHEDULE_BYTES) {
    throw new FeeScheduleUploadError("Fee schedules must be 10 MB or smaller", 413);
  }
  let contentType = input.contentType.toLowerCase().trim();
  const extension = input.filename.split(/[\\/]/).pop()?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  if (!contentType || contentType === "application/octet-stream") {
    contentType = Object.entries(supportedTypes)
      .find(([, extensions]) => (extensions as readonly string[]).includes(extension ?? ""))?.[0] ?? contentType;
  }
  if (
    !Object.hasOwn(supportedTypes, contentType) ||
    !extension ||
    !(supportedTypes[contentType as keyof typeof supportedTypes] as readonly string[]).includes(extension)
  ) {
    throw new FeeScheduleUploadError("Upload a PDF, PNG, or JPEG with a matching file type and extension", 415);
  }
  const content = Buffer.from(input.content);
  const matchesSignature = contentType === "application/pdf"
    ? content.subarray(0, 5).equals(Buffer.from("%PDF-"))
    : contentType === "image/png"
      ? content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (!matchesSignature) {
    throw new FeeScheduleUploadError("The file contents do not match its PDF, PNG, or JPEG type", 415);
  }
  return {
    filename: safeFeeScheduleFilename(input.filename),
    contentType,
    content,
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
