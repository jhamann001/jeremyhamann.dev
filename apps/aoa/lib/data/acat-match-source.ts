import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { crmIdentityReadsEnabled } from "@/lib/flags";
import {
  TRANSFER_LINKAGE_MAX_MEMBERS, TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT, TRANSFER_LINKAGE_MAX_RECORDS,
  ACAT_LINK_MAX_PROOF_AGE_MS, LinkageError, type AoaAcatCandidate, type LinkageSnapshot,
} from "./acat-link-contract";
import { acatEvidenceHash, canonicalAcatUuid } from "./acat-match";
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

const text = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const member = z.object({ cedarRidgeUserId: text, relationshipType: z.string().max(80).nullable(),
  isCurrent: z.boolean(), clientEligibility: z.enum(["ACTIVE", "INACTIVE", "UNKNOWN"]), presentInSnapshot: z.boolean() }).strict();
const record = z.object({
  recordId: text, cedarRidgeUserIds: z.array(text).max(TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT),
  identityVersion: z.number().int().nonnegative(),
  acatTransferId: z.string().uuid().nullable(), controlNumber: z.string().max(64).nullable(),
  crmDealId: z.string().length(18).nullable(), crmDealIdProvenance: z.enum(["LEGACY_UNVERIFIED", "ABSENT"]),
  direction: z.enum(["IN", "OUT", "UNKNOWN"]), transferType: z.enum(["FULL", "PARTIAL", "UNKNOWN"]),
  workflow: text, status: text, deletedAt: instant.nullable(), createdAt: instant,
  requestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  receivingAccount: z.object({ namespace: z.literal("cedarRidge.investment_account"), id: text.nullable(),
    status: z.string().max(80).nullable(), isCurrent: z.boolean(), members: z.array(member).max(TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT),
    holderSetComplete: z.boolean(), verification: z.enum(["VERIFIED", "MISSING_IDENTITY", "MISSING_ACCOUNT",
      "ACCOUNT_UNRESOLVED", "HOLDER_MISMATCH", "HISTORICAL", "SOURCE_UNAVAILABLE"]) }).strict(),
  recordEvidenceDigest: digest, accountEvidenceDigest: digest,
}).strict();
const snapshotSchema = z.object({
  contractVersion: z.literal(1),
  source: z.object({ system: z.literal("transfer-tracker"), installationId: text, environment: z.enum(["production", "synthetic"]) }).strict(),
  scope: z.literal("ALL_RECORDS_INCLUDING_DELETED"), complete: z.literal(true), observedAt: instant,
  recordCount: z.number().int().nonnegative().max(TRANSFER_LINKAGE_MAX_RECORDS), snapshotDigest: digest,
  directory: z.object({ snapshotId: text.nullable(), publishedGeneration: z.number().int().nonnegative(),
    health: z.enum(["FRESH", "STALE", "UNKNOWN", "UNAVAILABLE"]), freshnessBasis: z.enum(["UPSTREAM_VERIFIED", "FETCH_SUCCESS"]),
    lastSuccessAt: instant.nullable(), sourceAsOf: instant.nullable() }).strict(),
  records: z.array(record).max(TRANSFER_LINKAGE_MAX_RECORDS),
}).strict();

export type TransferLinkageConfiguration = { baseUrl: string; installationId: string; environment: "production" | "synthetic" };

export function transferLinkageConfiguration(env: Readonly<Record<string, string | undefined>> = process.env): TransferLinkageConfiguration {
  const raw = env.TRANSFER_LINKAGE_URL?.trim();
  const installationId = env.TRANSFER_LINKAGE_INSTALLATION_ID?.trim();
  const environment = env.TRANSFER_LINKAGE_ENVIRONMENT;
  if (!raw || !installationId || !["production", "synthetic"].includes(environment ?? "")) throw new LinkageError("NOT_CONFIGURED");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new LinkageError("NOT_CONFIGURED"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !["", "/"].includes(parsed.pathname) || parsed.port || installationId.length > 256) throw new LinkageError("NOT_CONFIGURED");
  return { baseUrl: parsed.origin, installationId, environment: environment === "production" ? "production" : "synthetic" };
}

/** Validate bounded authenticated wire data before trusting its typed shape.
 * Publication timestamps do not enter the substantive snapshot digest. */
export function validateTransferLinkageSnapshot(raw: unknown, expected: TransferLinkageConfiguration, now = new Date()): LinkageSnapshot {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_snapshot");
  const source = parsed.data;
  if (source.source.installationId !== expected.installationId || source.source.environment !== expected.environment) throw new LinkageError("SOURCE_UNAVAILABLE", "wrong_source");
  const age = now.getTime() - Date.parse(source.observedAt);
  if (!Number.isFinite(age) || age < -30_000 || age > ACAT_LINK_MAX_PROOF_AGE_MS) throw new LinkageError("SOURCE_UNAVAILABLE", "stale_snapshot");
  if (source.directory.health !== "FRESH" || !source.directory.snapshotId || !source.directory.lastSuccessAt) throw new LinkageError("DIRECTORY_UNAVAILABLE");
  if (source.recordCount !== source.records.length || new Set(source.records.map((row) => row.recordId)).size !== source.records.length) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_snapshot");
  const accounts = new Map<string, string>();
  let membershipCount = 0;
  for (const row of source.records) {
    if (new Set(row.cedarRidgeUserIds).size !== row.cedarRidgeUserIds.length
      || new Set(row.receivingAccount.members.map((holder) => holder.cedarRidgeUserId)).size !== row.receivingAccount.members.length) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_snapshot");
    const account = row.receivingAccount;
    const key = account.id === null ? null : `${account.namespace}:${account.id}`;
    // Producer limits memberships once per account, even when many historical
    // records reference it. Completeness/verification depend on each record's
    // selected identity, so only the shared account facts must agree.
    const facts = acatEvidenceHash({ namespace: account.namespace, id: account.id, status: account.status, isCurrent: account.isCurrent,
      members: [...account.members].sort((a, b) => a.cedarRidgeUserId < b.cedarRidgeUserId ? -1 : a.cedarRidgeUserId > b.cedarRidgeUserId ? 1 : 0) });
    if (key !== null && accounts.has(key)) {
      if (accounts.get(key) !== facts) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_snapshot");
    } else {
      if (key !== null) accounts.set(key, facts);
      membershipCount += account.members.length;
      if (membershipCount > TRANSFER_LINKAGE_MAX_MEMBERS) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_snapshot");
    }
  }
  const computed = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source,
    scope: source.scope, records: [...source.records].sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
      .map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
  if (computed !== source.snapshotDigest) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_snapshot");
  return source;
}

const auth = new ServiceAuth();
const MAX_BYTES = 8 * 1024 * 1024;
// AbortSignal.timeout rejects fetch and body reads with a DOMException named
// TimeoutError; anything else is a transport failure.
const timedOut = (error: unknown) => typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";

/** No production fallback, fixture escape hatch, redirects, token/body logging
 * or network within a database transaction. The source installation is pinned
 * separately from URL/audience so wrong-environment responses fail closed. */
export async function fetchTransferLinkageSnapshot(): Promise<LinkageSnapshot> {
  const configuration = transferLinkageConfiguration();
  const url = `${configuration.baseUrl}/api/machine/transfer-linkage`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const headers = await Promise.race([
    (async () => {
      try {
        const client = await auth.getIdTokenClient(configuration.baseUrl);
        return await client.getRequestHeaders(url);
      } catch { throw new LinkageError("SOURCE_UNAVAILABLE", "auth_failed"); }
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LinkageError("SOURCE_UNAVAILABLE", "auth_timeout")), 15_000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  let response: Response;
  try {
    response = await serviceFetch(url, { method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch (error) { throw new LinkageError("SOURCE_UNAVAILABLE", timedOut(error) ? "request_timeout" : "request_failed"); }
  if (!response.ok) throw new LinkageError("SOURCE_UNAVAILABLE", "http_status", response.status);
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new LinkageError("SNAPSHOT_OVERFLOW"); }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof LinkageError) throw error;
    throw new LinkageError("SOURCE_UNAVAILABLE", timedOut(error) ? "request_timeout" : "request_failed");
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new LinkageError("SOURCE_UNAVAILABLE", "invalid_body"); }
  return validateTransferLinkageSnapshot(raw, configuration);
}

type CandidateRow = {
  id: string; acat_link_version: number; acat_record_id: string | null; acat_transfer_id: string | null;
  acat_auto_link_hold: boolean; stage: string; funding_type: string | null; archived_at: Date | null;
  client_sf_id: string | null; household_sf_id: string | null; deal_id: string | null; deal_sf_id: string | null;
  canonical_client_sf_id: string | null; client_user_ids: string[]; deal_user_id: string | null;
  parent_deal_sf_id: string | null; parent_deal_client_sf_id: string | null; parent_deal_archived_at: Date | null;
  asset_map_folder_id: string | null; asset_map_custodian: string | null; asset_map_account_number: string | null;
  asset_map_account_type: string | null; funding_plan_version: number;
};

/** Caller supplies one Operations or ingest transaction. This includes
 * archived transfers and uses no date/funding/search-stage population filter.
 * Raw source account values contribute only to a server-side digest. */
export async function readAcatCandidatesWithinScope(tx: Prisma.TransactionClient): Promise<AoaAcatCandidate[]> {
  const resolveAliases = crmIdentityReadsEnabled();
  // Main can precede funding-plan approval rollout. Bind its version when the
  // column exists without requiring that unrelated feature for Transfer linkage.
  const rows = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
    WITH targets AS MATERIALIZED (
      SELECT t.*, CASE WHEN ${resolveAliases} THEN app.resolve_crm_canonical_contact_source_key(t.client_sf_id)
        ELSE t.client_sf_id END AS canonical_client_sf_id
      FROM app.transfer t ORDER BY t.id LIMIT ${TRANSFER_LINKAGE_MAX_RECORDS + 1}
    ) SELECT t.id,t.acat_link_version,t.acat_record_id,t.acat_transfer_id,t.acat_auto_link_hold,t.stage,t.funding_type,t.archived_at,
      t.client_sf_id,t.household_sf_id,t.deal_id,t.deal_sf_id,t.canonical_client_sf_id,
      t.asset_map_folder_id,t.asset_map_custodian,t.asset_map_account_number,t.asset_map_account_type,
      COALESCE((to_jsonb(t)->>'funding_plan_version')::integer, 0) AS funding_plan_version,
      ARRAY(SELECT DISTINCT nullif(btrim(c.cedar_ridge_user_id),'') FROM mirror.client c
        WHERE left(c.sf_id,15)=left(t.canonical_client_sf_id,15) AND nullif(btrim(c.cedar_ridge_user_id),'') IS NOT NULL
        ORDER BY 1) AS client_user_ids,
      d.cedar_ridge_user_id AS deal_user_id,d.sf_deal_id AS parent_deal_sf_id,
      d.client_sf_id AS parent_deal_client_sf_id,d.archived_at AS parent_deal_archived_at
      FROM targets t LEFT JOIN app.deal d ON d.id=t.deal_id ORDER BY t.id`);
  if (rows.length > TRANSFER_LINKAGE_MAX_RECORDS) throw new LinkageError("SNAPSHOT_OVERFLOW");
  return rows.map((row) => {
    const dealUserId = row.deal_user_id?.trim() || null;
    const conflict = row.client_user_ids.length > 1 || (dealUserId !== null && row.client_user_ids.length > 0
      && !row.client_user_ids.includes(dealUserId));
    const uuid = canonicalAcatUuid(row.acat_transfer_id);
    const transactionReference: AoaAcatCandidate["transactionReference"] = uuid
      ? { namespace: "apex-acat-transfer", value: uuid, provenance: "EXISTING_LINK" }
      : row.deal_sf_id ? { namespace: "crm.opportunity", value: row.deal_sf_id, provenance: "LEGACY_UNVERIFIED" } : null;
    const candidate: AoaAcatCandidate = {
      transferId: row.id, linkVersion: row.acat_link_version, existingRecordId: row.acat_record_id,
      existingTransferUuid: row.acat_transfer_id, hold: row.acat_auto_link_hold, stage: row.stage,
      fundingType: row.funding_type, archived: row.archived_at !== null,
      canonicalClientUserIds: row.client_user_ids, dealUserId,
      identityState: conflict ? "conflict" : row.client_user_ids.length === 1 ? "verified" : "missing",
      // No join from AOA custodian_account_id to cedarRidge.investment_account
      // has been proven. Derived registration/last4 must never fill this field.
      receivingAccount: null, transactionReference,
      evidenceDigest: acatEvidenceHash(row),
    };
    return candidate;
  });
}
