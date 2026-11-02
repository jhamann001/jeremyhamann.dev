import { z } from "zod";
import { listRequestsForClientIds, type NativeTradeRequest } from "./requests";
import { getMachineAccountIdMap, machineAccountIdentityConfigured } from "./sources";
import type { NativeResponse } from "./http";

// The Client Portrait's redacted projection, ported from trade-request d41b6c9
// server/src/routes/machine.ts:11-322 (GET /api/machine/trade-requests).

const CEDAR_RIDGE_USER_ID = z.string().regex(/^user-[0-9a-f-]{36}$/, "must be a user-<uuid> cedar_ridge_user_id");
const querySchema = z
  .object({ cedar_ridge_user_id: CEDAR_RIDGE_USER_ID.optional(), cedar_ridge_user_ids: z.string().max(2000).optional() })
  .refine((q) => q.cedar_ridge_user_id || q.cedar_ridge_user_ids, { message: "cedar_ridge_user_id or cedar_ridge_user_ids is required" });

export function maskAccount(n: string): string {
  const s = (n ?? "").trim();
  if (!s) return "";
  return s.length <= 4 ? "****" : `****${s.slice(-4)}`;
}

export function canonicalAccountNumber(value: string): string | null {
  const withoutAmount = (value ?? "").trim().replace(/\s*\(\s*\$[\d,]+(?:\.\d{1,2})?\s*\)\s*$/, "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(withoutAmount)) return null;
  return withoutAmount;
}

type Metadata = { accountNumber: string; accountType: string | null; balance: number; accountId?: string | null };
const metadataOf = (tr: NativeTradeRequest) => (tr.accountMetadata ?? []) as Metadata[];

function requestAccountNumbers(tr: NativeTradeRequest): string[] {
  const metadataNumbers = metadataOf(tr).map((a) => canonicalAccountNumber(a.accountNumber)).filter((n): n is string => n != null);
  const source = metadataNumbers.length > 0
    ? metadataNumbers
    : (tr.selectedAccounts ?? []).map(canonicalAccountNumber).filter((n): n is string => n != null);
  return [...new Set(source)];
}

function unresolvedAccountNumbers(tr: NativeTradeRequest): string[] {
  const persisted = metadataOf(tr);
  if (persisted.length === 0) return requestAccountNumbers(tr);
  return persisted.filter((a) => a.accountId == null).map((a) => canonicalAccountNumber(a.accountNumber)).filter((n): n is string => n != null);
}

const formatPercent = (value: number) => `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;

function profileDecisionAt(tr: NativeTradeRequest): string {
  const approval = tr.auditLog.find((e) => e.action === "Status changed to Approved");
  const completion = tr.auditLog.find((e) => e.action === "Status changed to Completed");
  return approval?.date ?? completion?.date ?? tr.updatedAt ?? tr.date;
}

type Esg = { fossilFuels: boolean; tobacco: boolean; weapons: boolean; alcohol: boolean; gambling: boolean; other: boolean; otherDescription: string; none: boolean };
type Strategy = { benchmark: string; allocation: number };

function activeEsgRestrictions(esg: Esg): string[] {
  if (esg.none) return [];
  const out: string[] = [];
  if (esg.fossilFuels) out.push("Fossil fuels");
  if (esg.tobacco) out.push("Tobacco");
  if (esg.weapons) out.push("Weapons");
  if (esg.alcohol) out.push("Alcohol");
  if (esg.gambling) out.push("Gambling");
  if (esg.other) out.push(esg.otherDescription.trim() || "Other ESG restriction");
  return out;
}

function toMachineTradeProfile(tr: NativeTradeRequest) {
  const qualifies = (tr.status === "Approved" || tr.status === "Completed") && (tr.tradeType === "Initial Funding" || tr.tradeType === "Rebalance");
  if (!qualifies) return null;
  const instructions: Array<{ key: string; label: string; value: string }> = [];
  const allocation = tr.baseAllocation;
  if (allocation.equity + allocation.fixed + allocation.cash > 0) {
    instructions.push({
      key: "target_allocation", label: "Target allocation",
      value: `${formatPercent(allocation.equity)} equity · ${formatPercent(allocation.fixed)} fixed income · ${formatPercent(allocation.cash)} cash`,
    });
  }
  const strategies = (tr.equityStrategies as Strategy[])
    .filter((s) => s.benchmark.trim() && s.allocation > 0)
    .map((s) => `${s.benchmark.trim()} ${formatPercent(s.allocation)}`);
  if (strategies.length > 0) {
    instructions.push({ key: "equity_strategy", label: strategies.length === 1 ? "Equity strategy" : "Equity strategies", value: strategies.join(" · ") });
  }
  if (tr.residence === "CA" || tr.residence === "NY") {
    instructions.push({ key: "tax_preference", label: "Tax preference", value: tr.residence === "CA" ? "California municipal preference" : "New York municipal preference" });
  }
  const restrictions = activeEsgRestrictions(tr.esgFilters as Esg);
  const advisorExclusions = tr.advisorExclusions.trim();
  const clientExclusions = tr.clientExclusions.trim();
  if (advisorExclusions) restrictions.push(`Advisor: ${advisorExclusions}`);
  if (clientExclusions) restrictions.push(`Client: ${clientExclusions}`);
  instructions.push({ key: "restrictions", label: "Restrictions", value: restrictions.length > 0 ? restrictions.join(" · ") : "None" });
  return { decidedAt: profileDecisionAt(tr), riskScore: tr.riskProfile, instructions };
}

const resolvedAccountId = (byNumber: Readonly<Record<string, string>>, n: string) => (Object.hasOwn(byNumber, n) ? (byNumber[n] ?? null) : null);

export function toMachineTradeRequest(tr: NativeTradeRequest, accountIdByNumber: Readonly<Record<string, string>> = {}) {
  const persisted = metadataOf(tr);
  const accounts = persisted.length > 0
    ? persisted.flatMap((account) => {
        const persistedNumber = account.accountNumber.trim();
        if (!persistedNumber) return [];
        const accountNumber = canonicalAccountNumber(persistedNumber) ?? persistedNumber;
        return [{
          accountId: account.accountId ?? resolvedAccountId(accountIdByNumber, accountNumber),
          accountNumber: maskAccount(accountNumber), accountType: account.accountType, balance: account.balance,
        }];
      })
    : requestAccountNumbers(tr).map((accountNumber) => ({
        accountId: resolvedAccountId(accountIdByNumber, accountNumber), accountNumber: maskAccount(accountNumber), accountType: null, balance: 0,
      }));
  return {
    id: tr.id, clientId: tr.clientId, clientIds: tr.clientIds, status: tr.status, tradeType: tr.tradeType, priority: tr.priority,
    createdAt: tr.date, updatedAt: tr.updatedAt, totalValue: tr.totalValue, advisor: tr.advisor,
    householdId: tr.householdId ?? null, householdName: tr.householdName ?? null,
    selectedAccounts: (tr.selectedAccounts ?? []).map((v) => maskAccount(canonicalAccountNumber(v) ?? v)),
    accounts, liquidateOption: tr.liquidateOption, liquidationApproval: tr.liquidationApproval, profile: toMachineTradeProfile(tr),
  };
}

/** machine.ts:268-322: the same status and body the machine route answers for these query parameters. */
export async function readNativeTradeRequestProjection(params: URLSearchParams): Promise<NativeResponse> {
  const parsed = querySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return { status: 400, body: { error: "Validation failed", issues: parsed.error.issues } };
  let ids: string[];
  if (parsed.data.cedar_ridge_user_ids) {
    ids = [...new Set(parsed.data.cedar_ridge_user_ids.split(",").map((s) => s.trim()).filter(Boolean))];
    const each = z.array(CEDAR_RIDGE_USER_ID).max(50).safeParse(ids);
    if (!each.success || ids.length === 0) return { status: 400, body: { error: "cedar_ridge_user_ids must be 1-50 user-<uuid> ids" } };
  } else {
    ids = [parsed.data.cedar_ridge_user_id!];
  }
  const requests = await listRequestsForClientIds(ids);
  const accountNumbers = [...new Set(requests.flatMap(unresolvedAccountNumbers))];
  let accountIdByNumber: Record<string, string> = {};
  if (accountNumbers.length > 0 && machineAccountIdentityConfigured()) {
    try {
      accountIdByNumber = await getMachineAccountIdMap(accountNumbers);
    } catch {
      console.warn(JSON.stringify({ event: "trade_request_native_projection_account_resolution_failed", accountCount: accountNumbers.length }));
    }
  }
  return { status: 200, body: JSON.parse(JSON.stringify({ data: requests.map((r) => toMachineTradeRequest(r, accountIdByNumber)) })) };
}
