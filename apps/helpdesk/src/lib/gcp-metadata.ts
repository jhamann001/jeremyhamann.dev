/**
 * The ONE place in this repository that talks to the GCE metadata server — node only, layer L2.
 *
 * ## Why this module is `http://`, and why that is correct
 *
 * The GCE/Cloud Run metadata server lives at the link-local address `169.254.169.254`, which
 * `metadata.google.internal` resolves to. That address is:
 *
 *  - **unroutable** — RFC 3927 link-local; it never leaves the VM's own virtual NIC, so there is no
 *    network segment for anyone to sit on and no packet for anyone to intercept;
 *  - **not a TLS endpoint** — Google does not serve HTTPS there and never has. There is no
 *    certificate to validate and no `https://` alternative to switch to. `google-auth-library`,
 *    `gcloud`, and every Google client library reach it over plain HTTP for this reason;
 *  - **already trusted** — the response *is* the instance's own credential. A caller that cannot
 *    trust its own kernel's loopback path has already lost.
 *
 * security scanner SAST rule ("Insecure HTTP Request", CWE-319) flags the literal
 * regardless, and it is right to: the rule cannot tell a link-local metadata address from an
 * arbitrary cleartext API. So the repository answers it structurally — every metadata call in the
 * app, the jobs runtime and the legacy help desk export tooling goes through THIS module, and the scanner's config carries
 * exactly one exception, scoped to this one file, for that one rule. A second `http://` literal
 * anywhere else in the tree is therefore a real finding, not a duplicate of this one.
 *
 * ## What lives here and what does not
 *
 * Stateless on purpose: no token cache. `src/lib/storage.ts` and `scripts/legacy-desk-export/store.ts`
 * each already cache with their own skew and their own reset hook, and a third cache inside the
 * shared module would silently outlive theirs. This module's whole job is "speak the metadata
 * protocol correctly, once".
 */

/** Host the metadata server answers on. Overridden by `GCE_METADATA_HOST` (host, or `host:port`). */
export const METADATA_DEFAULT_HOST = "metadata.google.internal" as const;

/** Required on every metadata request: its absence is how the server rejects a confused-deputy call. */
export const METADATA_FLAVOR_HEADER = "Metadata-Flavor" as const;
export const METADATA_FLAVOR_VALUE = "Google" as const;

/**
 * A metadata call that has not answered in this long is not going to. On Cloud Run the server is a
 * loopback hop; the only realistic cause of a hang is running outside GCP, where the DNS name either
 * does not resolve or resolves to something that is not the metadata server, and a request-scoped
 * caller must not sit on that.
 */
export const METADATA_TIMEOUT_MS = 3_000;

/** Why a metadata call failed. `unreachable` is "outside GCP" far more often than it is an outage. */
export type GcpMetadataFailure = "unreachable" | "status" | "malformed";

/**
 * A metadata failure. The message names the failure and, for `status`, the HTTP status — never the
 * response body, which on this endpoint is a credential.
 */
export class GcpMetadataError extends Error {
  readonly reason: GcpMetadataFailure;
  readonly status: number | null;
  constructor(reason: GcpMetadataFailure, detail: string, status: number | null = null) {
    super(`gcp metadata server: ${detail}`);
    this.name = "GcpMetadataError";
    this.reason = reason;
    this.status = status;
  }
}

/** Overrides a caller can inject — all three exist so the unit tests need no network and no clock. */
export type GcpMetadataOptions = {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type GcpAccessToken = {
  token: string;
  /** Seconds the token remains valid, as the server reported it. Callers apply their own skew. */
  expiresInSeconds: number;
};

/**
 * The metadata host in effect. `GCE_METADATA_HOST` is the same variable `google-auth-library` and
 * `gcloud` honour, and carries a bare host (optionally `host:port`) with no scheme — a value that
 * includes a scheme is rejected rather than concatenated into a malformed URL.
 */
export function metadataHost(env: Record<string, string | undefined> = process.env): string {
  const override = env.GCE_METADATA_HOST?.trim();
  if (override === undefined || override === "") return METADATA_DEFAULT_HOST;
  if (override.includes("://")) {
    throw new GcpMetadataError("malformed", "GCE_METADATA_HOST must be a host, not a URL");
  }
  return override;
}

/**
 * Absolute URL for a `computeMetadata/v1` path. The single `http://` literal in the repository that
 * the scanner's config exempts — see the module docstring.
 */
export function metadataUrl(path: string, env?: Record<string, string | undefined>): string {
  const suffix = path.startsWith("/") ? path.slice(1) : path;
  return `http://${metadataHost(env)}/computeMetadata/v1/${suffix}`;
}

async function metadataRequest(path: string, options: GcpMetadataOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = metadataUrl(path, options.env);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { [METADATA_FLAVOR_HEADER]: METADATA_FLAVOR_VALUE },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? METADATA_TIMEOUT_MS),
    });
  } catch {
    // The caught value is deliberately not read: a fetch failure here is a DNS or connect failure and
    // its text adds nothing an operator can act on (CWE-209).
    throw new GcpMetadataError("unreachable", "no response (not running on GCP, or the request timed out)");
  }
  if (!response.ok) {
    throw new GcpMetadataError("status", `responded ${response.status}`, response.status);
  }
  return response;
}

/**
 * An OAuth access token for the runtime service account.
 *
 * `scopes` narrows the token when the caller needs less than the instance's default scope set; on
 * Cloud Run the default is `cloud-platform` and most callers pass nothing. Scopes are sent as the
 * comma-separated `scopes` query parameter the endpoint defines, each one URL-encoded.
 *
 * Throws {@link GcpMetadataError} — never returns an empty token, because an empty token turns into
 * an `Authorization: Bearer ` header and a 401 three calls away from the real cause.
 */
export async function fetchAccessToken(
  scopes?: readonly string[],
  options: GcpMetadataOptions = {},
): Promise<GcpAccessToken> {
  const wanted = (scopes ?? []).map((s) => s.trim()).filter((s) => s !== "");
  const query = wanted.length > 0 ? `?scopes=${wanted.map(encodeURIComponent).join(",")}` : "";
  const response = await metadataRequest(`instance/service-accounts/default/token${query}`, options);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GcpMetadataError("malformed", "token response was not JSON");
  }
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const token = typeof record.access_token === "string" ? record.access_token : "";
  if (token.length === 0) throw new GcpMetadataError("malformed", "token response carried no access_token");
  const expiresIn = typeof record.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 0;
  return { token, expiresInSeconds: expiresIn };
}

/**
 * The runtime service account's email — the signer identity a GCS V4 signed URL and an IAM
 * `signBlob` call both name. Plain text, not JSON, trimmed of the trailing newline the server sends.
 */
export async function fetchServiceAccountEmail(options: GcpMetadataOptions = {}): Promise<string> {
  const response = await metadataRequest("instance/service-accounts/default/email", options);
  const email = (await response.text()).trim();
  if (email === "") throw new GcpMetadataError("malformed", "email response was empty");
  return email;
}
