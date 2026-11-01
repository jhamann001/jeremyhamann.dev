/**
 * Unit tests for the attachment object store.
 *
 * The GCS half is tested where it can be tested without a network: the CANONICAL REQUEST and the
 * STRING-TO-SIGN, against a fixed vector. Those two strings are the whole of V4 signing that this
 * repo owns — everything after them is an RSA signature produced by IAM. Nothing here talks to GCS.
 *
 * The filesystem half is exercised end to end against a temporary directory, including the traversal
 * refusals that make `<ticketId>/<attachmentId>` keys safe.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTACHMENT_URL_TTL_SECONDS,
  attachmentObjectKey,
  buildV4SigningInput,
  canonicalQueryString,
  canonicalRequest,
  contentDispositionAttachment,
  contentLengthRangeHeader,
  createFilesystemStore,
  credentialScope,
  encodeObjectPath,
  encodeRfc3986,
  gcsDateStamp,
  isValidObjectKey,
  LocalUploadClaims,
  localDownloadPath,
  localUploadPath,
  objectStore,
  sanitizeFilename,
  signLocalUploadToken,
  stringToSign,
  verifyLocalUploadToken,
} from "@/lib/storage";

// ---------------------------------------------------------------------------
// The fixed vector
// ---------------------------------------------------------------------------

const VECTOR = {
  bucket: "helpdesk-demo-attachments",
  ticketId: "ckticket0001",
  attachmentId: "ckattach0001",
  signerEmail: "service-account@example-project.iam.gserviceaccount.com",
  now: new Date("2026-09-19T12:00:00.000Z"),
  contentType: "application/pdf",
  maxBytes: 26_214_400,
  expires: 300,
} as const;

const EXPECTED_CANONICAL_REQUEST = [
  "PUT",
  "/helpdesk-demo-attachments/ckticket0001/ckattach0001",
  [
    "X-Goog-Algorithm=GOOG4-RSA-SHA256",
    "X-Goog-Credential=service-account%40example-project.iam.gserviceaccount.com%2F20260919%2Fauto%2Fstorage%2Fgoog4_request",
    "X-Goog-Date=20260919T120000Z",
    "X-Goog-Expires=300",
    "X-Goog-SignedHeaders=content-type%3Bhost%3Bx-goog-content-length-range",
  ].join("&"),
  "content-type:application/pdf",
  "host:storage.googleapis.com",
  "x-goog-content-length-range:0,26214400",
  "",
  "content-type;host;x-goog-content-length-range",
  "UNSIGNED-PAYLOAD",
].join("\n");

/** sha256 of EXPECTED_CANONICAL_REQUEST, computed once and pinned so a silent reshuffle is caught. */
const EXPECTED_CANONICAL_SHA256 = "e3acc302801b06231444049ab4b0c3c456eba3317188ba8a28afb9dc7e3894e5";

const EXPECTED_STRING_TO_SIGN = [
  "GOOG4-RSA-SHA256",
  "20260919T120000Z",
  "20260919/auto/storage/goog4_request",
  EXPECTED_CANONICAL_SHA256,
].join("\n");

describe("GCS V4 signing — known vector", () => {
  it("builds the canonical request exactly", () => {
    const input = buildV4SigningInput({
      method: "PUT",
      bucket: VECTOR.bucket,
      key: attachmentObjectKey(VECTOR.ticketId, VECTOR.attachmentId),
      signerEmail: VECTOR.signerEmail,
      now: VECTOR.now,
      expiresSeconds: VECTOR.expires,
      headers: {
        host: "storage.googleapis.com",
        "content-type": VECTOR.contentType,
        "x-goog-content-length-range": contentLengthRangeHeader(VECTOR.maxBytes),
      },
    });
    expect(input.canonical).toBe(EXPECTED_CANONICAL_REQUEST);
  });

  it("pins the canonical request digest", () => {
    expect(createHash("sha256").update(EXPECTED_CANONICAL_REQUEST, "utf8").digest("hex")).toBe(
      EXPECTED_CANONICAL_SHA256,
    );
  });

  it("builds the string-to-sign exactly", () => {
    const input = buildV4SigningInput({
      method: "PUT",
      bucket: VECTOR.bucket,
      key: attachmentObjectKey(VECTOR.ticketId, VECTOR.attachmentId),
      signerEmail: VECTOR.signerEmail,
      now: VECTOR.now,
      expiresSeconds: VECTOR.expires,
      headers: {
        host: "storage.googleapis.com",
        "content-type": VECTOR.contentType,
        "x-goog-content-length-range": contentLengthRangeHeader(VECTOR.maxBytes),
      },
    });
    expect(input.toSign).toBe(EXPECTED_STRING_TO_SIGN);
    expect(stringToSign("20260919T120000Z", credentialScope("20260919"), EXPECTED_CANONICAL_REQUEST)).toBe(
      EXPECTED_STRING_TO_SIGN,
    );
  });

  it("returns the unsigned URL with the query in canonical order", () => {
    const input = buildV4SigningInput({
      method: "PUT",
      bucket: VECTOR.bucket,
      key: attachmentObjectKey(VECTOR.ticketId, VECTOR.attachmentId),
      signerEmail: VECTOR.signerEmail,
      now: VECTOR.now,
      expiresSeconds: VECTOR.expires,
      headers: {
        host: "storage.googleapis.com",
        "content-type": VECTOR.contentType,
        "x-goog-content-length-range": contentLengthRangeHeader(VECTOR.maxBytes),
      },
    });
    expect(input.url).toBe(
      "https://storage.googleapis.com/helpdesk-demo-attachments/ckticket0001/ckattach0001?" +
        EXPECTED_CANONICAL_REQUEST.split("\n")[2],
    );
  });

  it("signs the download disposition into the GET query so bytes can never render inline", () => {
    const input = buildV4SigningInput({
      method: "GET",
      bucket: VECTOR.bucket,
      key: attachmentObjectKey(VECTOR.ticketId, VECTOR.attachmentId),
      signerEmail: VECTOR.signerEmail,
      now: VECTOR.now,
      expiresSeconds: VECTOR.expires,
      headers: { host: "storage.googleapis.com" },
      extraQuery: {
        "response-content-disposition": contentDispositionAttachment("statement.pdf"),
        "response-content-type": "application/pdf",
      },
    });
    expect(input.canonical.startsWith("GET\n")).toBe(true);
    expect(input.query["X-Goog-SignedHeaders"]).toBe("host");
    expect(input.canonical).toContain("response-content-disposition=attachment%3B%20filename%3D%22statement.pdf%22");
    expect(input.canonical).toContain("UNSIGNED-PAYLOAD");
  });

  it("orders and percent-encodes the canonical query", () => {
    expect(canonicalQueryString({ b: "2", a: "1 2", "c+d": "e/f" })).toBe("a=1%202&b=2&c%2Bd=e%2Ff");
  });

  it("encodes reserved characters RFC 3986 style", () => {
    expect(encodeRfc3986("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(encodeRfc3986("a@b/c")).toBe("a%40b%2Fc");
  });

  it("keeps the separators when encoding the resource path", () => {
    expect(encodeObjectPath("my-bucket", "tkt_1/att_1")).toBe("/my-bucket/tkt_1/att_1");
  });

  it("formats the X-Goog-Date stamp", () => {
    expect(gcsDateStamp(new Date("2026-01-02T03:04:05.678Z"))).toEqual({
      datetime: "20260102T030405Z",
      date: "20260102",
    });
  });

  it("lower-cases, trims and sorts the canonical headers", () => {
    const canonical = canonicalRequest({
      method: "PUT",
      resourcePath: "/b/k",
      query: {},
      headers: { "X-Custom": "  spaced  ", Host: "storage.googleapis.com", "Content-Type": "text/csv" },
    });
    expect(canonical).toBe(
      ["PUT", "/b/k", "", "content-type:text/csv\nhost:storage.googleapis.com\nx-custom:spaced\n", "content-type;host;x-custom", "UNSIGNED-PAYLOAD"].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Keys and filenames
// ---------------------------------------------------------------------------

describe("object keys", () => {
  it("derives <ticketId>/<attachmentId> and nothing else", () => {
    expect(attachmentObjectKey("tkt_abc", "att_def")).toBe("tkt_abc/att_def");
    expect(isValidObjectKey("tkt_abc/att_def")).toBe(true);
  });

  it("refuses ids that could become a path", () => {
    expect(() => attachmentObjectKey("../etc", "att")).toThrow(/invalid ticket id/);
    expect(() => attachmentObjectKey("tkt", "../../etc/passwd")).toThrow(/invalid attachment id/);
    expect(() => attachmentObjectKey("tkt/sub", "att")).toThrow(/invalid ticket id/);
    expect(() => attachmentObjectKey("", "att")).toThrow(/invalid ticket id/);
    expect(() => attachmentObjectKey("tkt", "a".repeat(65))).toThrow(/invalid attachment id/);
  });

  it("rejects keys with the wrong number of segments", () => {
    expect(isValidObjectKey("only-one")).toBe(false);
    expect(isValidObjectKey("a/b/c")).toBe(false);
    expect(isValidObjectKey("../a/b")).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("keeps only the base name, dropping every directory component", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\jeremy\\statement.pdf")).toBe("statement.pdf");
    expect(sanitizeFilename("/absolute/path/")).toBe("path");
    expect(sanitizeFilename("/")).toBe("attachment");
  });

  it("strips control characters and header-breaking punctuation", () => {
    expect(sanitizeFilename("state\u0000ment\n.pdf")).toBe("statement.pdf");
    expect(sanitizeFilename('say "hi"; now.csv')).toBe("say _hi__ now.csv");
  });

  it("strips leading dots so a name cannot become a dotfile", () => {
    expect(sanitizeFilename("...bashrc")).toBe("bashrc");
    expect(sanitizeFilename(".")).toBe("attachment");
  });

  it("falls back for an empty or all-stripped name", () => {
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("   ")).toBe("attachment");
    expect(sanitizeFilename("\u0001\u0002")).toBe("attachment");
  });

  it("caps the length while keeping the extension", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("always produces an attachment disposition, never inline", () => {
    const value = contentDispositionAttachment("voided check.png");
    expect(value.startsWith("attachment; ")).toBe(true);
    expect(value).toContain('filename="voided check.png"');
    expect(value).toContain("filename*=UTF-8''voided%20check.png");
    expect(value).not.toContain("inline");
  });
});

// ---------------------------------------------------------------------------
// Local upload tokens
// ---------------------------------------------------------------------------

describe("local upload tokens", () => {
  const claims: LocalUploadClaims = {
    key: "tkt_1/att_1",
    contentType: "image/png",
    maxBytes: 26_214_400,
    expiresAtEpoch: Math.floor(new Date("2026-09-19T12:05:00Z").getTime() / 1000),
  };

  it("verifies a token it just signed", () => {
    const token = signLocalUploadToken(claims);
    expect(verifyLocalUploadToken(claims, token, new Date("2026-09-19T12:00:00Z"))).toBe(true);
  });

  it("refuses a token whose claims were altered", () => {
    const token = signLocalUploadToken(claims);
    const tampered = { ...claims, maxBytes: 999_999_999 };
    expect(verifyLocalUploadToken(tampered, token, new Date("2026-09-19T12:00:00Z"))).toBe(false);
    expect(verifyLocalUploadToken({ ...claims, contentType: "text/html" }, token, new Date("2026-09-19T12:00:00Z"))).toBe(
      false,
    );
    expect(verifyLocalUploadToken({ ...claims, key: "tkt_1/att_2" }, token, new Date("2026-09-19T12:00:00Z"))).toBe(false);
  });

  it("refuses an expired token even when the signature is good", () => {
    const token = signLocalUploadToken(claims);
    expect(verifyLocalUploadToken(claims, token, new Date("2026-09-19T12:06:00Z"))).toBe(false);
  });

  it("refuses an empty or truncated token", () => {
    const token = signLocalUploadToken(claims);
    expect(verifyLocalUploadToken(claims, "", new Date("2026-09-19T12:00:00Z"))).toBe(false);
    expect(verifyLocalUploadToken(claims, token.slice(0, -1), new Date("2026-09-19T12:00:00Z"))).toBe(false);
  });

  it("points the upload and download URLs at the app's own audited routes", () => {
    const token = signLocalUploadToken(claims);
    expect(localUploadPath(claims.key, claims, token)).toContain("/api/attachments/att_1/upload?");
    expect(localDownloadPath(claims.key)).toBe("/api/attachments/att_1/download");
  });
});

// ---------------------------------------------------------------------------
// Filesystem backend
// ---------------------------------------------------------------------------

describe("filesystem backend", () => {
  const roots: string[] = [];

  async function store() {
    const root = await mkdtemp(join(tmpdir(), "wm-attachments-"));
    roots.push(root);
    return { root, store: createFilesystemStore(root) };
  }

  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("round-trips an object and reports a verifiable sha256", async () => {
    const { root, store: s } = await store();
    const body = new TextEncoder().encode("voided check bytes");
    const written = await s.put("tkt_1/att_1", body, "image/png");
    expect(written.size).toBe(body.byteLength);
    expect(written.sha256).toBe(createHash("sha256").update(body).digest("hex"));

    const head = await s.head("tkt_1/att_1");
    expect(head).toEqual({ exists: true, size: body.byteLength, sha256: written.sha256 });
    expect(new TextDecoder().decode(await s.get("tkt_1/att_1"))).toBe("voided check bytes");
    expect(await readFile(join(root, "tkt_1", "att_1"), "utf8")).toBe("voided check bytes");
  });

  it("reports a missing object rather than throwing on head", async () => {
    const { store: s } = await store();
    expect(await s.head("tkt_1/att_missing")).toEqual({ exists: false, size: 0, sha256: null });
  });

  it("throws a StorageError when reading a missing object", async () => {
    const { store: s } = await store();
    await expect(s.get("tkt_1/att_missing")).rejects.toThrow(/object not found/);
  });

  it("refuses every key that is not <id>/<id>", async () => {
    const { store: s } = await store();
    const body = new Uint8Array([1]);
    await expect(s.put("../escape", body, "text/plain")).rejects.toThrow(/invalid object key/);
    await expect(s.put("tkt_1/../../escape", body, "text/plain")).rejects.toThrow(/invalid object key/);
    await expect(s.get("/etc/passwd")).rejects.toThrow(/invalid object key/);
    await expect(s.head("tkt_1/att_1/extra")).rejects.toThrow(/invalid object key/);
    await expect(s.signedPutUrl("nope", { contentType: "text/csv", maxBytes: 1 })).rejects.toThrow(/invalid object key/);
    await expect(s.signedGetUrl("nope", { filename: "a.csv", contentType: "text/csv" })).rejects.toThrow(
      /invalid object key/,
    );
  });

  it("mints an expiring upload URL carrying the signed content type and cap", async () => {
    const { store: s } = await store();
    const before = Date.now();
    const signed = await s.signedPutUrl("tkt_1/att_1", { contentType: "application/pdf", maxBytes: 26_214_400 });
    expect(signed.url).toContain("/api/attachments/att_1/upload?");
    expect(signed.url).toContain("ct=application%2Fpdf");
    expect(signed.url).toContain("max=26214400");
    expect(signed.headers?.["Content-Type"]).toBe("application/pdf");
    expect(signed.headers?.["x-goog-content-length-range"]).toBe("0,26214400");
    const ttlMs = new Date(signed.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan((ATTACHMENT_URL_TTL_SECONDS - 5) * 1000);
    expect(ttlMs).toBeLessThanOrEqual((ATTACHMENT_URL_TTL_SECONDS + 1) * 1000);
  });

  it("hands readers the audited download route, with an attachment disposition", async () => {
    const { store: s } = await store();
    const signed = await s.signedGetUrl("tkt_1/att_1", { filename: "statement.pdf", contentType: "application/pdf" });
    expect(signed.url).toBe("/api/attachments/att_1/download");
    expect(signed.headers?.["Content-Disposition"]).toContain("attachment;");
  });
});

describe("objectStore factory", () => {
  it("chooses the filesystem backend when no bucket is configured", () => {
    expect(objectStore(undefined).backend).toBe("filesystem");
    expect(objectStore("").backend).toBe("filesystem");
    expect(objectStore("   ").backend).toBe("filesystem");
  });

  it("chooses GCS when a bucket is configured", () => {
    expect(objectStore("helpdesk-demo-attachments").backend).toBe("gcs");
  });
});
