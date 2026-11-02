// Demo seed part: Trade Requests on the in-app backend. Writes the moved Trade Request records (trade_request.*,
// planned in trade-requests-plan.ts) as the owner login, leaves Trade Requests AOA-served the way the operator's
// cutover does (serving source AOA, the two scheduled senders still with the standalone service, one recorded
// transition), and links the story request that funds a story transfer to that transfer (app.transfer_investment_link),
// as a transfer's follow-up does. Every date is relative to the seed's `now`.

import { changeServingState } from "@/lib/trade-requests/serving-state-admin";
import { insertRows, type Row } from "./batch";
import type { SeedContext } from "./context";
import { planTradeRequests } from "./trade-requests-plan";
import { withOwnTradeRecords } from "./trade-requests-own";
import { demoCuid, demoUuid, storyTradeRequestId, storyTransferId } from "./universe";

/** Story requests that fund a story transfer: request story id → transfer story id. */
const INVESTMENT_LINKS: Record<string, string> = { "TR-1045": "T-298" };

const CUTOVER_ACTOR = "trade-request-cutover";

export async function seedTradeRequests(ctx: SeedContext): Promise<Record<string, number>> {
  const { owner, now, universe } = ctx;
  const plan = withOwnTradeRecords(planTradeRequests(universe), universe);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  // One statement per table (batch.ts). The audit entries, notifications and exclusions take ids derived from what
  // they belong to (the standalone service let the database pick them), so a reset rebuilds the same ids.
  await insertRows(owner, "trade_request.users", plan.users.map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, slack_user_id: u.slackUserId, is_active: true,
    last_login: ago(60 * 24), created_at: ago(60 * 24 * 200),
  })));
  await insertRows(owner, "trade_request.clients", plan.clients.map((c) => ({ id: c.id, name: c.name })));
  await insertRows(owner, "trade_request.accounts", plan.accounts.map((a) => ({
    id: a.id, client_id: a.clientId, account_number: a.accountNumber, account_type: a.accountType, balance: a.balance,
    cash_holding: a.cash, fixed_holding: a.fixed, equity_holding: a.equity,
  })));

  const requests: Row[] = [];
  const auditLogs: Row[] = [];
  const notifications: Row[] = [];
  for (const r of plan.requests) {
    const created = ago(r.createdMinutesAgo);
    const deadline = r.liquidityDeadlineDays == null ? null : isoDay(new Date(created.getTime() + r.liquidityDeadlineDays * 86_400_000));
    requests.push({
      id: r.id, client_id: r.clientId, client_name: r.clientName, client_ids: r.clientIds, client_names: r.clientNames,
      advisor_id: r.advisorId, trade_type: r.tradeType, trade_amount: r.tradeAmount, deposit_account: r.depositAccount,
      rebalance_all: r.rebalanceAll, status: r.status, total_value: r.totalValue, selected_accounts: r.selectedAccounts,
      account_metadata: r.accountMetadata, priority: r.priority, advisor_notes: r.advisorNotes, residence: r.residence,
      liquidation_approval: r.liquidationApproval, risk_profile: r.riskProfile, base_allocation: r.baseAllocation,
      equity_strategies: [], raise_cash_reason: r.raiseCashReason, liquidity_deadline: deadline, liquidate_option: r.liquidateOption,
      execution_plan: null, asset_location_mode: "priority", household_id: r.householdNumber, household_name: r.household.name,
      created_at: created, updated_at: ago(r.updatedMinutesAgo),
    });
    for (const [i, a] of r.audit.entries()) {
      auditLogs.push({
        id: demoUuid(`trade-request-audit:${r.id}:${i}`), request_id: r.id, user_name: a.userName, user_id: a.userId,
        action: a.action, notes: a.notes, channel: "standalone", created_at: ago(a.minutesAgo),
      });
    }
    for (const [i, n] of r.notifications.entries()) {
      const at = ago(n.minutesAgo);
      notifications.push({
        id: demoUuid(`trade-request-notification:${r.id}:${i}`), user_id: n.userId, body: n.body, request_id: r.id,
        created_at: at, read_at: n.read ? at : null,
      });
    }
  }
  await insertRows(owner, "trade_request.trade_requests", requests);
  await insertRows(owner, "trade_request.audit_logs", auditLogs);
  await insertRows(owner, "trade_request.notifications", notifications);
  const audit = auditLogs.length;

  const exclusion = (e: (typeof plan.exclusions)[number], key: string) => ({
    id: demoUuid(`trade-request-exclusion:${e.scope}:${e.key}:${e.ticker}`), [key]: e.key, ticker: e.ticker, kind: e.kind,
    reason: e.reason, no_buy: e.noBuy, no_sell: e.noSell, created_by: e.createdBy, created_by_name: e.createdByName,
    created_at: ago(e.createdMinutesAgo),
  });
  await insertRows(owner, "trade_request.client_exclusions",
    plan.exclusions.filter((e) => e.scope === "client").map((e) => exclusion(e, "client_id")));
  await insertRows(owner, "trade_request.account_exclusions",
    plan.exclusions.filter((e) => e.scope !== "client").map((e) => exclusion(e, "account_id")));

  await insertRows(owner, "trade_request.security_sector", plan.classifications.map((c) => ({
    ticker: c.ticker, source_symbol: c.ticker, name: c.name, source: "manual", resolved: true, attempts: 0, updated_at: now,
    category: c.category, asset_class: c.assetClass, instrument_kind: c.instrumentKind,
  })), "ON CONFLICT (ticker) DO NOTHING");

  // AOA-served, switched by the serving state's one writer as the cutover switches it.
  await changeServingState(owner, { servingSource: "aoa" }, CUTOVER_ACTOR, "cutover: switch to AOA-served");

  let links = 0;
  for (const [tradeStory, transferStory] of Object.entries(INVESTMENT_LINKS)) {
    const request = plan.requests.find((r) => r.storyId === tradeStory);
    if (!request) continue;
    const transferId = storyTransferId(transferStory);
    const [{ found }] = await owner.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM app.transfer WHERE id = ${transferId}) AS found`;
    if (!found) continue;
    const at = ago(Math.max(1, request.createdMinutesAgo - 20));
    await owner.$executeRaw`
      INSERT INTO app.transfer_investment_link (id, transfer_id, linked_investment_request, created_at, updated_at)
      VALUES (${demoCuid(`investment-link:${transferStory}`)}, ${transferId}, ${request.id}, ${at}, ${at})`;
    links++;
  }

  ctx.shared.tradeRequests = {
    stories: new Map(universe.stories.trade.map((s) => [s.id, storyTradeRequestId(s.id)])),
    requests: plan.requests.length,
  };

  return {
    users: plan.users.length,
    clients: plan.clients.length,
    accounts: plan.accounts.length,
    requests: plan.requests.length,
    auditEntries: audit,
    notifications: notifications.length,
    exclusions: plan.exclusions.length,
    classifications: plan.classifications.length,
    investmentLinks: links,
  };
}
