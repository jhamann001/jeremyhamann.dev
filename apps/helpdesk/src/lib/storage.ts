/**
 * Object storage for attachments — node only, layer L2.
 *
 * Two backends behind ONE interface, chosen by whether `ATTACHMENTS_BUCKET` is set:
 *
 *  - `gcs`        — Google Cloud Storage. `@google-cloud/storage` is NOT installed and may not be
 *                   installed, and `google-auth-library` is not present either, so this module signs
 *                   V4 URLs itself: canonical request → string-to-sign → RSA signature from the IAM
 *                   `signBlob` REST endpoint, authenticated with the metadata server's access token.
 *                   The canonical-request construction is unit-tested against a fixed vector
 *                   (`storage.test.ts`); nothing here is tested against live GCS.
 *  - `filesystem` — local development. Objects live under `.local-attachments/<ticketId>/<attachmentId>`
 *                   (gitignored). The "signed" URLs point back at the app's own session-gated
 *                   attachment routes, because on a laptop there is no third party to sign for: the
 *                   PUT URL carries an HMAC-ed, expiring token that `/api/attachments/[id]/upload`
 *                   verifies IN ADDITION to the session and the RBAC check, and the GET URL is the
 *                   audited download route itself.
 *
 * Object keys are ALWAYS `<ticketId>/<attachmentId>` — derived, never the uploaded filename, so a
 * filename can never become a path (the DB CHECK `attachment_object_key_shape` pins the same shape).
 * Every filesystem operation re-validates the key against that shape before it touches the disk, so
 * path traversal is impossible even if a caller hands over a hostile key.
 *
 * TWO KEY GRAMMARS, chosen when the store is constructed (`objectStore(bucket, { keys })`):
 *
 *  - `"attachment"` (the default, and what `attachmentStore()` builds) — exactly `<id>/<id>`, the shape
 *    above and the shape the DB CHECK pins. Nothing about it changed.
 *  - `"document"` — server-written job output, which is NOT an attachment: the nightly books-and-records
 *    duplicate copy keys its files by UTC date, `2026/09/19/audit-chain.csv`. That key has four segments
 *    and an extension, so the attachment grammar refuses it and the job could never write a byte. A
 *    document key is 1-8 segments of `[A-Za-z0-9._-]`, each of which must START with a character other
 *    than a dot and must not end in one — so `..`, `.`, an empty segment, a leading `/` and a trailing
 *    `/` are all still refused, and path traversal is still impossible. A document store mints no signed
 *    URLs: those URL shapes are attachment-specific (the filesystem one points at
 *    `/api/attachments/<attachmentId>/…`), so asking for one is a programming error, not a runtime state.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "@/lib/env";
import { GcpMetadataError, fetchAccessToken, fetchServiceAccountEmail } from "@/lib/gcp-metadata";
import { safeEqualStrings } from "@/lib/safe-equal";

// ---------------------------------------------------------------------------
// Public types (CONTRACT §7.2 — S5's duplicate-copy job codes against exactly this)
// ---------------------------------------------------------------------------

export type SignedUrl = { url: string; expiresAt: string; headers?: Record<string, string> };

export type ObjectHead = { exists: boolean; size: number; sha256: string | null };

export interface ObjectStore {
  readonly backend: "gcs" | "filesystem";
  /** Upload URL the browser PUTs to. `contentType` and `maxBytes` are signed in, not advisory. */
  signedPutUrl(key: string, opts: { contentType: string; maxBytes: number; ttlSeconds?: number }): Promise<SignedUrl>;
  /** Download URL. `filename` sets Content-Disposition: attachment; never inline. */
  signedGetUrl(key: string, opts: { filename: string; contentType: string; ttlSeconds?: number }): Promise<SignedUrl>;
  head(key: string): Promise<ObjectHead>;
  /** Server-side write (email parts, job output). Returns the verified size and sha256. */
  put(key: string, body: Uint8Array, contentType: string): Promise<{ size: number; sha256: string }>;
  get(key: string): Promise<Uint8Array>;
}

/** How long a minted upload or download URL stays valid. Short on purpose: these URLs are bearer tokens. */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/** Directory the filesystem backend writes under, relative to the process working directory. */
export const LOCAL_ATTACHMENTS_DIR = ".local-attachments";

/** Where a `"document"` store writes locally — job output, kept apart from real uploaded attachments. */
export const LOCAL_DOCUMENTS_DIR = ".local-object-copies";

/** Which key grammar a store enforces. `"attachment"` is the default everywhere it is not stated. */
export type ObjectKeyKind = "attachment" | "document";

/** The id shape both halves of an object key must have — identical to the DB CHECK. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_KEY = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;

/**
 * One segment of a document key: dots are allowed INSIDE it (a file extension, a date), never at the
 * start — which is what keeps `.`, `..` and dotfiles out without a second traversal check.
 */
const DOCUMENT_KEY_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/** `YYYY/MM/DD/<name>` needs four; eight leaves room without letting a key become an arbitrary tree. */
const DOCUMENT_KEY_MAX_SEGMENTS = 8;

/** Longest display filename kept; the extension is preserved when the name has to be cut. */
const FILENAME_MAX_CHARS = 180;
const FALLBACK_FILENAME = "attachment";

export class StorageError extends Error {
  readonly backend: "gcs" | "filesystem";
  constructor(backend: "gcs" | "filesystem", message: string) {
    super(message);
    this.name = "StorageError";
    this.backend = backend;
  }
}

// ---------------------------------------------------------------------------
// Keys and filenames
// ---------------------------------------------------------------------------

/** ALWAYS `<ticketId>/<attachmentId>` — derived, never the uploaded filename. Throws on a bad id. */
export function attachmentObjectKey(ticketId: string, attachmentId: string): string {
  if (!KEY_SEGMENT.test(ticketId)) throw new StorageError("filesystem", "invalid ticket id for an object key");
  if (!KEY_SEGMENT.test(attachmentId)) throw new StorageError("filesystem", "invalid attachment id for an object key");
  return `${ticketId}/${attachmentId}`;
}

/**
 * True for a server-written job-output key: 1-8 `/`-separated segments of `[A-Za-z0-9._-]`, none of
 * which may start or end with a dot. `2026/09/19/audit-chain.csv` passes; `../a`, `a/../b`, `a//b`,
 * `/a`, `a/` and `.hidden` do not, so the key can still never climb out of the bucket or the root.
 */
export function isValidDocumentKey(key: string): boolean {
  const segments = String(key ?? "").split("/");
  if (segments.length > DOCUMENT_KEY_MAX_SEGMENTS) return false;
  return segments.every((segment) => DOCUMENT_KEY_SEGMENT.test(segment) && !segment.endsWith("."));
}

/** True for a key this module will act on, in the given grammar. Everything else is refused before any I/O. */
export function isValidObjectKey(key: string, kind: ObjectKeyKind = "attachment"): boolean {
  return kind === "document" ? isValidDocumentKey(key) : OBJECT_KEY.test(key);
}

function assertKey(backend: "gcs" | "filesystem", key: string, kind: ObjectKeyKind): void {
  if (!isValidObjectKey(key, kind)) throw new StorageError(backend, "invalid object key");
}

/**
 * Signed URLs are attachment-only: the GCS ones commit to an attachment's content type and size cap, and
 * the filesystem ones address `/api/attachments/<attachmentId>/…`. A document store has no such route, so
 * a caller asking for one has made a mistake and is told so rather than handed a URL that cannot work.
 */
function assertSignable(backend: "gcs" | "filesystem", kind: ObjectKeyKind): void {
  if (kind === "document") throw new StorageError(backend, "signed urls are minted for attachment keys only");
}

/**
 * Display name only — it never reaches a path or an object key. Drops every directory component (a
 * browser sends the base name anyway, and anything else is someone probing), NUL and every other
 * control character, the quote and semicolon that would break a Content-Disposition header, and
 * leading dots (so a name cannot masquerade as a dotfile); collapses whitespace; caps the length
 * while keeping a short extension. An empty result becomes "attachment".
 */
export function sanitizeFilename(raw: string): string {
  // NUL, CR, LF and friends are the target here: a header-bound name must not carry them.
  const withoutControls = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  const segments = withoutControls.split(/[/\\]+/).filter((s) => s.trim() !== "");
  const base = segments.length === 0 ? "" : segments[segments.length - 1];
  const stripped = base
    .replace(/["';]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (stripped === "") return FALLBACK_FILENAME;
  if (stripped.length <= FILENAME_MAX_CHARS) return stripped;

  const dot = stripped.lastIndexOf(".");
  const ext = dot > 0 && stripped.length - dot <= 12 ? stripped.slice(dot) : "";
  const stem = stripped.slice(0, FILENAME_MAX_CHARS - ext.length).trim();
  const out = `${stem}${ext}`;
  return out === "" || out === ext ? FALLBACK_FILENAME : out;
}

/**
 * `Content-Disposition: attachment` value for a sanitized filename. Always `attachment`, never
 * `inline`: an HTML or SVG attachment rendered inline would run in the desk's origin.
 */
export function contentDispositionAttachment(filename: string): string {
  const safe = sanitizeFilename(filename);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeRfc3986(safe)}`;
}

// ---------------------------------------------------------------------------
// GCS V4 signing primitives (exported for the unit test's known vector)
// ---------------------------------------------------------------------------

export const GCS_HOST = "storage.googleapis.com";
export const GCS_SIGNING_ALGORITHM = "GOOG4-RSA-SHA256";
const GCS_REQUEST_TYPE = "goog4_request";
const GCS_LOCATION = "auto";
const GCS_SERVICE = "storage";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const IAM_SIGN_BLOB_URL = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";

/** RFC 3986: `encodeURIComponent` plus the four characters it leaves alone. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Percent-encodes each path segment but keeps the separators — the canonical resource path. */
export function encodeObjectPath(bucket: string, key: string): string {
  const segments = [bucket, ...key.split("/")];
  return `/${segments.map(encodeRfc3986).join("/")}`;
}

/** `YYYYMMDD'T'HHMMSS'Z'` — the X-Goog-Date format. */
export function gcsDateStamp(now: Date): { datetime: string; date: string } {
  const datetime = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { datetime, date: datetime.slice(0, 8) };
}

/** Sorted by key, both halves RFC 3986 encoded, joined with `&`. */
export function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join("&");
}

/**
 * The V4 canonical request. Header names are lower-cased and sorted; values are trimmed; the payload
 * line is the literal `UNSIGNED-PAYLOAD` because a signed URL commits to no body hash.
 */
export function canonicalRequest(input: {
  method: string;
  resourcePath: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}): string {
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lowered = new Map(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lowered.get(n) ?? ""}\n`).join("");
  return [
    input.method,
    input.resourcePath,
    canonicalQueryString(input.query),
    canonicalHeaders,
    names.join(";"),
    UNSIGNED_PAYLOAD,
  ].join("\n");
}

/** `GOOG4-RSA-SHA256 \n <datetime> \n <credentialScope> \n <sha256hex(canonicalRequest)>`. */
export function stringToSign(datetime: string, credentialScope: string, canonical: string): string {
  return [
    GCS_SIGNING_ALGORITHM,
    datetime,
    credentialScope,
    createHash("sha256").update(canonical, "utf8").digest("hex"),
  ].join("\n");
}

export function credentialScope(date: string): string {
  return `${date}/${GCS_LOCATION}/${GCS_SERVICE}/${GCS_REQUEST_TYPE}`;
}

/** Everything about a V4 URL except the signature — the part that must be reproducible in a test. */
export function buildV4SigningInput(input: {
  method: "GET" | "PUT";
  bucket: string;
  key: string;
  signerEmail: string;
  now: Date;
  expiresSeconds: number;
  headers: Record<string, string>;
  extraQuery?: Record<string, string>;
}): { url: string; canonical: string; toSign: string; query: Record<string, string>; datetime: string } {
  const { datetime, date } = gcsDateStamp(input.now);
  const scope = credentialScope(date);
  const signedHeaderNames = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(";");
  const query: Record<string, string> = {
    ...(input.extraQuery ?? {}),
    "X-Goog-Algorithm": GCS_SIGNING_ALGORITHM,
    "X-Goog-Credential": `${input.signerEmail}/${scope}`,
    "X-Goog-Date": datetime,
    "X-Goog-Expires": String(input.expiresSeconds),
    "X-Goog-SignedHeaders": signedHeaderNames,
  };
  const resourcePath = encodeObjectPath(input.bucket, input.key);
  const canonical = canonicalRequest({
    method: input.method,
    resourcePath,
    query,
    headers: input.headers,
  });
  return {
    url: `https://${GCS_HOST}${resourcePath}?${canonicalQueryString(query)}`,
    canonical,
    toSign: stringToSign(datetime, scope, canonical),
    query,
    datetime,
  };
}

// ---------------------------------------------------------------------------
// Metadata-server credentials
// ---------------------------------------------------------------------------

type CachedToken = { token: string; expiresAtMs: number };
let tokenCache: CachedToken | null = null;
let signerEmailCache: string | null = null;

/** Re-fetch a minute before expiry so a long signing call never runs off the end of the token. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Wraps a `GcpMetadataError` in the `StorageError` the rest of this module throws, keeping the message
 * shapes the GCS backend's callers already match on. The metadata module's message never carries the
 * response body — on that endpoint the body IS the credential — so nothing sensitive is copied here.
 */
function asStorageError(e: unknown): StorageError {
  if (!(e instanceof GcpMetadataError)) return new StorageError("gcs", "metadata server call failed");
  if (e.status !== null) return new StorageError("gcs", `metadata server responded ${e.status}`);
  const detail = e.reason === "unreachable" ? "unreachable" : "returned a malformed response";
  return new StorageError("gcs", `metadata server ${detail}`);
}

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + TOKEN_SKEW_MS) return tokenCache.token;
  // The metadata protocol lives in `@/lib/gcp-metadata` — the ONE file in the tree that holds an
  // `http://` literal and the one file `.wiz` exempts from CWE-319. That module is stateless on
  // purpose, so the cache and the 60s skew below stay here where their reset hook already is.
  let fetched;
  try {
    fetched = await fetchAccessToken();
  } catch (e) {
    throw asStorageError(e);
  }
  const ttl = fetched.expiresInSeconds > 0 ? fetched.expiresInSeconds : 600;
  tokenCache = { token: fetched.token, expiresAtMs: now + ttl * 1000 };
  return tokenCache.token;
}

/** `ATTACHMENTS_SIGNER_EMAIL` when set, else the metadata server's own identity (correct on Cloud Run). */
async function signerEmail(): Promise<string> {
  if (env.ATTACHMENTS_SIGNER_EMAIL) return env.ATTACHMENTS_SIGNER_EMAIL;
  if (signerEmailCache) return signerEmailCache;
  let email: string;
  try {
    email = await fetchServiceAccountEmail();
  } catch (e) {
    throw asStorageError(e);
  }
  signerEmailCache = email;
  return email;
}

/**
 * RSA-SHA256 over `toSign`, performed by IAM for the service account (the private key never leaves
 * Google). The runtime identity needs `roles/iam.serviceAccountTokenCreator` on the signer — on
 * itself, when the signer is the runtime identity (infra/terraform-dev/attachments.tf grants it).
 */
async function signBlobHex(email: string, toSign: string): Promise<string> {
  const token = await accessToken();
  const res = await fetch(`${IAM_SIGN_BLOB_URL}/${encodeURIComponent(email)}:signBlob`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ payload: Buffer.from(toSign, "utf8").toString("base64") }),
    cache: "no-store",
  });
  if (!res.ok) throw new StorageError("gcs", `signBlob responded ${res.status}`);
  const body = (await res.json()) as { signedBlob?: unknown };
  if (typeof body.signedBlob !== "string" || body.signedBlob === "") {
    throw new StorageError("gcs", "signBlob returned no signature");
  }
  return Buffer.from(body.signedBlob, "base64").toString("hex");
}

/** Test seam: drops the cached token and signer identity. */
export function resetGcsCredentialCacheForTests(): void {
  tokenCache = null;
  signerEmailCache = null;
}

// ---------------------------------------------------------------------------
// GCS backend
// ---------------------------------------------------------------------------

/** Upper bound a signed PUT commits to, sent by the uploader as `x-goog-content-length-range`. */
export function contentLengthRangeHeader(maxBytes: number): string {
  return `0,${maxBytes}`;
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function createGcsStore(bucket: string, keys: ObjectKeyKind): ObjectStore {
  const jsonApi = `https://${GCS_HOST}/storage/v1/b/${encodeRfc3986(bucket)}/o`;
  const uploadApi = `https://${GCS_HOST}/upload/storage/v1/b/${encodeRfc3986(bucket)}/o`;

  async function authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await accessToken()}` };
  }

  return {
    backend: "gcs",

    async signedPutUrl(key, opts) {
      assertSignable("gcs", keys);
      assertKey("gcs", key, keys);
      const ttl = opts.ttlSeconds ?? ATTACHMENT_URL_TTL_SECONDS;
      const now = new Date();
      const range = contentLengthRangeHeader(opts.maxBytes);
      // Both headers are SIGNED, so the object cannot be stored with a different content type and a
      // body outside the range is rejected by GCS rather than by us after the fact.
      const headers = { host: GCS_HOST, "content-type": opts.contentType, "x-goog-content-length-range": range };
      const email = await signerEmail();
      const input = buildV4SigningInput({
        method: "PUT",
        bucket,
        key,
        signerEmail: email,
        now,
        expiresSeconds: ttl,
        headers,
      });
      const signature = await signBlobHex(email, input.toSign);
      return {
        url: `${input.url}&X-Goog-Signature=${signature}`,
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
        headers: { "Content-Type": opts.contentType, "x-goog-content-length-range": range },
      };
    },

    async signedGetUrl(key, opts) {
      assertSignable("gcs", keys);
      assertKey("gcs", key, keys);
      const ttl = opts.ttlSeconds ?? ATTACHMENT_URL_TTL_SECONDS;
      const now = new Date();
      const email = await signerEmail();
      const input = buildV4SigningInput({
        method: "GET",
        bucket,
        key,
        signerEmail: email,
        now,
        expiresSeconds: ttl,
        headers: { host: GCS_HOST },
        // Signed into the URL, so the browser cannot be talked into rendering the object inline.
        extraQuery: {
          "response-content-disposition": contentDispositionAttachment(opts.filename),
          "response-content-type": opts.contentType,
        },
      });
      const signature = await signBlobHex(email, input.toSign);
      return {
        url: `${input.url}&X-Goog-Signature=${signature}`,
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      };
    },

    async head(key) {
      assertKey("gcs", key, keys);
      const res = await fetch(`${jsonApi}/${encodeRfc3986(key)}`, {
        headers: await authHeaders(),
        cache: "no-store",
      });
      if (res.status === 404) return { exists: false, size: 0, sha256: null };
      if (!res.ok) throw new StorageError("gcs", `object metadata responded ${res.status}`);
      const body = (await res.json()) as { size?: unknown };
      const size = typeof body.size === "string" ? Number.parseInt(body.size, 10) : Number(body.size ?? Number.NaN);
      if (!Number.isFinite(size)) throw new StorageError("gcs", "object metadata carried no size");
      // GCS publishes md5/crc32c, never sha256 — so the digest is unverifiable here and the caller is
      // told so rather than being handed a value that looks server-verified (see finalizeUpload).
      return { exists: true, size, sha256: null };
    },

    async put(key, body, contentType) {
      assertKey("gcs", key, keys);
      const res = await fetch(`${uploadApi}?uploadType=media&name=${encodeRfc3986(key)}`, {
        method: "POST",
        headers: { ...(await authHeaders()), "content-type": contentType },
        body: Buffer.from(body),
        cache: "no-store",
      });
      if (!res.ok) throw new StorageError("gcs", `upload responded ${res.status}`);
      return { size: body.byteLength, sha256: sha256Hex(body) };
    },

    async get(key) {
      assertKey("gcs", key, keys);
      const res = await fetch(`${jsonApi}/${encodeRfc3986(key)}?alt=media`, {
        headers: await authHeaders(),
        cache: "no-store",
      });
      if (!res.ok) throw new StorageError("gcs", `object read responded ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem backend (local development)
// ---------------------------------------------------------------------------

/**
 * HMAC key for local upload tokens. `AUTH_SECRET` when the developer has one (stable across restarts),
 * otherwise a per-process random key: a dev-server restart then invalidates upload URLs that were
 * already minted, and the uploader simply asks for a new intent.
 */
let localSecret: Buffer | null = null;
function localUploadSecret(): Buffer {
  if (localSecret) return localSecret;
  localSecret = env.AUTH_SECRET ? Buffer.from(env.AUTH_SECRET, "utf8") : randomBytes(32);
  return localSecret;
}

export type LocalUploadClaims = { key: string; contentType: string; maxBytes: number; expiresAtEpoch: number };

export function signLocalUploadToken(claims: LocalUploadClaims): string {
  const payload = `${claims.key}|${claims.contentType}|${claims.maxBytes}|${claims.expiresAtEpoch}`;
  return createHmac("sha256", localUploadSecret()).update(payload, "utf8").digest("base64url");
}

/**
 * Constant-time verification, then the expiry. Both halves must pass.
 *
 * `safeEqualStrings` rather than a local `timingSafeEqual`: the explicit `expected.length !== given.length`
 * short-circuit this used to carry was itself the timing oracle CWE-208 is about — it answered "wrong
 * length" faster than "wrong bytes". The shared helper hashes both sides to a fixed 32 bytes first, so
 * a length mismatch costs exactly what a content mismatch costs.
 */
export function verifyLocalUploadToken(claims: LocalUploadClaims, token: string, now: Date = new Date()): boolean {
  if (!safeEqualStrings(signLocalUploadToken(claims), String(token ?? ""))) return false;
  return claims.expiresAtEpoch * 1000 > now.getTime();
}

/** The app-relative URL the filesystem backend hands the uploader; verified by the upload route. */
export function localUploadPath(key: string, claims: LocalUploadClaims, token: string): string {
  const attachmentId = key.split("/")[1];
  const params = new URLSearchParams({
    ct: claims.contentType,
    max: String(claims.maxBytes),
    exp: String(claims.expiresAtEpoch),
    sig: token,
  });
  return `/api/attachments/${encodeRfc3986(attachmentId)}/upload?${params.toString()}`;
}

/** The app-relative URL the filesystem backend hands a reader: the audited download route itself. */
export function localDownloadPath(key: string): string {
  return `/api/attachments/${encodeRfc3986(key.split("/")[1])}/download`;
}

/** Exported for tests, which point it at a temporary directory instead of the working directory. */
export function createFilesystemStore(root: string, keys: ObjectKeyKind = "attachment"): ObjectStore {
  const base = resolve(root);

  function pathFor(key: string): string {
    assertKey("filesystem", key, keys);
    const full = resolve(join(base, key));
    // Belt and braces: the key shape already forbids "..", and this refuses anything that still
    // resolved outside the root (a symlinked root, an odd platform separator).
    if (full !== base && !full.startsWith(base + sep)) throw new StorageError("filesystem", "object key escaped the root");
    return full;
  }

  return {
    backend: "filesystem",

    async signedPutUrl(key, opts) {
      assertSignable("filesystem", keys);
      assertKey("filesystem", key, keys);
      const ttl = opts.ttlSeconds ?? ATTACHMENT_URL_TTL_SECONDS;
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + ttl;
      const claims: LocalUploadClaims = {
        key,
        contentType: opts.contentType,
        maxBytes: opts.maxBytes,
        expiresAtEpoch,
      };
      return {
        url: localUploadPath(key, claims, signLocalUploadToken(claims)),
        expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
        headers: {
          "Content-Type": opts.contentType,
          "x-goog-content-length-range": contentLengthRangeHeader(opts.maxBytes),
        },
      };
    },

    async signedGetUrl(key, opts) {
      assertSignable("filesystem", keys);
      assertKey("filesystem", key, keys);
      const ttl = opts.ttlSeconds ?? ATTACHMENT_URL_TTL_SECONDS;
      // There is no third party to sign for locally: the only way to the bytes is the session-gated,
      // audited download route, which streams them itself.
      return {
        url: localDownloadPath(key),
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        headers: {
          "Content-Disposition": contentDispositionAttachment(opts.filename),
          "Content-Type": opts.contentType,
        },
      };
    },

    async head(key) {
      const full = pathFor(key);
      try {
        const s = await stat(full);
        if (!s.isFile()) return { exists: false, size: 0, sha256: null };
        // Local objects ARE verifiable: read the bytes back and digest them, so finalizeUpload can
        // prove the client's sha256 rather than record a claim.
        const body = await readFile(full);
        return { exists: true, size: s.size, sha256: sha256Hex(body) };
      } catch {
        return { exists: false, size: 0, sha256: null };
      }
    },

    async put(key, body, _contentType) {
      void _contentType;
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
      return { size: body.byteLength, sha256: sha256Hex(body) };
    },

    async get(key) {
      const full = pathFor(key);
      try {
        return new Uint8Array(await readFile(full));
      } catch {
        throw new StorageError("filesystem", "object not found");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * `bucket` unset ⇒ the filesystem backend, under `.local-attachments/` for an attachment store and
 * `.local-object-copies/` for a document store (both gitignored).
 *
 * `opts.keys` picks the key grammar and defaults to `"attachment"`, so every existing caller — and the
 * signature the contract publishes, `objectStore(bucket?: string)` — is unchanged. Job output passes
 * `{ keys: "document" }` (see `src/jobs/object-store.ts`).
 */
export function objectStore(bucket?: string, opts?: { keys?: ObjectKeyKind }): ObjectStore {
  const keys = opts?.keys ?? "attachment";
  const name = (bucket ?? "").trim();
  if (name === "") {
    const dir = keys === "document" ? LOCAL_DOCUMENTS_DIR : LOCAL_ATTACHMENTS_DIR;
    return createFilesystemStore(join(process.cwd(), dir), keys);
  }
  return createGcsStore(name, keys);
}

/** The store attachments use: GCS when `ATTACHMENTS_BUCKET` is set, the filesystem backend otherwise. */
export function attachmentStore(): ObjectStore {
  return objectStore(env.ATTACHMENTS_BUCKET);
}
