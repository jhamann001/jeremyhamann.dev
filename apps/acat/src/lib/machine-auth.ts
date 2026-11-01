// Machine-to-machine (server-to-server) authentication for the Transfer Tracker.
//
// The tracker's browser-facing REST routes gate on a NextAuth *session*
// (see `@/lib/auth` + `requireAdmin`). There is no session for another GCP
// service calling us, and the Cloud Run service is deployed with an
// `allUsers` invoker (it serves a public browser UI), so we cannot gate at
// the platform layer. Instead each machine route verifies a Google-issued
// OIDC **ID token** in-app.
//
// Verification uses google-auth-library's `verifyIdToken`, which validates
// the JWT signature against Google's published certs AND checks the `aud`
// claim. We additionally require a verified email that is in an explicit
// service-account allowlist. Any failure — missing/garbage header, bad
// signature, wrong audience, unverified or non-allowlisted email — collapses
// to a single `null` result so callers return an opaque 401. We deliberately
// never hand-parse the JWT and never leak the failure reason to the client.

import { OAuth2Client } from "google-auth-library";
import { logger } from "@/lib/logger";

// The tracker's own Cloud Run URL. A valid ID token minted for this service
// carries this value in its `aud` claim; verifyIdToken rejects anything else.
const DEFAULT_AUDIENCE = "https://transfer-tracker.invalid";

// The global policy remains production-only by default. Scoped dev read grants
// must never be added here: future machine endpoints do not inherit them.
const DEFAULT_ALLOWED_SAS = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const OPS_PORTAL_DEV_READ_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";

export function getExpectedAudience(): string {
  return process.env.MACHINE_AUTH_AUDIENCE?.trim() || DEFAULT_AUDIENCE;
}

export function getAllowedServiceAccounts(): Set<string> {
  const raw = process.env.MACHINE_AUTH_ALLOWED_SAS?.trim() || DEFAULT_ALLOWED_SAS;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// A single reusable client. `OAuth2Client` with no args is stateless for
// verification (it caches Google's certs internally), so sharing it avoids
// re-fetching certs on every request.
let cachedClient: OAuth2Client | null = null;
function getClient(): OAuth2Client {
  if (!cachedClient) cachedClient = new OAuth2Client();
  return cachedClient;
}

/**
 * Extract the raw bearer token from an `Authorization` header value.
 * Returns null for missing, malformed, or empty-token headers.
 */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  // Scheme is case-insensitive per RFC 7235 (accept `bearer`/`BEARER` too).
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Verify the caller of a machine endpoint from its `Authorization: Bearer
 * <idToken>` header. Resolves to `{ email }` for a verified, allowlisted
 * service account, or `null` for every failure mode (the caller maps null to
 * a 401 and must not surface the reason).
 *
 * Never throws: verifyIdToken failures are caught and become `null`.
 */
export async function verifyMachineCaller(
  request: Request
): Promise<{ email: string } | null> {
  const caller = await verifyMachineIdentity(request);
  return caller && getAllowedServiceAccounts().has(caller.email) ? caller : null;
}

/** Library-only authorization. An exact route/method check prevents accidental
 * reuse on client-transfer handlers. No request header/query selects a scope.
 * The additional dev grant takes effect only via reviewed Tracker deployment. */
export async function verifyCustodianLibraryCaller(
  request: Request
): Promise<{ email: string } | null> {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/api/machine/custodians") {
    return null;
  }
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return getAllowedServiceAccounts().has(caller.email) || caller.email === OPS_PORTAL_DEV_READ_SA
    ? caller : null;
}

export type CustodianSnapshotRoute = "snapshot" | "file";

/** Snapshot export. The library verifier stays exact to GET /api/machine/custodians.
 * Handlers pass a literal route. No header, query, or body selects a scope.
 * Readers match verifyCustodianLibraryCaller: production allow-list or the dev reader. */
export async function verifyCustodianSnapshotCaller(
  request: Request,
  route: CustodianSnapshotRoute,
): Promise<{ email: string } | null> {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  const matches =
    (route === "snapshot" && path === "/api/machine/custodians/snapshot") ||
    (route === "file" && /^\/api\/machine\/custodians\/fee-schedules\/[^/]+$/.test(path));
  if (!matches) return null;
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return getAllowedServiceAccounts().has(caller.email) || caller.email === OPS_PORTAL_DEV_READ_SA
    ? caller
    : null;
}

/** The handler supplies a literal scope, never a header/query/body value.
 * Dev is authorized for these GET handlers: `/api/machine/acats`,
 * `/api/machine/acats/[acatTransferId]`, `/api/machine/acats/by-record/[id]`,
 * `/api/machine/acats/by-record/[id]/history`, `/api/machine/clients/search`,
 * and the advisor list read `/api/machine/advisor/acats`. Global machine
 * access, the library policy, and all mutation routes remain separate. */
export async function verifyAcatReadCaller(
  request: Request,
  route: "list" | "transfer" | "record" | "clients" | "advisor" | "history"
): Promise<{ email: string } | null> {
  if (request.method !== "GET") return null;
  const path = new URL(request.url).pathname;
  const matchesRoute =
    (route === "list" && path === "/api/machine/acats") ||
    (route === "clients" && path === "/api/machine/clients/search") ||
    (route === "advisor" && path === "/api/machine/advisor/acats") ||
    (route === "transfer" && /^\/api\/machine\/acats\/(?!by-record$)[^/]+$/.test(path)) ||
    (route === "record" && /^\/api\/machine\/acats\/by-record\/[^/]+$/.test(path)) ||
    (route === "history" && /^\/api\/machine\/acats\/by-record\/[^/]+\/history$/.test(path));
  if (!matchesRoute) return null;

  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return getAllowedServiceAccounts().has(caller.email) || caller.email === OPS_PORTAL_DEV_READ_SA
    ? caller : null;
}

/** Machine writes use the production allow-list only. Dev read grants stay on
 * the three GET handlers and are not inherited here. */
export async function verifyAcatWriteCaller(
  request: Request,
  route: "create" | "update" | "restore"
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  const matchesRoute =
    (route === "create" && request.method === "POST" && path === "/api/machine/acats") ||
    (route === "update" && request.method === "PATCH" && /^\/api\/machine\/acats\/by-record\/[^/]+$/.test(path)) ||
    (route === "restore" && request.method === "POST" && /^\/api\/machine\/acats\/by-record\/[^/]+\/restore$/.test(path));
  if (!matchesRoute) return null;

  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return getAllowedServiceAccounts().has(caller.email) ? caller : null;
}

export type CustodianAdminRoute =
  | "create" | "update" | "fee-create" | "fee-update" | "fee-delete" | "merge";

const CUSTODIAN_ADMIN_BASE = "/api/machine/custodians/admin";
const SEGMENT = "[^/]+";

const PROD_WRITE_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_WRITE_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";

/** Both Ops Portal identities, same env var as ACAT writes. Unset defaults to both.
 * A set value that drops the prod identity rejects every caller. */
function custodianWriteAccounts(): Set<string> | null {
  const raw = process.env.MACHINE_AUTH_ALLOWED_SAS?.trim();
  const list = (raw ? raw.split(",") : [PROD_WRITE_SA, DEV_WRITE_SA])
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.includes(PROD_WRITE_SA)) return null;
  return new Set(list);
}

/** Custodian playbook writes. The library read policy is not inherited.
 * Dev is allowed because the owner rejected the prod-only grant. */
export async function verifyCustodianAdminCaller(
  request: Request,
  route: CustodianAdminRoute
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  const m = request.method;
  const at = (suffix: string) => new RegExp(`^${CUSTODIAN_ADMIN_BASE}${suffix}$`).test(path);
  const matchesRoute =
    (route === "create" && m === "POST" && path === CUSTODIAN_ADMIN_BASE) ||
    (route === "update" && m === "PATCH" && at(`/${SEGMENT}`)) ||
    (route === "fee-create" && m === "POST" && at(`/${SEGMENT}/fees`)) ||
    (route === "fee-update" && m === "PATCH" && at(`/${SEGMENT}/fees/${SEGMENT}`)) ||
    (route === "fee-delete" && m === "DELETE" && at(`/${SEGMENT}/fees/${SEGMENT}`)) ||
    (route === "merge" && m === "POST" && at(`/${SEGMENT}/merge`));
  if (!matchesRoute) return null;
  const allowed = custodianWriteAccounts();
  if (!allowed) return null;
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return allowed.has(caller.email) ? caller : null;
}

export async function verifyCustodianProjectionCaller(
  request: Request
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || path !== "/api/machine/custodians/projection") return null;
  const allowed = custodianWriteAccounts();
  if (!allowed) return null;
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return allowed.has(caller.email) ? caller : null;
}

export async function verifyDashboardCaller(
  request: Request,
  access: "read" | "write",
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  if (
    (access === "read" &&
      (request.method !== "GET" || path !== "/api/machine/dashboard")) ||
    (access === "write" &&
      (request.method !== "POST" ||
        path !== "/api/machine/dashboard/reviews"))
  ) {
    return null;
  }
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  if (getAllowedServiceAccounts().has(caller.email)) return caller;
  return access === "read" && caller.email === OPS_PORTAL_DEV_READ_SA ? caller : null;
}

/** ticket transfer-drawer contract. The suggestion read follows the existing
 * read policy (production allow-list or the scoped Ops Portal dev reader). Every
 * mutation accepts only the exact production Ops Portal identity: the production
 * allow-list variable can also list the dev identity, so membership alone is
 * not enough. Handlers pass a literal access value, never request input. */
export async function verifyDrawerCaller(
  request: Request,
  access: "suggestion" | "write"
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  if (access === "suggestion") {
    if (request.method !== "GET" || path !== "/api/machine/dtcc-suggestion") return null;
  } else if (
    (request.method !== "PATCH" && request.method !== "DELETE") ||
    !/^\/api\/machine\/acats\/by-record\/[A-Za-z0-9_-]{1,128}\/drawer$/.test(path)
  ) {
    return null;
  }
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  if (access === "write") {
    return caller.email === DEFAULT_ALLOWED_SAS && getAllowedServiceAccounts().has(caller.email) ? caller : null;
  }
  return getAllowedServiceAccounts().has(caller.email) || caller.email === OPS_PORTAL_DEV_READ_SA ? caller : null;
}

/** Security reconciliation: exact route and method per access. Read and search
 * accept the production allow-list or the scoped dev read identity. Write
 * follows `getAllowedServiceAccounts()` exactly like `verifyAcatWriteCaller`;
 * `OPS_PORTAL_DEV_READ_SA` is never added to write by this constant. */
export async function verifySecurityReconCaller(
  request: Request,
  access: "read" | "search" | "write",
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  const matches =
    (access === "read" && request.method === "GET" &&
      /^\/api\/machine\/acats\/by-record\/[^/]+\/security-recon$/.test(path)) ||
    (access === "search" && request.method === "GET" &&
      /^\/api\/machine\/acats\/by-record\/[^/]+\/security-recon\/accounts$/.test(path)) ||
    (access === "write" && request.method === "POST" &&
      /^\/api\/machine\/acats\/by-record\/[^/]+\/security-recon$/.test(path));
  if (!matches) return null;
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  if (getAllowedServiceAccounts().has(caller.email)) return caller;
  return access !== "write" && caller.email === OPS_PORTAL_DEV_READ_SA ? caller : null;
}

/** Fee reimbursement: exact route and method. GET and POST both accept only
 * getAllowedServiceAccounts(). This function does not add OPS_PORTAL_DEV_READ_SA. */
export async function verifyFeeCaller(
  request: Request,
  access: "read" | "write",
): Promise<{ email: string } | null> {
  const path = new URL(request.url).pathname;
  const matches =
    (access === "read" && request.method === "GET" && /^\/api\/machine\/acats\/by-record\/[^/]+\/fees$/.test(path)) ||
    (access === "write" && request.method === "POST" && /^\/api\/machine\/acats\/by-record\/[^/]+\/fees$/.test(path));
  if (!matches) return null;
  const caller = await verifyMachineIdentity(request);
  if (!caller) return null;
  return getAllowedServiceAccounts().has(caller.email) ? caller : null;
}

/** Full-history identity evidence is a separate opt-in grant. Existing machine
 * or dev-read grants never inherit it, and production never accepts the dev SA. */
export async function verifyTransferLinkageCaller(
  request: Request,
  route: "snapshot" | "record"
): Promise<{ email: string } | null> {
  if (process.env.TRANSFER_LINKAGE_ENABLED !== "true" || request.method !== "GET") return null;
  const environment = process.env.TRANSFER_LINKAGE_ENVIRONMENT;
  if (environment !== "production" && environment !== "synthetic") return null;
  if (environment === "synthetic" && (!process.env.MACHINE_AUTH_AUDIENCE?.trim() || getExpectedAudience() === DEFAULT_AUDIENCE)) return null;
  const path = new URL(request.url).pathname;
  if (!((route === "snapshot" && path === "/api/machine/transfer-linkage") ||
    (route === "record" && /^\/api\/machine\/transfer-linkage\/[a-zA-Z0-9_-]{1,128}$/.test(path)))) return null;
  const allowed = new Set((process.env.TRANSFER_LINKAGE_ALLOWED_SAS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) return null;
  const caller = await verifyMachineIdentity(request);
  if (!caller || (environment === "production" && caller.email === OPS_PORTAL_DEV_READ_SA)) return null;
  return allowed.has(caller.email) ? caller : null;
}

// Authentication is shared; authorization stays with the scoped entry points
// above. Keep this helper private so routes cannot omit the allowlist check.
async function verifyMachineIdentity(request: Request): Promise<{ email: string } | null> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return null;

  try {
    const ticket = await getClient().verifyIdToken({
      idToken: token,
      audience: getExpectedAudience(),
    });
    const payload = ticket.getPayload();
    if (!payload) return null;
    if (payload.email_verified !== true) return null;

    const email = payload.email?.trim().toLowerCase();
    if (!email) return null;
    return { email };
  } catch {
    // All verification failures (bad signature, wrong audience, expired,
    // malformed) are treated identically. We intentionally do not log the
    // error detail or the token — only a generic outcome — so nothing
    // sensitive lands in logs and nothing leaks to the client.
    logger.warn("machine auth: ID token verification failed");
    return null;
  }
}
