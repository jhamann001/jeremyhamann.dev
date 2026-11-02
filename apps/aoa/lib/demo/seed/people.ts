// Demo seed part: the firm's staff, households, people and accounts. The sign-in users go in as the owner login;
// the CRM mirror (advisors, households, clients, accounts and their holders, per-account AUM) goes in as the ingest
// login, as the CRM and custodian feeds write it in production. Every household is a client of one of the
// universe's three advisors, who is its lead advisor (the book row security scopes advisors to).

import { Role } from "@prisma/client";
import { INGEST_ACCOUNT_AUM } from "@/lib/audit";
import { FIRM_HOUSEHOLD_ID } from "@/lib/data/firm-household";
import { previousTradingDay } from "@/lib/market-calendar";
import { addCalendarDays, firmToday } from "./calendar";
import type { SeedContext } from "./context";
import { insertRows, type Row } from "./batch";
import { ownAccounts, ownAccountUlid } from "./own-accounts";
import {
  accountUlid, advisorSfId, cedarRidgeUserId, demoCuid, membersOf, seededInt, staffEmail, staffOf, type Universe,
  type UniverseAccount, type UniversePerson,
} from "./universe";

/** A staff member's sign-in user id, the same on every seed. A visitor's sign-in token carries it, so a visitor still
 * signed in when the nightly reset reseeds keeps pointing at their own user. */
export const staffUserId = (staffId: string): string => demoCuid(`user:${staffId}`);

// AoA's role for each universe staff role. The four demo personas (lib/demo/personas.ts) land on theirs: Priya
// (compliance) ADMIN, Jordan (transfers) OPERATIONS, Rachel (advisor) ADVISOR, Helen (client service) CLIENT_SERVICE.
const STAFF_ROLE: Record<string, Role> = {
  advisor: Role.ADVISOR,
  "client-service": Role.CLIENT_SERVICE,
  compliance: Role.ADMIN,
  operations: Role.OPERATIONS,
  transfers: Role.OPERATIONS,
  trader: Role.OPERATIONS,
};

/** The clearing firm's account type, as the custodian feed labels it. */
export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  "joint-taxable": "Joint",
  individual: "Individual",
  trust: "Trust",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Rollover IRA",
  "sep-ira": "SEP IRA",
  "roth-ira": "Roth IRA",
};

/** An account's owners: everyone in the household for a joint account, otherwise the first member (the Transfer
 *  Tracker demo's rule, so an ACAT record names the same client as the account it lands in). */
export function accountOwners(universe: Universe, account: UniverseAccount): UniversePerson[] {
  const members = membersOf(universe, account.household);
  return account.type === "joint-taxable" ? members : members.slice(0, 1);
}

// The firm's own accounts at the clearing firm: no client, no household of their own (lib/data/firm-household.ts).
const FIRM_ACCOUNTS = [
  { key: "fee", type: "Fee Account", aum: 48210.55 },
  { key: "deposit", type: "Deposit Account", aum: 31500 },
  { key: "error", type: "Error Account", aum: 2214.38 },
  { key: "allocation", type: "Allocation Account", aum: 12880 },
] as const;

export async function seedPeople(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe, owner, ingest, now, today } = ctx;
  // The custodian's start-of-day file covers the previous trading day; the warehouse card loaded it overnight.
  const asOf = previousTradingDay(firmToday(now));
  const asOfAt = new Date(`${asOf}T12:00:00Z`);
  const snapshotRun = `aum-${asOf}`;
  // The second members' own accounts (own-accounts.ts) are in the same overnight file as the universe's.
  const own = ownAccounts(universe);
  const clientAccounts = universe.accounts.length + own.length;
  const expected = { rows: clientAccounts + FIRM_ACCOUNTS.length, current: clientAccounts, corporate: FIRM_ACCOUNTS.length };

  // Each table goes in as one statement (batch.ts), in the order the per-row writes made.
  await insertRows(owner, 'app."User"', universe.staff.map((s) => ({
    id: staffUserId(s.id), email: staffEmail(s), name: s.name, role: STAFF_ROLE[s.role] ?? Role.VIEWER,
  })), `ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`);

  // A migration already maps one advisor's email to a name (20260706000000_seed_advisor_reference); the join and
  // row security key on email, so the seed takes that row over rather than adding a second.
  const advisors = universe.staff.filter((s) => s.role === "advisor");
  await insertRows(ingest, "mirror.advisor", advisors.map((a) => ({
    sf_id: advisorSfId(universe, a.id), name: a.name, email: staffEmail(a), title: "Financial Advisor", active: true, synced_at: now,
  })), `ON CONFLICT (email) DO UPDATE
          SET sf_id = EXCLUDED.sf_id, name = EXCLUDED.name, title = EXCLUDED.title, active = true, synced_at = EXCLUDED.synced_at`);

  const valueOf = (householdId: string) =>
    [...universe.accounts, ...own].filter((a) => a.household === householdId).reduce((sum, a) => sum + a.value, 0);
  await insertRows(ingest, "mirror.household", universe.households.map((h) => ({
    sf_id: ctx.householdId.get(h.id)!, name: h.name, status: "Active", stage: "Client",
    lead_advisor_email: staffEmail(staffOf(universe, h.advisor)), aum: valueOf(h.id), synced_at: now,
  })));

  await insertRows(ingest, "mirror.client", universe.people.map((p) => {
    const household = universe.households.find((h) => h.id === p.household)!;
    return {
      sf_id: ctx.personId.get(p.id)!, household_id: ctx.householdId.get(p.household)!, first_name: p.first, last_name: p.last,
      email: p.email, lead_advisor_email: staffEmail(staffOf(universe, household.advisor)), cedar_ridge_user_id: cedarRidgeUserId(p.id),
      stage: "Client", synced_at: now,
    };
  }));

  const securityClass = new Map(universe.securities.map((s) => [s.symbol, s.assetClass]));
  const accounts: Row[] = [];
  const holders: Row[] = [];
  const aum: Row[] = [];
  const snapshot = {
    is_managed: true, account_status: "ACTIVE", as_of: asOfAt, balance_as_of: asOf, source_snapshot_as_of: asOf,
    balance_current: true, source_present: true, snapshot_run_id: snapshotRun, expected_snapshot_rows: expected.rows,
    expected_current_accounts: expected.current, expected_closed_accounts: 0, expected_corporate_accounts: expected.corporate,
    synced_at: now,
  };
  for (const a of universe.accounts) {
    const custodianId = accountUlid(a.id);
    const owners = accountOwners(universe, a);
    const type = ACCOUNT_TYPE_LABEL[a.type] ?? "Individual";
    const opened = addCalendarDays(today, -seededInt(`${a.id}:opened`, 120, 1400));
    accounts.push({ custodian_account_id: custodianId, custodian: "APEX", account_type: type, status: "OPEN", opened_at: opened, synced_at: now });
    for (const o of owners) holders.push({ custodian_account_id: custodianId, cedar_ridge_user_id: cedarRidgeUserId(o.id), synced_at: now });
    const cash = universe.holdings
      .filter((h) => h.account === a.id && securityClass.get(h.symbol) === "cash")
      .reduce((s, h) => s + h.value, 0);
    aum.push({
      custodian_account_id: custodianId, apex_account_number: a.number, client_sf_id: ctx.personId.get(owners[0].id)!,
      household_sf_id: ctx.householdId.get(a.household)!, account_type: type, account_aum: a.value, account_cash: round2(cash),
      account_securities: round2(a.value - cash), ...snapshot,
    });
  }

  for (const a of own) {
    const custodianId = ownAccountUlid(a);
    const type = ACCOUNT_TYPE_LABEL[a.type] ?? "Individual";
    const cash = round2(a.value * a.cashShare);
    accounts.push({
      custodian_account_id: custodianId, custodian: "APEX", account_type: type, status: "OPEN",
      opened_at: addCalendarDays(today, -a.openedDaysAgo), synced_at: now,
    });
    holders.push({ custodian_account_id: custodianId, cedar_ridge_user_id: cedarRidgeUserId(a.owner), synced_at: now });
    aum.push({
      custodian_account_id: custodianId, apex_account_number: a.number, client_sf_id: ctx.personId.get(a.owner)!,
      household_sf_id: ctx.householdId.get(a.household)!, account_type: type, account_aum: a.value, account_cash: cash,
      account_securities: round2(a.value - cash), ...snapshot,
    });
  }

  for (const f of FIRM_ACCOUNTS) {
    aum.push({
      custodian_account_id: accountUlid(`firm-${f.key}`), apex_account_number: null, client_sf_id: null,
      household_sf_id: FIRM_HOUSEHOLD_ID, account_type: f.type, account_aum: f.aum, account_cash: f.aum, account_securities: 0,
      ...snapshot, is_managed: false, account_status: "OPEN",
    });
  }
  await insertRows(ingest, "mirror.account", accounts);
  await insertRows(ingest, "mirror.account_holder", holders);
  await insertRows(ingest, "mirror.client_account_aum", aum);

  // The overnight AUM load's audit row, as app/api/cron/account-aum writes it.
  await owner.auditLog.create({
    data: {
      at: new Date(now.getTime() - 2 * 60 * 60_000),
      actorRole: "INGEST",
      action: INGEST_ACCOUNT_AUM,
      entityType: "ingest_run",
      entityId: snapshotRun,
      detail: JSON.stringify({
        source: "warehouse", card: 6601, received: expected.rows, upserted: expected.rows, rejected: 0, retired: 0,
        dry_run: false, as_of_max: asOf, open_accounts: expected.rows, closed_accounts: 0,
        corporate_accounts: expected.corporate, expected_snapshot_rows: expected.rows,
      }),
    },
  });

  return {
    users: universe.staff.length,
    advisors: advisors.length,
    households: universe.households.length,
    clients: universe.people.length,
    accounts: universe.accounts.length,
    ownAccounts: own.length,
    holders: holders.length,
    firmAccounts: FIRM_ACCOUNTS.length,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
