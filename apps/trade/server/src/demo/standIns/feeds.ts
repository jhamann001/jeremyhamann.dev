// What the outside systems would report about the synthetic firm on a given day: the clearing firm's
// warehouse rows (contacts, accounts, balances, positions, tax lots) and the model provider's feeds
// (templates, active accounts, transitions). Everything is derived from the universe, so it agrees with
// the demo seed.
//
// The universe holds every account exactly on its model. To give the drift screens something to show,
// positions here add a small daily market walk plus a few scenarios that match the seeded stories:
//   - Okafor: an in-kind transfer of a Edward Jones fund, sold to cash two days ago and waiting on the
//     rebalance request that is pending review (uninvested).
//   - a handful of accounts that have drifted overweight in stocks or bonds (out of tolerance).
//   - one funded account the model provider hasn't picked up yet (funded but unmapped).

import {
  BUCKET, accountTitle, accountUlid, clearingAccountType, clientIds, demoUniverse, hash, ownershipType, residenceFor, riskFor, seeded,
  type Universe, type UniverseAccount, type UniverseHousehold, type UniverseModel,
} from '../universe.js';

const DAY_MS = 86_400_000;

// ─── Clock ────────────────────────────────────────────────────

// The day the stand-ins report as "today". The demo reset steps it back one day at a time to build
// drift history, then clears it.
let dateOverride: Date | null = null;
export function setStandInDate(date: Date | null): void {
  dateOverride = date;
}
export const standInNow = (): Date => dateOverride ?? new Date();

export const standInUniverse = (): Universe => demoUniverse();

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const compactDay = (d: Date) => isoDay(d).replace(/-/g, '');
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Deterministic value in [-1, 1) for a key. */
const unit = (key: string) => seeded(key) * 2 - 1;

/** Whole days between `date` and today (0 for today, 1 for yesterday...). */
function daysBack(date: Date): number {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.max(0, Math.round((today - day) / DAY_MS));
}

/** The clearing firm's business date for a feed produced on `date`: the previous weekday. */
export function businessDate(date: Date): Date {
  const d = new Date(date.getTime() - DAY_MS);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setTime(d.getTime() - DAY_MS);
  return d;
}

/** The weekly snapshot is Friday-dated and loads on Sunday: the newest Friday whose Sunday load is done. */
export function weeklySnapshot(date: Date): Date {
  const d = new Date(date.getTime() - 2 * DAY_MS);
  while (d.getUTCDay() !== 5) d.setTime(d.getTime() - DAY_MS);
  return d;
}

/** Weekday runs after `date` up to today: 0 for today's run, 1 for the previous weekday's, and so on. */
function weekdaysBack(date: Date): number {
  let n = 0;
  for (let i = daysBack(date) - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}

// The daily loader stalled last week. Its data is normally one day old; the 7th weekday run back saw it
// three days old (the app warns at 3) and the 6th four days old (critical at 4); on time since.
// Extra days of lag, by weekday runs back.
const STALL_LAG: Record<number, number> = { 7: 2, 6: 3 };
const dailyLag = (date: Date) => 1 + (STALL_LAG[weekdaysBack(date)] ?? 0);

// ─── Positions ───────────────────────────────────────────────

export interface Position { symbol: string; quantity: number; price: number; value: number }
export interface AccountState {
  account: UniverseAccount;
  household: UniverseHousehold;
  ulid: string;
  positions: Position[];
  /** Uninvested settlement cash at the clearing firm, outside any fund. */
  settlementCash: number;
  /** False for the account the model provider hasn't picked up yet. */
  mapped: boolean;
}

// Daily price swing by asset class (fraction of price).
const DAILY_SWING: Record<string, number> = {
  'us-equity': 0.011, 'intl-equity': 0.012, 'real-estate': 0.014,
  'us-bond': 0.003, treasury: 0.002, 'corporate-bond': 0.003, 'muni-bond': 0.002, cash: 0,
};

/** Price on `k` days back, relative to today's universe price, as a seeded random walk. */
function priceFactor(symbol: string, assetClass: string, k: number): number {
  let f = 1;
  for (let j = 0; j < k; j++) f /= 1 + (DAILY_SWING[assetClass] ?? 0.01) * unit(`${symbol}:${j}`);
  return f;
}

interface Scenarios { overweightEquity: Set<string>; overweightFixed: Set<string>; okaforTransfer: string | null; unmapped: string | null }

function scenarios(u: Universe): Scenarios {
  const generated = u.accounts.filter((a) => !u.households.find((h) => h.id === a.household)?.story);
  const okafor = u.accounts.find((a) => a.household === 'okafor' && (a.type === 'joint-taxable' || a.type === 'individual'));
  // One draw per account keeps the two overweight groups apart: about 7% drift into stocks, 4% into bonds.
  const draw = (a: UniverseAccount) => seeded(`scenario:${a.id}`);
  return {
    overweightEquity: new Set(generated.filter((a) => draw(a) < 0.07).map((a) => a.id)),
    overweightFixed: new Set(generated.filter((a) => draw(a) >= 0.07 && draw(a) < 0.11).map((a) => a.id)),
    okaforTransfer: okafor?.id ?? null,
    unmapped: generated.length ? generated[generated.length - 1].id : null,
  };
}

/** Move `shift` (a fraction of the account) out of one set of buckets and into another, pro rata. */
function tilt(positions: Position[], bucketOf: (s: string) => string, into: string, shift: number): void {
  const total = positions.reduce((t, p) => t + p.value, 0);
  const donors = positions.filter((p) => bucketOf(p.symbol) !== into);
  const takers = positions.filter((p) => bucketOf(p.symbol) === into);
  const donorTotal = donors.reduce((t, p) => t + p.value, 0);
  const takerTotal = takers.reduce((t, p) => t + p.value, 0);
  const amount = Math.min(shift * total, donorTotal * 0.9);
  if (amount <= 0 || takerTotal <= 0) return;
  for (const p of donors) p.value -= (amount * p.value) / donorTotal;
  for (const p of takers) p.value += (amount * p.value) / takerTotal;
  for (const p of positions) {
    p.value = round2(p.value);
    p.quantity = p.price === 1 ? p.value : Math.round((p.value / p.price) * 1000) / 1000;
  }
}

export function accountStates(date: Date = standInNow(), u: Universe = standInUniverse()): AccountState[] {
  const k = daysBack(date);
  const security = new Map(u.securities.map((s) => [s.symbol, s]));
  const bucketOf = (symbol: string) => BUCKET[security.get(symbol)?.assetClass ?? ''] ?? 'equity';
  const s = scenarios(u);
  const households = new Map(u.households.map((h) => [h.id, h]));

  return u.accounts.map((account) => {
    let positions: Position[] = u.holdings
      .filter((h) => h.account === account.id)
      .map((h) => {
        const sec = security.get(h.symbol);
        const f = priceFactor(h.symbol, sec?.assetClass ?? 'us-equity', k);
        const price = round2((sec?.price ?? 1) * f) || 1;
        const quantity = h.quantity;
        return { symbol: h.symbol, quantity, price, value: round2(quantity * price) };
      });
    let settlementCash = round2(account.value * 0.001 * (hash(`cash:${account.id}`) % 4));

    // Each overweight starts on its own day in the last week and a half and builds over three days to
    // 6.5 to 11 points, so accounts cross the 5-point tolerance one or two at a time.
    const onset = 1 + Math.floor(seeded(`onset:${account.id}`) * 9);
    const shift = Math.min(1, Math.max(0, (onset - k) / 3)) * (0.065 + 0.045 * seeded(`size:${account.id}`));
    if (s.overweightEquity.has(account.id)) tilt(positions, bucketOf, 'equity', shift);
    if (s.overweightFixed.has(account.id)) tilt(positions, bucketOf, 'fixed', shift);

    if (account.id === s.okaforTransfer) {
      // The transferred-in fund until it was sold two days ago; the cash has sat uninvested since.
      const lk = security.get('BBGLX');
      if (k > 2 && lk) {
        const price = round2(lk.price * priceFactor('BBGLX', 'us-equity', k));
        const quantity = Math.round((account.value / lk.price) * 1000) / 1000;
        positions = [{ symbol: 'BBGLX', quantity, price, value: round2(quantity * price) }];
        settlementCash = 0;
      } else {
        positions = [];
        settlementCash = account.value;
      }
    }

    return {
      account,
      household: households.get(account.household)!,
      ulid: accountUlid(account.id),
      positions,
      settlementCash,
      mapped: account.id !== s.unmapped,
    };
  });
}

const accountTotal = (a: AccountState) => round2(a.positions.reduce((t, p) => t + p.value, 0) + a.settlementCash);

// ─── Warehouse: saved questions ───────────────────────────────────────

export function contactRows(u: Universe = standInUniverse()): Record<string, unknown>[] {
  const ids = clientIds(u);
  const rows: Record<string, unknown>[] = u.households.map((h) => ({
    cedar_ridge_user_id__c: ids.get(h.id), name: h.name, crm__primary_entity_stage__c: 'Client',
  }));
  // The CRM also holds prospects; the app keeps only clients.
  rows.push({ cedar_ridge_user_id__c: 'PR-2001', name: 'Hollis Family', crm__primary_entity_stage__c: 'Prospect' });
  return rows;
}

export function investmentRows(u: Universe = standInUniverse()): Record<string, unknown>[] {
  const ids = clientIds(u);
  return u.accounts.map((a) => ({
    user_id: ids.get(a.household),
    custodian_account_number: a.number,
    custodian_account_id: accountUlid(a.id),
    account_type: clearingAccountType(a),
  }));
}

export function balanceRows(date: Date = standInNow()): Record<string, unknown>[] {
  const asOf = `${isoDay(businessDate(date))}T21:00:00.000Z`;
  return accountStates(date).map((a) => ({
    account_id: a.ulid, total_equity: accountTotal(a), cash_equity: a.settlementCash, snapshot_timestamp: asOf,
  }));
}

// The clearing firm's asset types by vehicle. Money funds report as mutual funds priced at $1.00.
const ASSET_TYPE: Record<string, string> = { etf: 'ETF', 'mutual-fund': 'MUTUAL_FUND', 'money-market': 'MUTUAL_FUND', stock: 'EQUITY' };

export function stockRecordRows(date: Date = standInNow()): Record<string, unknown>[] {
  const u = standInUniverse();
  const security = new Map(u.securities.map((s) => [s.symbol, s]));
  const business = isoDay(businessDate(date));
  return accountStates(date).flatMap((a) =>
    a.positions.map((p) => {
      const sec = security.get(p.symbol);
      const assetType = ASSET_TYPE[sec?.vehicle ?? ''] ?? 'ETF';
      return {
        account_id: a.ulid, symbol: p.symbol, trade_position_value: p.value, business_date: business,
        asset_type: assetType, closing_price: p.price, symbol_description: sec?.name ?? p.symbol,
      };
    }),
  );
}

// ─── Warehouse: SQL answers ──────────────────────────────────────────

export function ownershipRows(): Record<string, unknown>[] {
  return standInUniverse().accounts.map((a) => ({ account_id: accountUlid(a.id), ownership_type: ownershipType(a) }));
}

export function accountTitleRows(): Record<string, unknown>[] {
  const u = standInUniverse();
  return u.accounts.map((a) => ({ account_id: accountUlid(a.id), title: accountTitle(u, a).split(' - ')[0].toUpperCase() }));
}

export function openLotProbe(date: Date = standInNow()): Record<string, unknown> {
  const full = weeklySnapshot(date);
  // The daily table loads T-1 every day (about 11:00 Eastern); while stalled it stays where it stopped.
  const daily = new Date(date.getTime() - dailyLag(date) * DAY_MS);
  return {
    full_refresh_latest: isoDay(full),
    full_gluerun_latest: `${isoDay(new Date(full.getTime() + 2 * DAY_MS))}T15:02:00.000Z`,
    daily_refresh_latest: isoDay(daily),
    daily_gluerun_latest: `${isoDay(daily)}T15:02:00.000Z`,
  };
}

export const closedLotProbe = (date: Date = standInNow()) => ({ closed_full_latest: isoDay(weeklySnapshot(date)) });

/** Open tax lots behind each non-cash position: one to three lots, mostly long-term gains. */
export function openLotRows(date: Date = standInNow()): Record<string, unknown>[] {
  const u = standInUniverse();
  const isCash = (symbol: string) => u.securities.find((s) => s.symbol === symbol)?.assetClass === 'cash';
  const processDate = isoDay(weeklySnapshot(date));
  const rows: Record<string, unknown>[] = [];
  for (const a of accountStates(date)) {
    for (const p of a.positions) {
      if (isCash(p.symbol)) continue;
      const lots = 1 + (hash(`lots:${a.ulid}:${p.symbol}`) % 3);
      const transferred = p.symbol === 'BBGLX';
      for (let i = 0; i < lots; i++) {
        const key = `${a.ulid}:${p.symbol}:${i}`;
        const quantity = Math.round((p.quantity / lots) * 1000) / 1000;
        const gain = 0.12 + 0.22 * unit(`gain:${key}`); // between -10% and +34%
        const shortTerm = hash(`term:${key}`) % 5 === 0;
        rows.push({
          open_lot_id: `OL-${hash(key).toString(36).toUpperCase()}`,
          process_date: processDate,
          account_id: a.ulid,
          symbol: p.symbol,
          quantity,
          term: shortTerm ? 'SHORT_TERM' : 'LONG_TERM',
          acquisition_event_type: transferred ? 'TRANSFER_EXTERNAL' : 'BUY',
          acquisition_adjusted_net: round2((p.value / lots) * (1 - gain)),
          // The delivering firm sent no basis for one of the transferred lots.
          acquisition_true_zero_cost_indicator: transferred && i === 0 ? 'Y' : 'N',
          wash_sale_adjustment: 0,
          open_closed_indicator: 'OPEN',
        });
      }
    }
  }
  return rows;
}

/** Year-to-date realized gains for about a third of taxable accounts, plus the Okafor sale. */
export function realizedGainRows(date: Date = standInNow()): Record<string, unknown>[] {
  const s = scenarios(standInUniverse());
  return accountStates(date)
    .filter((a) => ownershipType(a.account) !== 'RETIREMENT' && (hash(`rg:${a.account.id}`) % 3 === 0 || a.account.id === s.okaforTransfer))
    .map((a) => {
      const sold = a.account.id === s.okaforTransfer && daysBack(date) <= 2;
      const st = sold ? 2_140 : round2(a.account.value * 0.004 * unit(`rg-st:${a.account.id}`));
      const lt = sold ? 18_420 : round2(a.account.value * 0.012 * (1 + unit(`rg-lt:${a.account.id}`)));
      return { account_id: a.ulid, realized_gain_ytd: round2(st + lt), realized_st_ytd: st, realized_lt_ytd: lt };
    });
}

// ─── Model provider feeds ─────────────────────────────────────────────

const RESIDENCE_LABEL: Record<string, string> = { NY: 'New York', CA: 'California', Other: 'National' };

function templateName(a: UniverseAccount, h: UniverseHousehold, model: UniverseModel): string {
  const retirement = ownershipType(a) === 'RETIREMENT';
  const risk = riskFor(h);
  return retirement
    ? `IRA - Risk ${risk} - ${model.name}`
    : `Taxable - ${RESIDENCE_LABEL[residenceFor(h.id)]} - Risk ${risk} - ${model.name}`;
}

export function templatesFeed(date: Date = standInNow()): Record<string, unknown> {
  const u = standInUniverse();
  const models = new Map(u.models.map((m) => [m.id, m]));
  const states = accountStates(date).filter((a) => a.mapped);
  const accounts = states.map((a) => {
    const model = models.get(a.household.model)!;
    const modelIndex = u.models.indexOf(model);
    return {
      account_id: 40_001 + u.accounts.indexOf(a.account),
      account_title: accountTitle(u, a.account),
      external_account_no: a.ulid,
      master_id: 'CEDAR_RIDGE',
      templates: [{
        template_id: 500 + modelIndex * 40 + riskFor(a.household),
        template_name: templateName(a.account, a.household, model),
        is_levered: 0,
        tolerance: 0.05,
        constituents: Object.entries(model.weights).map(([symbol, w]) => ({
          security: symbol, securityType: 'IndividualSecurity', security_name: symbol, alloc_pct: round2(w * 100),
        })),
      }],
    };
  });
  return {
    generated_at: `${isoDay(date)}T05:00:00.000Z`,
    firm_id: 'cedar-ridge',
    account_count: accounts.length,
    raw_row_count: accounts.reduce((t, a) => t + a.templates[0].constituents.length, 0),
    template_count: new Set(accounts.map((a) => a.templates[0].template_id)).size,
    accounts,
  };
}

export function activeAccountsFeed(date: Date = standInNow()): Record<string, unknown> {
  const u = standInUniverse();
  const models = new Map(u.models.map((m) => [m.id, m]));
  const accounts = accountStates(date)
    .filter((a) => a.mapped)
    .map((a) => {
      const cash = round2(a.settlementCash + a.positions.filter((p) => BUCKET[u.securities.find((s) => s.symbol === p.symbol)?.assetClass ?? ''] === 'cash').reduce((t, p) => t + p.value, 0));
      const total = accountTotal(a);
      return {
        account_id: 40_001 + u.accounts.indexOf(a.account),
        trading_account_no: a.ulid,
        account_title: accountTitle(u, a.account),
        account_type: ownershipType(a.account) === 'RETIREMENT' ? 'NA non-taxable' : 'NA',
        cash,
        equity: round2(total - cash),
        total,
        household_id: 3_001 + u.households.indexOf(a.household),
        household_name: a.household.name,
        sleeves: [],
        associations: [`${models.get(a.household.model)?.name ?? 'Model'} - Risk ${riskFor(a.household)}`],
      };
    });
  return { generated_at: `${isoDay(date)}T05:00:00.000Z`, firm_id: 'cedar-ridge', account_count: accounts.length, raw_row_count: accounts.length, accounts };
}

/** The Okafor transition plan: move the transferred-in fund to the household's model under a gain budget. */
export function transitionsFeed(date: Date = standInNow()): Record<string, unknown> {
  const u = standInUniverse();
  const s = scenarios(u);
  const account = u.accounts.find((a) => a.id === s.okaforTransfer);
  if (!account) return { transitions: [] };
  const model = u.models.find((m) => m.id === u.households.find((h) => h.id === account.household)?.model);
  const drafted = new Date(date.getTime() - 9 * DAY_MS);
  const approved = new Date(date.getTime() - 4 * DAY_MS);
  const base = {
    external_account_no: accountUlid(account.id),
    title: accountTitle(u, account),
    req_body: { target_portfolio_name: model?.name ?? 'Model', target_portfolio_type: 'MODEL', source_pnl: { net_pnl: 20_560, st_gains: 2_140, lt_gains: 18_420 } },
  };
  return {
    transitions: [
      { ...base, state: 'DRAFT', runtime_status: 'NOT_STARTED', updated_timestamp: drafted.toISOString() },
      { ...base, state: 'APPROVED', runtime_status: daysBack(date) <= 2 ? 'COMPLETED' : 'IN_PROGRESS', updated_timestamp: approved.toISOString() },
    ],
  };
}

/** Feed files as the model provider writes them: one of each per day, named by date. */
export function feedFileNames(date: Date = standInNow(), days = 3): string[] {
  const names: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = compactDay(new Date(date.getTime() - i * DAY_MS));
    names.push(`templates_${d}.json`, `active_accounts_${d}.json`, `transitions_${d}.json`);
  }
  return names;
}

/** The content of one feed file, or null for a name the provider never writes. */
export function feedFile(name: string): string | null {
  const m = /^(templates|active_accounts|transitions)_(\d{4})(\d{2})(\d{2})\.json$/.exec(name);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), 12));
  const body = m[1] === 'templates' ? templatesFeed(date) : m[1] === 'active_accounts' ? activeAccountsFeed(date) : transitionsFeed(date);
  return JSON.stringify(body);
}
