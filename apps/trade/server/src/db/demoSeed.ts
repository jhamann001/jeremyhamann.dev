// Demo data for the public portfolio demo, built from the shared synthetic universe
// (synthetic/out/universe.json). Every record is invented. `resetDemoData` empties the demo tables
// and refills them in one transaction; the CLI (seedFromUniverse.ts) and the nightly reset both call it.
// Timestamps are relative to `now`, so the data always looks current after a reset.

import type { PoolClient } from 'pg';
import type { Account, BaseAllocation, TradeType, RequestStatus, Priority } from '@trade-request/shared';
import { getRiskAllocation } from '@trade-request/shared/allocations';
import { runAssetLocationEngine } from '../services/assetLocationEngine.js';
import {
  ACCOUNT_TYPE, BUCKET, accountUlid, appStaff, clientIds, hash, loadUniverse, residenceFor, riskFor, staffEmail,
  type Universe, type UniverseHousehold, type UniverseTradeStory,
} from '../demo/universe.js';

const requestId = (n: number) => `REQ-${String(n).padStart(8, '0')}`;
const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

// ─── Reset ──────────────────────────────────────────────────────────────────

// Everything visitors can change, plus job output. Reference data (security_sector) and migrations stay.
const DEMO_TABLES = [
  'outbox_messages', 'audit_logs', 'notifications', 'trade_requests', 'account_exclusions', 'client_exclusions', 'accounts', 'clients',
  'position_drift_accounts', 'registry_drift_runs', 'drift_status_overrides', 'drift_alert_sends', 'digest_runs',
  'engine_use_daily', 'engine_use_meta', 'service_mode_changes', 'session',
  'oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_authorization_codes', 'oauth_clients', 'mcp_pending_auth', 'mcp_pats',
  'users',
];

export interface SeedSummary { users: number; clients: number; accounts: number; requests: number; auditEntries: number; notifications: number }

export async function resetDemoData(db: PoolClient, universe: Universe = loadUniverse(), now: Date = new Date()): Promise<SeedSummary> {
  await db.query('BEGIN');
  try {
    await db.query(`TRUNCATE ${DEMO_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await db.query(
      `UPDATE service_mode SET mode = 'active', digest_sender = 'on', drift_sender = 'on',
         mode_changed_at = now(), updated_at = now(), updated_by = 'demo-reset'`,
    );

    // Users: the firm's advisors and traders. Demo sign-in picks one of these.
    const userIds = new Map<string, string>();
    const staff = appStaff(universe);
    for (const s of staff) {
      const email = staffEmail(s);
      const { rows } = await db.query(
        `INSERT INTO users (email, name, role, slack_user_id, is_active, last_login, created_at) VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
        [email, s.name, s.role, slackMemberId(s.id), minutesAgo(now, 60 * 24), minutesAgo(now, 60 * 24 * 200)],
      );
      userIds.set(s.id, rows[0].id);
    }
    const traders = staff.filter((s) => s.role === 'trader').map((s) => userIds.get(s.id)!);

    // Clients (households) and their accounts at the clearing firm, with holdings rolled up by bucket.
    const bucketOf = new Map(universe.securities.map((s) => [s.symbol, BUCKET[s.assetClass] ?? 'equity']));
    const clientId = clientIds(universe);
    for (const h of universe.households) {
      await db.query('INSERT INTO clients (id, name) VALUES ($1,$2)', [clientId.get(h.id), h.name]);
    }
    const accountsByHousehold = new Map<string, Account[]>();
    for (const a of universe.accounts) {
      const totals = { cash: 0, fixed: 0, equity: 0 };
      for (const hd of universe.holdings) if (hd.account === a.id) totals[bucketOf.get(hd.symbol) ?? 'equity'] += hd.value;
      const type = ACCOUNT_TYPE[a.type] ?? 'Taxable';
      await db.query(
        `INSERT INTO accounts (client_id, account_number, account_type, balance, cash_holding, fixed_holding, equity_holding)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [clientId.get(a.household), a.number, type, a.value, round2(totals.cash), round2(totals.fixed), round2(totals.equity)],
      );
      const acct = {
        // The clearing firm's account id: the same id the warehouse stand-in reports for this account.
        id: accountUlid(a.id),
        accountNumber: a.number,
        accountType: type,
        balance: a.value,
        holdings: { cash: round2(totals.cash), fixed: round2(totals.fixed), equity: round2(totals.equity) },
      } as Account;
      accountsByHousehold.set(a.household, [...(accountsByHousehold.get(a.household) ?? []), acct]);
    }

    // Trade requests: the cross-app story records, then a spread of history across other households.
    const hhById = new Map(universe.households.map((h) => [h.id, h]));
    type Plan = { household: UniverseHousehold; type: TradeType; amount: number | null; status: RequestStatus; priority: Priority; ageMin: number; advisor: string; notes: string; n: number };
    const plans: Plan[] = [];
    const STORY_TYPE: Record<string, TradeType> = {
      'raise-cash': 'Raise Cash', 'rebalance-to-model': 'Rebalance', 'model-change': 'Rebalance', 'tax-loss-harvest': 'Liquidate',
    };
    const STORY_STATUS: Record<string, RequestStatus> = {
      new: 'Pending Review', 'in-review': 'Pending Review', approved: 'Approved', executing: 'Pending Current Asset Liquidation', done: 'Completed',
    };
    const STORY_AGE: Record<string, number> = { 'REQ-00001046': 12, 'REQ-00001045': 60, 'REQ-00001043': 180, 'REQ-00001041': 300, 'REQ-00001038': 1440 };
    for (const s of universe.stories.trade) {
      const n = Number(s.id.replace(/\D/g, ''));
      const id = requestId(n);
      plans.push({
        household: hhById.get(s.household)!,
        type: STORY_TYPE[s.type] ?? 'Rebalance',
        amount: s.amount,
        status: STORY_STATUS[s.status] ?? 'Pending Review',
        priority: s.id.endsWith('1046') ? 'Urgent' : 'Standard',
        ageMin: STORY_AGE[id] ?? 600,
        advisor: s.advisor,
        notes: storyNote(s),
        n,
      });
    }
    const TYPES: TradeType[] = ['Rebalance', 'Cash Deposit', 'Raise Cash', 'Initial Funding', 'Rebalance', 'Liquidate'];
    const STATUSES: RequestStatus[] = ['Completed', 'Completed', 'Approved', 'Completed', 'Rejected', 'Needs Info', 'Completed', 'Pending Review'];
    const others = universe.households.filter((h) => !h.story);
    for (let i = 0; i < 15; i++) {
      const h = others[(i * 7) % others.length];
      const type = TYPES[i % TYPES.length];
      plans.push({
        household: h,
        type,
        amount: type === 'Raise Cash' || type === 'Cash Deposit' ? 5_000 * (2 + (hash(h.id + i) % 18)) : null,
        status: STATUSES[i % STATUSES.length],
        priority: i % 5 === 0 ? 'Low' : 'Standard',
        ageMin: 60 * 24 * (2 + i * 3) + (hash(h.id) % 600),
        advisor: h.advisor,
        notes: '',
        n: 1000 + i + 1,
      });
    }

    let auditEntries = 0;
    let notifications = 0;
    for (const p of plans) {
      const id = requestId(p.n);
      const cid = clientId.get(p.household.id)!;
      const accounts = accountsByHousehold.get(p.household.id) ?? [];
      const selected = p.type === 'Raise Cash' || p.type === 'Cash Deposit' || p.type === 'Liquidate' ? accounts.slice(0, 1) : accounts;
      const risk = riskFor(p.household);
      const residence = residenceFor(p.household.id);
      const base: BaseAllocation = getRiskAllocation(risk);
      const totalValue = selected.reduce((t, a) => t + a.balance, 0);
      const created = minutesAgo(now, p.ageMin);
      const advisorId = userIds.get(p.advisor) ?? null;
      const advisorName = universe.staff.find((s) => s.id === p.advisor)?.name ?? 'Advisor';

      let executionPlan = null;
      if ((p.type === 'Rebalance' || p.type === 'Initial Funding') && selected.length) {
        const { plans: engine } = runAssetLocationEngine({
          tradeType: p.type,
          tradeAmount: '',
          depositAccountNumber: '',
          rebalanceAll: true,
          totalValue,
          baseAllocation: base,
          riskProfile: risk,
          clientName: p.household.name,
          accounts: selected,
          equityStrategies: [],
          residence,
          assetLocationMode: 'priority',
        });
        executionPlan = engine;
      }

      await db.query(
        `INSERT INTO trade_requests
          (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, trade_amount, deposit_account,
           rebalance_all, status, total_value, selected_accounts, account_metadata, priority, advisor_notes, residence,
           liquidation_approval, risk_profile, base_allocation, equity_strategies, raise_cash_reason, liquidity_deadline,
           liquidate_option, execution_plan, asset_location_mode, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'priority',$26,$27)`,
        [
          id, cid, p.household.name, JSON.stringify([cid]), JSON.stringify([p.household.name]), advisorId, p.type,
          p.amount != null ? String(p.amount) : null,
          p.type === 'Cash Deposit' ? selected[0]?.accountNumber ?? null : null,
          p.type === 'Rebalance' || p.type === 'Initial Funding',
          p.status, totalValue, selected.map((a) => a.accountNumber),
          JSON.stringify(selected.map((a) => ({ accountId: a.id, accountNumber: a.accountNumber, accountType: a.accountType, balance: a.balance }))),
          p.priority, p.notes || null, residence, p.type === 'Liquidate' ? true : null, risk, JSON.stringify(base), JSON.stringify([]),
          p.type === 'Raise Cash' ? (p.n === 1046 ? 'Home purchase closing' : 'Client distribution') : null,
          p.type === 'Raise Cash' ? isoDay(new Date(created.getTime() + 4 * 86_400_000)) : null,
          p.type === 'Liquidate' ? 'Specific Positions' : null,
          executionPlan ? JSON.stringify(executionPlan) : null,
          created,
          p.status === 'Pending Review' ? created : minutesAgo(now, Math.max(5, p.ageMin - 90)),
        ],
      );

      await audit(db, id, advisorName, advisorId, 'Created Request', p.notes || null, created);
      auditEntries++;
      if (traders.length) {
        for (const t of traders) {
          await db.query('INSERT INTO notifications (user_id, body, request_id, created_at, read_at) VALUES ($1,$2,$3,$4,$5)', [
            t, `New trade request ${id} submitted for ${p.household.name}`, id, created, p.status === 'Pending Review' ? null : created,
          ]);
          notifications++;
        }
      }
      if (p.status !== 'Pending Review') {
        const trader = staff.find((s) => s.role === 'trader');
        const when = minutesAgo(now, Math.max(5, p.ageMin - 90));
        await audit(db, id, trader?.name ?? 'Trader', trader ? userIds.get(trader.id)! : null, `Status changed to ${p.status}`, null, when);
        auditEntries++;
        if (advisorId) {
          await db.query('INSERT INTO notifications (user_id, body, request_id, created_at, read_at) VALUES ($1,$2,$3,$4,$5)', [
            advisorId, `Trade request ${id} status updated to: ${p.status}`, id, when, p.ageMin > 60 * 24 * 7 ? when : null,
          ]);
          notifications++;
        }
      }
    }

    // A few standing exclusions so the exclusions screens have something to show.
    const okafor = clientId.get('okafor');
    const alvarez = clientId.get('alvarez');
    const advisor = staff.find((s) => s.role === 'advisor');
    const advisorId = advisor ? userIds.get(advisor.id) ?? null : null;
    if (okafor) await exclusion(db, 'client_exclusions', 'client_id', okafor, 'NVDA', 'client', 'Concentrated position; client wants to hold, not add', advisorId, advisor?.name, false, true, now);
    if (alvarez) await exclusion(db, 'client_exclusions', 'client_id', alvarez, 'VNQ', 'advisor', 'Already owns rental property; avoid more real estate', advisorId, advisor?.name, true, false, now);
    const firstOkaforAcct = accountsByHousehold.get('okafor')?.[0];
    if (firstOkaforAcct) await exclusion(db, 'account_exclusions', 'account_id', firstOkaforAcct.accountNumber, 'AAPL', 'client', 'Low cost basis; do not sell', advisorId, advisor?.name, false, true, now);

    await addMissingFundClassifications(db, universe, now);

    await db.query('COMMIT');
    return {
      users: userIds.size,
      clients: universe.households.length,
      accounts: universe.accounts.length,
      requests: plans.length,
      auditEntries,
      notifications,
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

// Fund category and asset class by the universe's asset class, as the classification cache stores them.
const FUND_CLASS: Record<string, [string, string]> = {
  'us-equity': ['Large Blend', 'US Equity'],
  'intl-equity': ['Foreign Large Blend', 'Intl Equity'],
  'real-estate': ['Real Estate', 'Real Estate'],
  'us-bond': ['Intermediate Core Bond', 'US Bond'],
  treasury: ['Short Government', 'Short-Term Bond'],
  'corporate-bond': ['Short-Term Bond', 'Short-Term Bond'],
  'muni-bond': ['Muni National Interm', 'Muni Bond'],
  cash: ['Money Market-Taxable', 'Money Market'],
};
const FUND_CLASS_OVERRIDE: Record<string, [string, string]> = {
  AVUV: ['Small Value', 'US Equity'],
  BBGLX: ['Large Growth', 'US Equity'],
  SCHR: ['Intermediate Government', 'US Bond'],
  VMSXX: ['Money Market-Tax-Free', 'Money Market'],
};

/**
 * Reference data: the security classification table was seeded from a list of tickers that doesn't cover
 * every fund in the universe. Add the missing funds so the drift screen's sector breakdown has no
 * "Unclassified" lines. Existing rows are never touched.
 */
async function addMissingFundClassifications(db: PoolClient, universe: Universe, now: Date) {
  for (const sec of universe.securities) {
    const cls = FUND_CLASS_OVERRIDE[sec.symbol] ?? FUND_CLASS[sec.assetClass];
    if (!cls || sec.vehicle === 'stock') continue;
    await db.query(
      `INSERT INTO security_sector (ticker, source_symbol, name, source, resolved, attempts, updated_at, category, asset_class, instrument_kind)
       VALUES ($1, $1, $2, 'manual', true, 0, $3, $4, $5, $6) ON CONFLICT (ticker) DO NOTHING`,
      [sec.symbol, sec.name, now, cls[0], cls[1], sec.vehicle === 'etf' ? 'etf' : 'mutualfund'],
    );
  }
}

function storyNote(s: UniverseTradeStory): string {
  if (s.id.endsWith('1046')) return 'Client is funding a home purchase closing Friday. The wire request is HD-2479 in the help desk.';
  if (s.id.endsWith('1045')) return 'Transfer from Edward Jones settles this week. Rebalance into the Meridian Growth 80/20 model once it lands.';
  if (s.id.endsWith('1038')) return '2026 required minimum distribution.';
  return '';
}

async function audit(db: PoolClient, requestId: string, name: string, userId: string | null, action: string, notes: string | null, at: Date) {
  await db.query(
    `INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel, created_at) VALUES ($1,$2,$3,$4,$5,'standalone',$6)`,
    [requestId, name, userId, action, notes, at],
  );
}

async function exclusion(
  db: PoolClient, table: 'client_exclusions' | 'account_exclusions', keyCol: 'client_id' | 'account_id', key: string, ticker: string,
  kind: 'client' | 'advisor', reason: string, by: string | null, byName: string | undefined, noBuy: boolean, noSell: boolean, now: Date,
) {
  await db.query(
    `INSERT INTO ${table} (${keyCol}, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [key, ticker, kind, reason, noBuy, noSell, by, byName ?? 'Advisor', minutesAgo(now, 60 * 24 * 30)],
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
// Slack member id for a staff member, in Slack's U-prefixed shape. The outbox screen shows the person's name.
export const slackMemberId = (staffId: string) => `U0DEMO${String(hash(staffId) % 100000).padStart(5, '0')}`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
