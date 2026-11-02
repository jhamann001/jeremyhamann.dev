import { prisma } from "@/lib/db";
import { nativeRoutes, ok, route } from "./http";
import {
  getCachedClients, localFeedFallbackAllowed, logFeedUnconfigured, tradeRequestWarehouseConfigured, type SourceClient,
} from "./sources";

// trade-request d41b6c9 server/src/routes/clients.ts:11-86: the cached Warehouse list when configured,
// otherwise the copied client and account records.

type AccountRow = {
  id: string; client_id: string; account_number: string; account_type: SourceClient["accounts"][number]["accountType"];
  balance: string; cash_holding: string; fixed_holding: string; equity_holding: string;
};

export async function recordClients(): Promise<SourceClient[]> {
  const clientRows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
    `SELECT id, name FROM trade_request.clients ORDER BY name`,
  );
  if (clientRows.length === 0) return [];
  const accountRows = await prisma.$queryRawUnsafe<AccountRow[]>(
    `SELECT id::text AS id, client_id, account_number, account_type, balance::text AS balance,
            cash_holding::text AS cash_holding, fixed_holding::text AS fixed_holding, equity_holding::text AS equity_holding
       FROM trade_request.accounts ORDER BY account_number`,
  );
  const byClient = new Map<string, SourceClient["accounts"]>();
  for (const row of accountRows) {
    const list = byClient.get(row.client_id) ?? [];
    list.push({
      id: row.id,
      clientId: row.client_id,
      accountNumber: row.account_number,
      accountType: row.account_type,
      balance: Number(row.balance),
      holdings: { cash: Number(row.cash_holding), fixed: Number(row.fixed_holding), equity: Number(row.equity_holding) },
    });
    byClient.set(row.client_id, list);
  }
  return clientRows.map((c) => ({ id: c.id, name: c.name, accounts: byClient.get(c.id) ?? [] }));
}

const UNAVAILABLE = { status: 502, body: { error: "Account data source is temporarily unavailable. Please try again." } };

export const clientListHandler = nativeRoutes(route("GET", "/clients", async () => {
  if (!tradeRequestWarehouseConfigured()) {
    if (localFeedFallbackAllowed()) return ok({ data: await recordClients() });
    logFeedUnconfigured("clientList");
    return UNAVAILABLE;
  }
  try {
    return ok({ data: await getCachedClients() });
  } catch {
    return UNAVAILABLE;
  }
}));
