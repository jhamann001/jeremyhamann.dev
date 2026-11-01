import { createHash } from "node:crypto";

export const MAX_FEE_SCHEDULE_BYTES = 10 * 1024 * 1024;
// Bound the full received body as well as the file. Multipart framing and a
// filename need a little room beyond the supported file size.
export const MAX_FEE_SCHEDULE_REQUEST_BYTES = MAX_FEE_SCHEDULE_BYTES + 64 * 1024;

export const feeScheduleMetadataSelect = {
  id: true,
  filename: true,
  contentType: true,
  byteSize: true,
  createdAt: true,
  createdBy: true,
} as const;

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
  // Some browsers provide no MIME metadata for an otherwise supported file.
  // Infer only in that case, then require the matching signature below.
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

/** Read a bounded multipart upload before asking the platform to parse it. */
export async function readFeeScheduleUpload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw new FeeScheduleUploadError("Send a multipart file upload", 415);
  }
  const advertisedSize = request.headers.get("content-length");
  if (advertisedSize !== null) {
    if (!/^\d+$/.test(advertisedSize)) {
      throw new FeeScheduleUploadError("Invalid upload length", 400);
    }
    if (Number(advertisedSize) > MAX_FEE_SCHEDULE_REQUEST_BYTES) {
      throw new FeeScheduleUploadError("Fee schedules must be 10 MB or smaller", 413);
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new FeeScheduleUploadError("Choose a file to upload", 400);
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_FEE_SCHEDULE_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new FeeScheduleUploadError("Fee schedules must be 10 MB or smaller", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof FeeScheduleUploadError) throw error;
    throw new FeeScheduleUploadError("Could not read the upload", 400);
  } finally {
    reader.releaseLock();
  }

  let form: FormData;
  try {
    // This second buffer is bounded by MAX_FEE_SCHEDULE_REQUEST_BYTES.
    form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new FeeScheduleUploadError("Invalid multipart upload", 400);
  }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== "file" || typeof entries[0][1] === "string") {
    throw new FeeScheduleUploadError("Upload exactly one file in the file field", 400);
  }
  const file = entries[0][1];
  if (file.size > MAX_FEE_SCHEDULE_BYTES) {
    throw new FeeScheduleUploadError("Fee schedules must be 10 MB or smaller", 413);
  }
  return buildFeeScheduleDocument({
    filename: file.name,
    contentType: file.type,
    content: new Uint8Array(await file.arrayBuffer()),
  });
}

export type FeeScheduleIdentity = {
  id: string;
  byteSize: number;
  sha256: string;
};

export type FeeScheduleRetirementDecision =
  | { action: "clear"; ids: string[] }
  | {
      action: "refuse";
      reason:
        | "duplicate-id"
        | "unexpected-evidence-file"
        | "missing-stored-file"
        | "byte-count"
        | "checksum";
    };

export function decideFeeScheduleByteRetirement(
  stored: readonly FeeScheduleIdentity[],
  evidence: readonly FeeScheduleIdentity[],
): FeeScheduleRetirementDecision {
  const seenStored = new Set<string>();
  for (const row of stored) {
    if (seenStored.has(row.id)) return { action: "refuse", reason: "duplicate-id" };
    seenStored.add(row.id);
  }
  const seenEvidence = new Set<string>();
  const evidenceById = new Map<string, FeeScheduleIdentity>();
  for (const row of evidence) {
    if (seenEvidence.has(row.id)) return { action: "refuse", reason: "duplicate-id" };
    seenEvidence.add(row.id);
    evidenceById.set(row.id, row);
  }
  for (const row of evidence) {
    if (!seenStored.has(row.id)) return { action: "refuse", reason: "unexpected-evidence-file" };
  }
  for (const row of stored) {
    const match = evidenceById.get(row.id);
    if (!match) return { action: "refuse", reason: "missing-stored-file" };
    if (match.byteSize !== row.byteSize) return { action: "refuse", reason: "byte-count" };
    if (match.sha256 !== row.sha256) return { action: "refuse", reason: "checksum" };
  }
  return { action: "clear", ids: stored.map((row) => row.id) };
}
