import { z } from "zod";
import { hashBytes } from "./canonical";
import type { Evidence } from "./contracts";
import { validateEvidence } from "./match";

// SELECT only. Run verbatim on Warehouse database 4 and export complete results.
export const SOURCE_QUERIES = {
  directory: `WITH crm_clients AS (
  SELECT cedar_ridge_user_id__c AS cedar_ridge_user_id, TRIM(name) AS canonical_name,
         CAST('UNKNOWN' AS VARCHAR(16)) AS eligibility
  FROM crm.crm_contacts
  WHERE cedar_ridge_user_id__c ~ '^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
), source_clients AS (
  SELECT cedar_ridge_user_id, canonical_name, eligibility FROM crm_clients
  UNION ALL
  SELECT u.id, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')),
         CAST('UNKNOWN' AS VARCHAR(16))
  FROM "user"."user" u
  LEFT JOIN crm_clients p ON p.cedar_ridge_user_id = u.id
  WHERE u.id ~ '^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p.cedar_ridge_user_id IS NULL
)
SELECT 'canonical-v2' AS source, cedar_ridge_user_id, canonical_name AS name
FROM source_clients ORDER BY cedar_ridge_user_id;`,
  accounts: `SELECT a.account_id,a.custodian_id,c.custodian,a.custodian_account_id,a.custodian_account_number,au.user_id AS cedar_ridge_user_id,rt.account_relationship_type, a.persisted_time AS account_persisted_time,au.persisted_time AS relationship_persisted_time FROM investment.account a LEFT JOIN investment.account_user au ON au.account_id=a.account_id LEFT JOIN investment.account_relationship_type rt ON rt.account_relationship_type_id=au.account_relationship_type_id LEFT JOIN investment.custodian c ON c.custodian_id=a.custodian_id WHERE a.custodian_id=2 ORDER BY a.account_id,au.user_id;`,
  transfers: `SELECT acat_transfer_id,user_id AS cedar_ridge_user_id,is_initiator,authorized_acat_transfer,persisted_time FROM investment.acat_transfer_user ORDER BY acat_transfer_id,user_id;`,
};

// Reject old raw-user/CRM-union exports rather than relabeling their query
// fingerprint after the canonical-name precedence changed.
const directoryRow = z.object({ source: z.literal("canonical-v2"), cedar_ridge_user_id: z.string(), name: z.string() });
const accountRow = z.object({ account_id: z.string(), custodian_id: z.number(), custodian_account_number: z.string().nullable(), cedar_ridge_user_id: z.string().nullable(), account_relationship_type: z.string().nullable() });
const transferRow = z.object({ acat_transfer_id: z.string(), cedar_ridge_user_id: z.string(), is_initiator: z.union([z.boolean(), z.enum(["true", "false"])]) });

export function importWarehouse(directoryInput: unknown, accountInput: unknown, transferInput: unknown, extractedAt: string, snapshotId: string): Evidence {
  const directory = z.array(directoryRow).parse(directoryInput);
  const accounts = z.array(accountRow).parse(accountInput);
  const transfers = z.array(transferRow).parse(transferInput);
  if (accounts.some((row) => row.custodian_id !== 2)) throw new Error("UNEXPECTED_CUSTODIAN_SCOPE");
  return validateEvidence({ version: 1, extractedAt, snapshotId,
    sourceQueryHashes: Object.fromEntries(Object.entries(SOURCE_QUERIES).map(([key, sql]) => [key, hashBytes(sql)])),
    upstreamFreshness: "unknown", freshnessEvidence: "Fresh retrieval only; authoritative upstream freshness has not been verified.",
    clients: directory.map((row) => ({ userId: row.cedar_ridge_user_id, name: row.name })),
    accounts: accounts.map((row) => ({ accountId: row.account_id, accountNumber: row.custodian_account_number, userId: row.cedar_ridge_user_id, relationshipType: row.account_relationship_type })),
    transfers: transfers.map((row) => ({ transferId: row.acat_transfer_id, userId: row.cedar_ridge_user_id, isInitiator: row.is_initiator === true || row.is_initiator === "true" })),
  });
}
