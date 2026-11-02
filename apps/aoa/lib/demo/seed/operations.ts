// Demo seed part: the warehouse's rows (the account resolver, new funding, held-away holdings, the trade
// reconciliation's two sources), the operations team's fee requests, the held-away account summaries, the employee
// roster, the last few days' saved trade reconciliations, and then the scheduled jobs production runs over all of
// it, once, the way Cloud Scheduler would: CRM identity reconciliation, CRM relationships, the held-away account
// summaries, ACAT auto-linking and the review-queue sweep. It runs last, so the jobs see every other part's records.

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { OPERATIONS_FEE_REQUEST_CREATE, OPERATIONS_FEE_REQUEST_TRANSITION } from "@/lib/audit";
import { runCrmIdentityReconciliation } from "@/lib/crm/reconcile";
import { runCrmRelationshipSnapshot } from "@/lib/crm/relationships";
import { runReviewQueueSweepStep } from "@/lib/data/review-queue-sweep";
import { persistCompletedTradeReconciliation } from "@/lib/data/trade-reconciliation";
import { fetchTradeReconciliationSources } from "@/lib/operations/trade-reconciliation-source";
import { POST as acatLinkSync } from "@/app/api/cron/acat-link-sync/route";
import { POST as linkedAccountSummarySync } from "@/app/api/cron/linked-external-account-summary/route";
import {
  crmIdentityReconciliationEnabled, crmIdentityReconciliationWritesEnabled, crmRelationshipReconciliationEnabled,
  crmRelationshipReconciliationWritesEnabled, reviewQueueMaterializationEnabled,
} from "@/lib/flags";
import { previousTradingDay } from "@/lib/market-calendar";
import { addBusinessDays, businessInstant, firmToday } from "./calendar";
import type { SeedContext, StandInRecord } from "./context";
import { ownAccounts, ownAccountUlid } from "./own-accounts";
import { ACCOUNT_TYPE_LABEL, accountOwners } from "./people";
import {
  accountUlid, accountsOf, demoCuid, demoUuid, membersOf, pick, seeded, seededInt, staffEmail, staffOf, type UniverseAccount,
} from "./universe";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function seedOperations(ctx: SeedContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  Object.assign(counts, await seedWarehouse(ctx));
  Object.assign(counts, await seedHeldAway(ctx));
  counts.feeRequests = await seedFeeRequests(ctx);
  counts.rosterEmployees = await seedEmployeeRoster(ctx);
  counts.reconciliationRuns = await seedReconciliationHistory(ctx);
  Object.assign(counts, await runScheduledJobs(ctx));
  return counts;
}

// --- the warehouse (lib/demo/stand-ins/warehouse.ts answers its saved cards from these) ---

async function seedWarehouse(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe } = ctx;
  const records: StandInRecord[] = [];
  const standIn = (kind: string, id: string, doc: object, position: number) => records.push({ kind, id, doc, position });
  let position = 0;

  // Card 6472, the account resolver: the clearing firm's account behind each account number.
  for (const a of universe.accounts) {
    const owners = accountOwners(universe, a);
    standIn("account", a.number, {
      account_id: accountUlid(a.id),
      apex_acct: a.number,
      account_type: ACCOUNT_TYPE_LABEL[a.type] ?? "Individual",
      account_nickname: null,
      client_name: owners.map((p) => `${p.first} ${p.last}`).join(" & "),
    }, ++position);
  }
  for (const a of ownAccounts(universe)) {
    const owner = universe.people.find((p) => p.id === a.owner)!;
    standIn("account", a.number, {
      account_id: ownAccountUlid(a),
      apex_acct: a.number,
      account_type: ACCOUNT_TYPE_LABEL[a.type] ?? "Individual",
      account_nickname: null,
      client_name: `${owner.first} ${owner.last}`,
    }, ++position);
  }

  // Card 6634, new funding: deposits into a third of the accounts over the last six weeks, and the closing-wire
  // household's recent deposit; mostly ACH, some checks and wires. The second members' own accounts come after the
  // universe's: retirement accounts, so their deposits are ACH contributions within a year's limit. Ada Okafor's SEP
  // IRA always has its contributions (a showcase client, lib/demo/samples).
  let funding = 0;
  for (const a of [...universe.accounts, ...ownAccounts(universe)]) {
    if (seeded(`${a.id}:funded`) > 0.34 && a.id !== "own-okafor-ada") continue;
    const deposits = seededInt(`${a.id}:deposits`, 1, 3);
    for (let i = 0; i < deposits; i++) {
      const key = `${a.id}:deposit:${i}`;
      const day = addBusinessDays(ctx.today, -seededInt(key, 1, 30));
      const method = "owner" in a ? "ACH" : pick(`${key}:method`, ["ACH", "ACH", "ACH", "Check", "Wire"] as const);
      const amount = method === "Wire" ? seededInt(`${key}:amount`, 20, 120) * 1000 : seededInt(`${key}:amount`, 5, 60) * 100;
      const id = `ACT-${String(++funding).padStart(6, "0")}`;
      standIn("funding", id, {
        account_id: accountUlid(a.id),
        activity_id: id,
        activity_date: day,
        settle_date: method === "Check" ? addBusinessDays(day, 2) : day,
        net_amount: amount,
        funding_method: method,
        activity_description: method === "ACH" ? "ACH deposit" : method === "Check" ? "Check deposit" : "Incoming wire",
        source_application_id: method === "ACH" ? `ach-${id.toLowerCase()}` : null,
        generation: 1,
      }, funding);
    }
  }

  // The trade reconciliation's two sources for the last five trading days: the rebalancer's orders and the clearing
  // firm's executions, matched by order id. A few breaks for the operations team: a partial fill, an execution with
  // no order (a manual trade), and an order that never executed.
  const securities = new Map(universe.securities.map((s) => [s.symbol, s]));
  let orders = 0;
  let trades = 0;
  let tradeDay = previousTradingDay(firmToday(ctx.now));
  for (let d = 0; d < 5; d++, tradeDay = previousTradingDay(tradeDay)) {
    const accounts = universe.accounts.filter((a) => seeded(`${a.id}:rebal:${d}`) < 0.12);
    for (const [i, a] of accounts.entries()) {
      const holdings = universe.holdings.filter((h) => h.account === a.id).slice(0, 4);
      for (const [j, h] of holdings.entries()) {
        const security = securities.get(h.symbol);
        if (!security) continue;
        const key = `${tradeDay}:${a.id}:${h.symbol}`;
        const side = seeded(`${key}:side`) < 0.5 ? "BUY" : "SELL";
        const fund = security.vehicle === "mutual-fund";
        const quantity = fund ? round2(seededInt(`${key}:qty`, 20, 400) + 0.5) : seededInt(`${key}:qty`, 5, 120);
        const notional = round2(quantity * security.price);
        const orderId = `RB-${tradeDay.replaceAll("-", "")}-${String(++orders).padStart(4, "0")}`;
        const initiated = businessInstant(tradeDay, key);
        const assetType = fund ? "MUTUAL_FUND" : security.vehicle === "stock" ? "EQUITY" : "ETF";
        const neverExecuted = d === 1 && i === 0 && j === 0;
        standIn("rebalancer_order", orderId, {
          rebalancer_order_id: orderId, apex_account_id: a.number, asset_type: assetType, symbol: h.symbol, side, quantity,
          notional_amount: notional, initiated_timestamp: initiated.toISOString(), client_basket_id: `BSK-${tradeDay}-${i + 1}`,
          apex_basket_id: neverExecuted ? null : `APXB-${tradeDay.replaceAll("-", "")}-${i + 1}`,
        }, orders);
        if (neverExecuted) continue;
        const partial = d === 0 && i === 0 && j === 1;
        const filled = partial ? Math.max(1, Math.floor(quantity / 2)) : quantity;
        const gross = round2(filled * security.price);
        const activityId = `EX-${String(++trades).padStart(6, "0")}`;
        standIn("apex_trade", activityId, {
          activity_id: activityId, process_date: tradeDay, account_id: a.number, asset_type: assetType, symbol: h.symbol,
          side, quantity: filled, net_amount: side === "BUY" ? -gross : gross, gross_amount: gross, client_order_id: orderId,
          activity_time: new Date(initiated.getTime() + 11 * 60_000).toISOString(),
        }, trades);
      }
    }
    if (d === 2) {
      // A manual trade the desk placed outside the rebalancer.
      const a = universe.accounts[7];
      const activityId = `EX-${String(++trades).padStart(6, "0")}`;
      standIn("apex_trade", activityId, {
        activity_id: activityId, process_date: tradeDay, account_id: a.number, asset_type: "ETF", symbol: "VTI", side: "SELL",
        quantity: 40, net_amount: round2(40 * securities.get("VTI")!.price), gross_amount: round2(40 * securities.get("VTI")!.price),
        client_order_id: null, activity_time: businessInstant(tradeDay, `${a.id}:manual`).toISOString(),
      }, trades);
    }
  }
  await ctx.standIns("warehouse", records);
  return { warehouseAccounts: position, fundingDeposits: funding, rebalancerOrders: orders, clearingTrades: trades };
}

// --- held-away accounts linked through Plaid: the warehouse's summary (6898) and holdings (6899) cards ---

const HELD_AWAY = [
  { institution: "Fidelity", subtype: "401k", symbols: [["FXAIX", "Fidelity 500 Index Fund"], ["FTIHX", "Fidelity Total International Index Fund"], ["FXNAX", "Fidelity U.S. Bond Index Fund"]] },
  { institution: "Vanguard", subtype: "403b", symbols: [["VFIAX", "Vanguard 500 Index Admiral"], ["VBTLX", "Vanguard Total Bond Market Index Admiral"]] },
  { institution: "Empower", subtype: "401k", symbols: [["SPY", "SPDR S&P 500 ETF Trust"], ["AGG", "iShares Core U.S. Aggregate Bond ETF"]] },
  { institution: "Charles Schwab", subtype: "brokerage", symbols: [["SCHB", "Schwab U.S. Broad Market ETF"], ["SCHZ", "Schwab U.S. Aggregate Bond ETF"]] },
] as const;

// Held-away accounts that are on a household's prior-custodian statement (universe stories.statements) and have not
// moved yet: Plaid shows the same positions the statement does. The Okafor household's Edward Jones joint account is
// in transfer; its Roth IRA (Ada's) and individual account (Kofi's, the NVDA position the trade desk excludes) follow.
const STATEMENT_HELD_AWAY: Record<string, Array<{ person: string; statement: string; suffix: string; subtype: string }>> = {
  okafor: [
    { person: "okafor-kofi", statement: "s1", suffix: "7802", subtype: "brokerage" },
    { person: "okafor-ada", statement: "s1", suffix: "7790", subtype: "roth" },
  ],
};

async function seedHeldAway(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe, now } = ctx;
  const asOf = new Date(`${previousTradingDay(firmToday(now))}T21:00:00Z`).toISOString();
  const securityName = new Map(universe.securities.map((s) => [s.symbol, s.name]));
  const custodianName = new Map(universe.custodians.map((c) => [c.id, c.name]));
  const records: StandInRecord[] = [];
  const standIn = (kind: string, id: string, doc: object, position: number) => records.push({ kind, id, doc, position });
  let linked = 0;
  for (const h of universe.households) {
    const fromStatement = STATEMENT_HELD_AWAY[h.id];
    if (fromStatement) {
      for (const held of fromStatement) {
        const statement = universe.stories.statements.find((s) => s.id === held.statement);
        const account = statement?.accounts?.find((a) => a.suffix === held.suffix);
        if (!statement || !account) throw new Error(`held-away statement account ${held.statement}#${held.suffix} not found`);
        const externalId = `plaid-${h.id}-${held.subtype}-${held.suffix}`;
        const cash = round2(account.positions.filter((p) => p.symbol === "CASH").reduce((t, p) => t + p.value, 0));
        const rows = account.positions.filter((p) => p.symbol !== "CASH").map((p) => ({
          ticker: p.symbol, security_id: p.symbol, security_name: p.description ?? securityName.get(p.symbol) ?? p.symbol,
          quantity: Number.parseFloat(p.quantity), market_value: p.value,
        }));
        const securities = round2(rows.reduce((t, r) => t + r.market_value, 0));
        linked++;
        standIn("linked_summary", externalId, {
          external_account_id: externalId, client_sf_id: ctx.personId.get(held.person)!, household_sf_id: ctx.householdId.get(h.id)!,
          institution_name: custodianName.get(statement.custodian) ?? statement.custodian, account_subtype: held.subtype, mask: held.suffix,
          cash_amount: cash, securities_amount: securities, holdings_total: securities, institution_balance: round2(securities + cash),
          as_of: asOf, link_status: "ACTIVE", lineage_key: externalId, prior_external_account_id: null,
        }, linked);
        standIn("linked_holdings", externalId, { rows }, linked);
      }
      continue;
    }
    if (!(h.story ? ["brennan", "lindqvist"].includes(h.id) : seeded(`${h.id}:plaid`) < 0.2)) continue;
    const person = membersOf(universe, h.id)[0];
    const kind = HELD_AWAY[seededInt(`${h.id}:plaid-kind`, 0, HELD_AWAY.length - 1)];
    const externalId = `plaid-${h.id}-${kind.subtype}`;
    const rows = kind.symbols.map(([symbol, name], i) => {
      const quantity = seededInt(`${externalId}:${i}:qty`, 40, 900);
      const price = seededInt(`${externalId}:${i}:px`, 4000, 52000) / 100;
      return { ticker: symbol, security_id: symbol, security_name: name, quantity, market_value: round2(quantity * price) };
    });
    const cash = seededInt(`${externalId}:cash`, 200, 9000);
    const securities = round2(rows.reduce((s, r) => s + r.market_value, 0));
    linked++;
    // Card 6898's row (the held-away summary feed reads it overnight) and card 6899's holdings behind it.
    standIn("linked_summary", externalId, {
      external_account_id: externalId, client_sf_id: ctx.personId.get(person.id)!, household_sf_id: ctx.householdId.get(h.id)!,
      institution_name: kind.institution, account_subtype: kind.subtype, mask: String(seededInt(`${externalId}:mask`, 1000, 9999)),
      cash_amount: cash, securities_amount: securities, holdings_total: securities, institution_balance: round2(securities + cash),
      as_of: asOf, link_status: "ACTIVE", lineage_key: externalId, prior_external_account_id: null,
    }, linked);
    standIn("linked_holdings", externalId, { rows }, linked);
  }
  await ctx.standIns("warehouse", records);
  return { heldAwayAccounts: linked };
}

// --- the operations team's fee requests (app/(authenticated)/operations/fee-requests) ---

interface FeePlan {
  household: string;
  kind: "FEE_CREDIT" | "SERVICE_GUARANTEE" | "BILLING_EXCEPTION" | "LARGE_HOUSEHOLD_EXCEPTION";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CREDITED";
  feeTypes: string[];
  amount: number | null;
  reason: string;
  tickets: string[];
  daysAgo: number;
  months?: number;
  indefinite?: boolean;
  by: string;
}

const FEE_REQUESTS: FeePlan[] = [
  { household: "chen-ashby", kind: "FEE_CREDIT", status: "CREDITED", feeTypes: ["ACAT in"], amount: 95, reason: "Edward Jones charged its outgoing transfer fee on the account we moved in; the firm covers it.", tickets: [], daysAgo: 14, by: "jordan-reyes" },
  { household: "alvarez", kind: "FEE_CREDIT", status: "APPROVED", feeTypes: ["ACAT in"], amount: 75, reason: "Schwab's transfer-out fee on the joint account. Reimburse per the transfer policy.", tickets: [], daysAgo: 9, by: "jordan-reyes" },
  { household: "alvarez", kind: "FEE_CREDIT", status: "PENDING", feeTypes: ["Wire"], amount: 25, reason: "Outgoing wire for the home closing. Waive as a courtesy.", tickets: ["HD-2479"], daysAgo: 0, by: "marco-ferreira" },
  { household: "brennan", kind: "SERVICE_GUARANTEE", status: "PENDING", feeTypes: [], amount: null, months: 3, reason: "Client questioned the Q3 fee after a delayed rebalance. Waive the advisory fee for one quarter under the service guarantee.", tickets: ["HD-2474"], daysAgo: 2, by: "marco-ferreira" },
  { household: "patel-trust", kind: "LARGE_HOUSEHOLD_EXCEPTION", status: "APPROVED", feeTypes: [], amount: null, reason: "Trust household above $1M after the Edward Jones transfer; apply the large-household schedule.", tickets: [], daysAgo: 5, indefinite: true, by: "jordan-reyes" },
  { household: "morgan", kind: "BILLING_EXCEPTION", status: "REJECTED", feeTypes: [], amount: null, months: 6, reason: "Requested a six-month billing pause while the BNY transfer completes. Not within policy; the account is billed only on assets held.", tickets: ["HD-2463"], daysAgo: 6, by: "marco-ferreira" },
  { household: "lindqvist", kind: "FEE_CREDIT", status: "CREDITED", feeTypes: ["IRA Maintenance"], amount: 50, reason: "Annual IRA maintenance fee charged in error on the traditional IRA.", tickets: ["HD-2470"], daysAgo: 21, by: "jordan-reyes" },
];

async function seedFeeRequests(ctx: SeedContext): Promise<number> {
  const { universe, owner } = ctx;
  const reviewer = staffOf(universe, "priya-nair");
  // Each table in one statement, in the order the one-at-a-time writes made (the events and the audit log number
  // their rows as they arrive).
  const requests: Prisma.OperationsFeeRequestCreateManyInput[] = [];
  const requestEvents: Prisma.OperationsFeeRequestEventCreateManyInput[] = [];
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  let n = 0;
  for (const plan of FEE_REQUESTS) {
    const person = membersOf(universe, plan.household)[0];
    const accounts = accountsOf(universe, plan.household).filter((a) => accountOwners(universe, a).some((o) => o.id === person.id));
    const chosen: UniverseAccount[] = plan.kind === "FEE_CREDIT" ? accounts.slice(0, 1) : accounts;
    const submitter = staffOf(universe, plan.by);
    const role = "OPERATIONS";
    const submitted = businessInstant(addBusinessDays(ctx.today, -plan.daysAgo), `fee:${n}`);
    const submittedAt = plan.daysAgo === 0 ? ctx.at(ctx.today, `fee:${n}`) : submitted;
    const reviewedAt = plan.status === "PENDING" ? null : new Date(submittedAt.getTime() + 3 * 60 * 60_000);
    const creditedDay = plan.status === "CREDITED" ? addBusinessDays(ctx.today, -(plan.daysAgo - 3)) : null;
    const id = `demo-fee-${String(++n).padStart(3, "0")}`;
    requests.push({
        id,
        kind: plan.kind,
        status: plan.status,
        client_sf_id: ctx.personId.get(person.id)!,
        account_ids: chosen.map((a) => accountUlid(a.id)),
        fee_types: plan.feeTypes,
        fee_amount: plan.amount == null ? null : new Prisma.Decimal(plan.amount),
        // Waivers and exceptions start on the first of next month, for a set number of months or indefinitely.
        waiver_start: plan.kind === "FEE_CREDIT" ? null : new Date(`${firstOfNextMonth(ctx.today)}T00:00:00.000Z`),
        waiver_duration_months: plan.months ?? null,
        indefinite_duration: plan.indefinite ?? false,
        reason: plan.reason,
        relevant_ticket_refs: plan.tickets,
        submitted_by_email: staffEmail(submitter),
        submitted_by_name: submitter.name,
        submitted_by_role: role,
        submitted_at: submittedAt,
        reviewed_by_email: reviewedAt ? staffEmail(reviewer) : null,
        reviewed_by_name: reviewedAt ? reviewer.name : null,
        reviewed_at: reviewedAt,
        credited_at: creditedDay ? new Date(`${creditedDay}T00:00:00.000Z`) : null,
        apex_request_id: creditedDay ? `APX-CR-${4100 + n}` : null,
        completed_by_email: creditedDay ? staffEmail(submitter) : null,
        completed_by_name: creditedDay ? submitter.name : null,
        completed_at: creditedDay ? businessInstant(creditedDay, `fee-credited:${n}`) : null,
        created_at: submittedAt,
    });
    const events: Array<{ action: string; from: string | null; to: string; at: Date; email: string; role: string; detail: object }> = [
      { action: "SUBMITTED", from: null, to: "PENDING", at: submittedAt, email: staffEmail(submitter), role,
        detail: { kind: plan.kind, accountCount: chosen.length, feeTypeCount: plan.feeTypes.length, amountPresent: plan.amount != null, ticketReferenceCount: plan.tickets.length, indefiniteDuration: false } },
    ];
    if (reviewedAt) {
      const decided = plan.status === "REJECTED" ? "REJECTED" : "APPROVED";
      events.push({ action: decided, from: "PENDING", to: decided, at: reviewedAt, email: staffEmail(reviewer), role: "ADMIN",
        detail: plan.status === "REJECTED" ? { note: "Outside the billing policy; explained to the advisor." } : {} });
    }
    if (creditedDay) {
      events.push({ action: "CREDITED", from: "APPROVED", to: "CREDITED", at: businessInstant(creditedDay, `fee-credited:${n}`), email: staffEmail(submitter), role, detail: {} });
    }
    for (const e of events) {
      requestEvents.push({
        request_id: id, action: e.action, actor_email: e.email, actor_role: e.role, from_status: e.from as never, to_status: e.to as never,
        detail: e.detail, at: e.at,
      });
      audit.push({
        at: e.at, actorEmail: e.email, actorRole: e.role,
        action: e.action === "SUBMITTED" ? OPERATIONS_FEE_REQUEST_CREATE : OPERATIONS_FEE_REQUEST_TRANSITION,
        entityType: "operations_fee_request", entityId: id,
        detail: JSON.stringify(e.action === "SUBMITTED" ? e.detail : { action: e.action, fromStatus: e.from, toStatus: e.to }),
      });
    }
  }
  await owner.operationsFeeRequest.createMany({ data: requests });
  await owner.operationsFeeRequestEvent.createMany({ data: requestEvents });
  await owner.auditLog.createMany({ data: audit });
  return FEE_REQUESTS.length;
}

function firstOfNextMonth(day: string): string {
  const next = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 1));
  return next.toISOString().slice(0, 10);
}

// --- the quarterly employee roster (CRM Explorer → Employee roster), applied for the last quarter end ---

async function seedEmployeeRoster(ctx: SeedContext): Promise<number> {
  const { universe, owner } = ctx;
  const today = new Date(`${ctx.today}T00:00:00Z`);
  const quarterEnd = new Date(Date.UTC(today.getUTCFullYear(), Math.floor(today.getUTCMonth() / 3) * 3, 0));
  const effective = quarterEnd.toISOString().slice(0, 10);
  const appliedDay = addBusinessDays(effective, 4);
  const applier = staffEmail(staffOf(universe, "priya-nair"));
  const id = `demo-roster-${effective}`;
  await owner.employeeRosterUpload.create({
    data: {
      id,
      file_sha256: createHash("sha256").update(`roster:${effective}`).digest("hex"),
      effective_date: quarterEnd,
      parser_version: "rippling-v1",
      status: "APPLIED",
      row_count: universe.staff.length,
      employee_count: universe.staff.length,
      dependent_row_count: 0,
      active_count: universe.staff.length,
      former_count: 0,
      uploaded_by: applier,
      applied_by: applier,
      applied_at: businessInstant(appliedDay, "roster:applied"),
      created_at: businessInstant(appliedDay, "roster:uploaded"),
    },
  });
  await owner.employeeRosterEntry.createMany({
    data: universe.staff.map((s, i) => {
      const employeeId = `EMP-${String(101 + i).padStart(4, "0")}`;
      return {
        // Derived from the upload and the employee, so a reset rebuilds the same id.
        id: demoCuid(`roster-entry:${id}:${employeeId}`),
        upload_id: id,
        employee_id: employeeId,
        display_name: s.name,
        source_status: "Active",
        employment_state: "ACTIVE",
        start_date: new Date(`${2019 + (i % 6)}-0${1 + (i % 9)}-15T00:00:00Z`),
        legal_entity: `${universe.firm.name} LLC`,
      };
    }),
  });
  return universe.staff.length;
}

// --- saved trade reconciliations: Jordan ran the three trading days before today (today's is left for a visitor) ---

async function seedReconciliationHistory(ctx: SeedContext): Promise<number> {
  const { universe, owner } = ctx;
  const jordan = { role: "OPERATIONS" as const, email: staffEmail(staffOf(universe, "jordan-reyes")) };
  let runDate = previousTradingDay(firmToday(ctx.now));
  let runs = 0;
  for (; runs < 3; runs++, runDate = previousTradingDay(runDate)) {
    const tradeDate = previousTradingDay(runDate);
    const runId = await persistCompletedTradeReconciliation(jordan, { runDate, tradeDate }, await fetchTradeReconciliationSources(tradeDate));
    await owner.tradeReconciliationRun.update({ where: { id: runId }, data: { completed_at: businessInstant(runDate, `recon:${runDate}`) } });
  }
  return runs;
}

// --- production's scheduled jobs, run once over the seeded data ---

/** Calls a cron route's handler in-process with a one-time token, as Cloud Scheduler calls it over HTTP. */
async function runCron(path: string, handler: (req: Request) => Promise<Response>): Promise<number> {
  const previous = process.env.INGEST_TOKEN;
  const token = randomUUID();
  process.env.INGEST_TOKEN = token;
  try {
    const res = await handler(new Request(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
    return res.status;
  } finally {
    if (previous === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = previous;
  }
}

// Each runs only when its switch is on, as its cron route does (app/api/cron/crm-identity, crm-relationships,
// linked-external-account-summary, acat-link-sync, review-queue). The CRM feeds are complete snapshots here, so the relationship sweep may retire what they omit.
async function runScheduledJobs(ctx: SeedContext): Promise<Record<string, number>> {
  // The CRM jobs take their run id from the caller (the cron route picks a random one); the seed's is the same on
  // every seed of a day, so the audit trail's run ids are too.
  const runId = (job: string) => demoUuid(`${job}:${ctx.today}`);
  const counts = { crmIdentityRuns: 0, crmRelationshipRuns: 0, heldAwaySummaryRuns: 0, acatLinkRuns: 0, reviewQueueSweepSteps: 0 };
  if (crmIdentityReconciliationEnabled() && crmIdentityReconciliationWritesEnabled()) {
    await runCrmIdentityReconciliation(runId("crm-identity"), false);
    counts.crmIdentityRuns = 1;
  }
  if (crmRelationshipReconciliationEnabled() && crmRelationshipReconciliationWritesEnabled()) {
    await runCrmRelationshipSnapshot(runId("crm-relationships"), false, { contact: true, deal: true, transfer: true });
    counts.crmRelationshipRuns = 1;
  }
  // The held-away account summaries, loaded from warehouse card 6898 as the overnight feed loads them.
  await runCron("/api/cron/linked-external-account-summary", linkedAccountSummarySync);
  counts.heldAwaySummaryRuns = 1;
  // ACAT auto-linking: the tracker's records against AoA's transfers, prepared and applied as a review run.
  await runCron("/api/cron/acat-link-sync", acatLinkSync);
  counts.acatLinkRuns = 1;
  if (reviewQueueMaterializationEnabled()) {
    while (counts.reviewQueueSweepSteps < 20) {
      counts.reviewQueueSweepSteps++;
      // Production's scheduler sweeps 40 clients a page (?limit=40): 40 ids fit the Trade Request read's query.
      if ((await runReviewQueueSweepStep({ limit: 40 })).sweep.completed) break;
    }
  }
  return counts;
}
