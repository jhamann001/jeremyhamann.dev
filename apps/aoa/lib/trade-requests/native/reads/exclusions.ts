import { z } from "zod";
import { prisma } from "@/lib/db";
import { SEGMENT, bodyOf, nativeRoutes, ok, route } from "./http";
import { getCachedClients, tradeRequestWarehouseConfigured } from "./sources";

// Exclusion reads ported from trade-request d41b6c9 server/src/routes/exclusions.ts:17, :47-53, :160-185
// (row mapping), :209-285 (firm-wide export), :290-320 (client bulk), :322-354 (account bulk), :741-761 (one client).

const clientIdParamSchema = z.string().min(1).max(100);
const bulkBodySchema = z.object({
  clientIds: z.array(z.string().min(1).max(100)).min(1, "clientIds is required").max(1000, "Too many client IDs"),
});
const bulkAccountBodySchema = z.object({
  accountIds: z.array(z.string().min(1).max(100)).min(1, "accountIds is required").max(1000, "Too many account IDs"),
});

type Kind = "advisor" | "client";
type ClientRow = { id: string; client_id: string; ticker: string; kind: Kind; reason: string; no_buy: boolean; no_sell: boolean; created_by_name: string; created_at: Date };
type AccountRow = { id: string; account_id: string; ticker: string; kind: Kind; reason: string; no_buy: boolean; no_sell: boolean; created_by_name: string; created_at: Date };

const CLIENT_COLUMNS = `id::text AS id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at`;
const ACCOUNT_COLUMNS = `id::text AS id, account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at`;
const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

function rowToExclusion(row: ClientRow) {
  return {
    id: row.id, clientId: row.client_id, ticker: row.ticker, kind: row.kind, reason: row.reason,
    noBuy: row.no_buy, noSell: row.no_sell, createdByName: row.created_by_name, createdAt: iso(row.created_at),
  };
}

function rowToAccountExclusion(row: AccountRow) {
  return {
    id: row.id, accountId: row.account_id, ticker: row.ticker, kind: row.kind, reason: row.reason,
    noBuy: row.no_buy, noSell: row.no_sell, createdByName: row.created_by_name, createdAt: iso(row.created_at),
  };
}

async function clientBulk(body: unknown) {
  const { clientIds } = bulkBodySchema.parse(body);
  const uniqueIds = [...new Set(clientIds)];
  const rows = await prisma.$queryRawUnsafe<ClientRow[]>(
    `SELECT ${CLIENT_COLUMNS} FROM trade_request.client_exclusions WHERE client_id = ANY($1::varchar[]) ORDER BY client_id, kind, ticker`,
    uniqueIds,
  );
  const grouped: Record<string, ReturnType<typeof rowToExclusion>[]> = {};
  for (const id of uniqueIds) grouped[id] = [];
  for (const row of rows) grouped[row.client_id]!.push(rowToExclusion(row));
  return ok({ data: grouped });
}

/** exclusions.ts:209-285: names are best-effort enrichment from the cached client list. */
async function firmWideExport() {
  const [clientRows, accountRows] = await Promise.all([
    prisma.$queryRawUnsafe<ClientRow[]>(`SELECT ${CLIENT_COLUMNS} FROM trade_request.client_exclusions ORDER BY client_id, kind, ticker`),
    prisma.$queryRawUnsafe<AccountRow[]>(`SELECT ${ACCOUNT_COLUMNS} FROM trade_request.account_exclusions ORDER BY account_id, kind, ticker`),
  ]);
  const clientNameById = new Map<string, string>();
  const accountByUlid = new Map<string, { clientId: string; clientName: string; accountNumber: string }>();
  if (tradeRequestWarehouseConfigured()) {
    try {
      for (const c of await getCachedClients()) {
        clientNameById.set(c.id, c.name);
        for (const a of c.accounts) accountByUlid.set(a.id, { clientId: c.id, clientName: c.name, accountNumber: a.accountNumber });
      }
    } catch {
      console.warn(JSON.stringify({ event: "trade_request_exclusion_export_names_unavailable" }));
    }
  }
  return ok({
    data: [
      ...clientRows.map((row) => ({
        scope: "client" as const, clientId: row.client_id, clientName: clientNameById.get(row.client_id) ?? "",
        accountId: "", accountNumber: "", ticker: row.ticker, kind: row.kind, reason: row.reason,
        noBuy: row.no_buy, noSell: row.no_sell, createdByName: row.created_by_name, createdAt: iso(row.created_at),
      })),
      ...accountRows.map((row) => {
        const acct = accountByUlid.get(row.account_id);
        return {
          scope: "account" as const, clientId: acct?.clientId ?? "", clientName: acct?.clientName ?? "",
          accountId: row.account_id, accountNumber: acct?.accountNumber ?? "", ticker: row.ticker, kind: row.kind,
          reason: row.reason, noBuy: row.no_buy, noSell: row.no_sell, createdByName: row.created_by_name, createdAt: iso(row.created_at),
        };
      }),
    ],
  });
}

export const clientExclusionsHandler = nativeRoutes(route("GET", `/clients/${SEGMENT}/exclusions`, async ([raw]) => {
  const clientId = clientIdParamSchema.parse(raw);
  const rows = await prisma.$queryRawUnsafe<ClientRow[]>(
    `SELECT ${CLIENT_COLUMNS} FROM trade_request.client_exclusions WHERE client_id = $1 ORDER BY kind, ticker`,
    clientId,
  );
  return ok({ data: rows.map(rowToExclusion) });
}));

export const clientsExclusionsLookupHandler = nativeRoutes(route("POST", "/clients/exclusions/bulk", async (_p, call) => clientBulk(bodyOf(call))));

export const accountExclusionsLookupHandler = nativeRoutes(route("POST", "/clients/account-exclusions/bulk", async (_p, call) => {
  const { accountIds } = bulkAccountBodySchema.parse(bodyOf(call));
  const uniqueIds = [...new Set(accountIds)];
  const rows = await prisma.$queryRawUnsafe<AccountRow[]>(
    `SELECT ${ACCOUNT_COLUMNS} FROM trade_request.account_exclusions WHERE account_id = ANY($1::varchar[]) ORDER BY account_id, kind, ticker`,
    uniqueIds,
  );
  const grouped: Record<string, ReturnType<typeof rowToAccountExclusion>[]> = {};
  for (const id of uniqueIds) grouped[id] = [];
  for (const row of rows) grouped[row.account_id]!.push(rowToAccountExclusion(row));
  return ok({ data: grouped });
}));

/** The export's lookups: the client bulk read AOA's export sends (export.ts:46), and the firm-wide export route. */
export const exportExclusionsHandler = nativeRoutes(
  route("POST", "/clients/exclusions/bulk", async (_p, call) => clientBulk(bodyOf(call))),
  route("GET", "/clients/exclusions/export", async () => firmWideExport()),
);
