import { createHash } from "node:crypto";
import { z } from "zod";
import { isStandInUrl } from "@/lib/demo/flags";

export const USER_ID_PATTERN = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
export const normalizeAccountNumber = (value: string) => value.trim().toUpperCase();
const nonblank = z.string().trim().min(1).max(500);
const nullableText = z.string().trim().max(500).nullable().optional();
const timestamp = z.iso.datetime({ offset: true }).nullable().optional();
const userId = z.string().regex(USER_ID_PATTERN);
const count = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative().max(100_000));
const complete = z.union([z.literal(true), z.literal("true")]);

// Sparse, tagged export rows avoid Redshift's single-cell aggregation limits.
// The manifest counts come from the same complete, consistent extraction, not
// from the received array length. They detect export limits and partial pulls.
const rowSchema = z.discriminatedUnion("row_kind", [
  z.object({ row_kind: z.literal("manifest"), contract_version: z.union([z.literal(1), z.literal("1")]),
    complete, source: nonblank, source_as_of: timestamp,
    source_health: z.enum(["FRESH", "STALE", "UNKNOWN"]),
    query_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expected_clients: count, expected_accounts: count, expected_memberships: count }),
  z.object({ row_kind: z.literal("client"), cedar_ridge_user_id: userId, canonical_name: nonblank,
    crm_stage: nullableText,
    eligibility: z.enum(["ACTIVE", "INACTIVE", "UNKNOWN"]), source: nonblank, source_updated_at: timestamp }),
  z.object({ row_kind: z.literal("account"), investment_account_id: nonblank,
    custodian: z.literal("APEX"), custodian_account_id: nullableText,
    account_number: nullableText, account_status: nullableText, source_updated_at: timestamp }),
  z.object({ row_kind: z.literal("membership"), investment_account_id: nonblank,
    cedar_ridge_user_id: userId, relationship_type: nullableText }),
]);

export type SourceClient = {
  cedarRidgeUserId: string; canonicalName: string; normalizedName: string;
  crmStage?: string | null;
  eligibility: "ACTIVE" | "INACTIVE" | "UNKNOWN"; source: string; sourceUpdatedAt: string | null;
};
export type SourceAccount = {
  investmentAccountId: string; custodian: "APEX"; custodianAccountId: string | null;
  accountNumber: string | null; normalizedAccountNumber: string | null;
  status: string | null; sourceUpdatedAt: string | null;
};
export type SourceMembership = {
  investmentAccountId: string; cedarRidgeUserId: string; relationshipType: string | null;
};
export type DirectorySnapshot = {
  source: string; sourceAsOf: string | null; sourceHealth: "FRESH" | "STALE" | "UNKNOWN";
  queryFingerprint: string; digest: string;
  clients: SourceClient[]; accounts: SourceAccount[]; memberships: SourceMembership[];
};

export class DirectorySourceError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "DirectorySourceError"; }
}

export function parseDirectoryRows(payload: unknown): DirectorySnapshot {
  if (!Array.isArray(payload) || payload.length > 100_001) throw new DirectorySourceError("SOURCE_SHAPE");
  const result = z.array(rowSchema).safeParse(payload);
  if (!result.success) throw new DirectorySourceError("SOURCE_SHAPE");
  const manifests = result.data.filter((row) => row.row_kind === "manifest");
  if (manifests.length !== 1) throw new DirectorySourceError("SOURCE_MANIFEST");
  const manifest = manifests[0];
  const clients: SourceClient[] = [];
  const accounts: SourceAccount[] = [];
  const memberships: SourceMembership[] = [];
  for (const row of result.data) {
    if (row.row_kind === "client") clients.push({
      cedarRidgeUserId: row.cedar_ridge_user_id, canonicalName: row.canonical_name,
      normalizedName: normalizeName(row.canonical_name), eligibility: row.eligibility,
      crmStage: row.crm_stage || null,
      source: row.source, sourceUpdatedAt: row.source_updated_at ? new Date(row.source_updated_at).toISOString() : null,
    });
    if (row.row_kind === "account") accounts.push({
      investmentAccountId: row.investment_account_id, custodian: row.custodian,
      custodianAccountId: row.custodian_account_id || null, accountNumber: row.account_number || null,
      normalizedAccountNumber: row.account_number ? normalizeAccountNumber(row.account_number) : null,
      status: row.account_status?.toUpperCase() || null, sourceUpdatedAt: row.source_updated_at ? new Date(row.source_updated_at).toISOString() : null,
    });
    if (row.row_kind === "membership") memberships.push({
      investmentAccountId: row.investment_account_id, cedarRidgeUserId: row.cedar_ridge_user_id,
      relationshipType: row.relationship_type || null,
    });
  }
  if (!clients.length || !accounts.length || !memberships.length) throw new DirectorySourceError("SOURCE_EMPTY");
  if (clients.length !== manifest.expected_clients || accounts.length !== manifest.expected_accounts ||
      memberships.length !== manifest.expected_memberships) throw new DirectorySourceError("SOURCE_INCOMPLETE");
  function unique(values: string[], code: string) {
    const set = new Set(values);
    if (set.size !== values.length) throw new DirectorySourceError(code);
    return set;
  }
  const clientIds = unique(clients.map((c) => c.cedarRidgeUserId), "SOURCE_DUPLICATE_CLIENT");
  const accountIds = unique(accounts.map((a) => a.investmentAccountId), "SOURCE_DUPLICATE_ACCOUNT");
  unique(accounts.filter((a) => a.normalizedAccountNumber).map((a) => JSON.stringify([a.custodian, a.normalizedAccountNumber])), "SOURCE_ACCOUNT_COLLISION");
  unique(memberships.map((m) => JSON.stringify([m.investmentAccountId, m.cedarRidgeUserId])), "SOURCE_DUPLICATE_MEMBERSHIP");
  if (memberships.some((m) => !clientIds.has(m.cedarRidgeUserId) || !accountIds.has(m.investmentAccountId))) {
    throw new DirectorySourceError("SOURCE_ORPHAN_MEMBERSHIP");
  }
  const snapshot = { source: manifest.source, sourceAsOf: manifest.source_as_of ? new Date(manifest.source_as_of).toISOString() : null,
    sourceHealth: manifest.source_health, queryFingerprint: manifest.query_fingerprint,
    clients: clients.sort((a, b) => a.cedarRidgeUserId.localeCompare(b.cedarRidgeUserId)),
    accounts: accounts.sort((a, b) => a.investmentAccountId.localeCompare(b.investmentAccountId)),
    memberships: memberships.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), };
  return { ...snapshot, digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

// The caller supplies an approved saved question. This does not grant arbitrary
// native-query access or invent a supported directory endpoint.
export async function fetchDirectoryRows(): Promise<DirectorySnapshot> {
  const base = process.env.CLIENT_DIRECTORY_WAREHOUSE_URL;
  const key = process.env.CLIENT_DIRECTORY_WAREHOUSE_API_KEY;
  const cardId = process.env.CLIENT_DIRECTORY_WAREHOUSE_CARD_ID;
  const expectedFingerprint = process.env.CLIENT_DIRECTORY_QUERY_FINGERPRINT;
  if (!base || !key || !cardId || !/^[1-9]\d*$/.test(cardId) ||
      !expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new DirectorySourceError("SOURCE_NOT_CONFIGURED");
  }
  let url: URL;
  try { url = new URL(base); } catch { throw new DirectorySourceError("SOURCE_NOT_CONFIGURED"); }
  // https only, except the demo's loopback stand-in (src/lib/demo/flags.ts).
  if ((url.protocol !== "https:" && !isStandInUrl(url)) || url.username || url.password || url.search || url.hash) {
    throw new DirectorySourceError("SOURCE_NOT_CONFIGURED");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/card/${cardId}/query/json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ format_rows: false }), cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new DirectorySourceError("SOURCE_HTTP_ERROR");
    }
    const limit = 10 * 1024 * 1024;
    if (Number(response.headers.get("content-length") ?? "0") > limit) {
      await response.body.cancel();
      throw new DirectorySourceError("SOURCE_TOO_LARGE");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new DirectorySourceError("SOURCE_TOO_LARGE"); }
      chunks.push(value);
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new DirectorySourceError("SOURCE_SHAPE"); }
    const snapshot = parseDirectoryRows(payload);
    if (snapshot.queryFingerprint !== expectedFingerprint) throw new DirectorySourceError("SOURCE_QUERY_CHANGED");
    return snapshot;
  } catch (error) {
    if (error instanceof DirectorySourceError) throw error;
    throw new DirectorySourceError(controller.signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_FETCH_FAILED");
  } finally { clearTimeout(timeout); }
}
