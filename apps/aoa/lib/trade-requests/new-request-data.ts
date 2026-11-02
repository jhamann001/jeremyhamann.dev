import "server-only";
import { callTradeRequestService } from "./client";
import {
  NEW_REQUEST_COPY,
  type HouseholdAccount,
  type HouseholdResolution,
  type HouseholdResolveResult,
  type NewRequestClient,
  type NewRequestClientsLoad,
  type NewRequestHouseholdsLoad,
} from "./new-request";

export type { NewRequestClientsLoad, NewRequestHouseholdsLoad };

const record = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));

function normaliseClients(body: unknown): NewRequestClient[] | null {
  if (!record(body) || !Array.isArray(body.data)) return null;
  return body.data.filter(record).map((client) => ({
    id: text(client.id),
    name: text(client.name),
    accounts: (Array.isArray(client.accounts) ? client.accounts : []).filter(record).map((account) => ({
      id: text(account.id),
      accountNumber: text(account.accountNumber),
      accountType: text(account.accountType),
      balance: Number(account.balance) || 0,
    })),
  }));
}

export async function readNewRequestClients(): Promise<NewRequestClientsLoad> {
  const result = await callTradeRequestService<unknown>({
    operation: "clientList", method: "GET", path: "/clients", defaultMessage: NEW_REQUEST_COPY.loadFailedDefault,
  });
  if (!result.ok) return { ok: false, outcome: result.outcome, message: result.message };
  const clients = normaliseClients(result.data);
  if (!clients) return { ok: false, outcome: "failed", message: NEW_REQUEST_COPY.loadFailedDefault };
  return { ok: true, clients };
}

function normaliseHouseholds(body: unknown): HouseholdResolveResult | null {
  if (!record(body) || !record(body.data) || !Array.isArray(body.data.households)) return null;
  const households: HouseholdResolution[] = [];
  for (const entry of body.data.households) {
    if (!record(entry) || typeof entry.householdId !== "number") return null;
    const accounts: HouseholdAccount[] = (Array.isArray(entry.accounts) ? entry.accounts : []).filter(record).map((account) => ({
      accountId: text(account.accountId),
      accountNumber: typeof account.accountNumber === "string" && account.accountNumber ? account.accountNumber : null,
      accountTitle: text(account.accountTitle),
      clientId: typeof account.clientId === "string" && account.clientId ? account.clientId : null,
    }));
    households.push({
      householdId: entry.householdId,
      householdName: text(entry.householdName),
      accounts,
      selectedAccountIds: Array.isArray(entry.selectedAccountIds) ? entry.selectedAccountIds.map(text) : [],
      clientIds: Array.isArray(entry.clientIds) ? entry.clientIds.map(text) : [],
    });
  }
  return { households };
}

/** 503 is the service's "no firm household on file"; any other failure leaves the form unchanged. */
export async function resolveNewRequestHouseholds(clientIds: string[], accountIds: string[]): Promise<NewRequestHouseholdsLoad> {
  const result = await callTradeRequestService<unknown>({
    operation: "householdResolve", method: "GET", path: "/households/resolve",
    query: {
      clientIds: clientIds.length > 0 ? clientIds.join(",") : undefined,
      accountIds: accountIds.length > 0 ? accountIds.join(",") : undefined,
    },
    defaultMessage: "household_lookup_failed",
  });
  if (!result.ok) return result.outcome === "failed" && result.status === 503 ? { households: [] } : null;
  return normaliseHouseholds(result.data);
}
