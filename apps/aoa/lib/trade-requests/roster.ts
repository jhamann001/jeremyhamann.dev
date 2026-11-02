import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { indexAoaAccounts, matchIdentity, normalizeEmail, type AoaRole } from "./identity";

export type RosterMember = { id: string; name: string; email: string; slackUserId: string | null; aoaRole: AoaRole | null; eligible: boolean };
export type RosterRefusalCode = "not_eligible" | "not_found" | "invalid_slack_id" | "invalid_member" | "last_trader" | "self_removal";
export class RosterRefusal extends Error {
  constructor(readonly code: RosterRefusalCode) {
    super(code);
  }
}

type Db = Prisma.TransactionClient;
const SLACK_ID = /^[UW][A-Z0-9]{3,49}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELIGIBLE = new Set<AoaRole>(["ADMIN", "OPERATIONS"]);
// lib/db.ts exports an $extends client; present it as the public TransactionClient contract (lib/rls.ts:49-54).
const root = () => prisma as unknown as Db;

type TraderRow = { id: string; name: string; email: string; slack_user_id: string | null };
type AccountRow = { email: string | null; role: AoaRole };

async function aoaAccountsFor(db: Db, emails: string[]): Promise<AccountRow[]> {
  if (emails.length === 0) return [];
  return db.$queryRaw<AccountRow[]>`
    SELECT email, role::text AS role FROM app."User" WHERE lower(btrim(email)) = ANY(${emails}::text[])`;
}

/**
 * Active traders with their matched AOA role. Missing or ambiguous matches (several AOA accounts, or several active
 * trader identities, on one normalized email) are ineligible; one row per member.
 */
export async function readRoster(db: Db = root()): Promise<RosterMember[]> {
  const traders = await db.$queryRaw<TraderRow[]>`
    SELECT id::text AS id, name, email, slack_user_id FROM trade_request.users
     WHERE role = 'trader' AND is_active ORDER BY name, email`;
  const index = indexAoaAccounts(await aoaAccountsFor(db, traders.map((t) => normalizeEmail(t.email))));
  const perEmail = new Map<string, number>();
  for (const t of traders) perEmail.set(normalizeEmail(t.email), (perEmail.get(normalizeEmail(t.email)) ?? 0) + 1);
  return traders.map((t) => {
    const { status, account } = matchIdentity(t.email, index, perEmail.get(normalizeEmail(t.email)) ?? 0);
    const aoaRole = status === "matched" ? account!.role : null;
    return { id: t.id, name: t.name, email: t.email, slackUserId: t.slack_user_id, aoaRole, eligible: aoaRole !== null && ELIGIBLE.has(aoaRole) };
  });
}

/** The notification recipients (read by ticket). This work order is the only writer of roster membership. */
export async function eligibleRecipientIds(): Promise<string[]> {
  return (await readRoster()).filter((m) => m.eligible).map((m) => m.id);
}

type State = { role: string; is_active: boolean; slack_user_id: string | null };

async function stateOf(db: Db, id: string): Promise<State | null> {
  const rows = await db.$queryRaw<State[]>`
    SELECT role, is_active, slack_user_id FROM trade_request.users WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

async function log(db: Db, actor: string, action: "add" | "remove" | "slack", memberId: string, before: State | Record<string, never>, after: State) {
  await db.$executeRaw`
    INSERT INTO trade_request.roster_changes (actor_aoa_user_id, action, member_user_id, before_state, after_state)
    VALUES (${actor}, ${action}, ${memberId}::uuid, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`;
}

export type RosterChange =
  | { action: "add"; email: string }
  | { action: "remove"; memberId: string }
  | { action: "slack"; memberId: string; slackUserId: string | null };

export async function changeRoster(actor: { aoaUserId: string; email: string }, change: RosterChange): Promise<RosterMember[]> {
  if (change.action !== "add" && !UUID.test(change.memberId)) throw new RosterRefusal("invalid_member");
  if (change.action === "slack" && change.slackUserId !== null && !SLACK_ID.test(change.slackUserId)) throw new RosterRefusal("invalid_slack_id");
  return prisma.$transaction(async (raw) => {
    const tx = raw as unknown as Db;
    if (change.action === "add") {
      const email = normalizeEmail(change.email);
      const accounts = await aoaAccountsFor(tx, [email]);
      const { status, account } = matchIdentity(email, indexAoaAccounts(accounts), 1);
      if (status !== "matched" || !ELIGIBLE.has(account!.role)) throw new RosterRefusal("not_eligible");
      const [aoaUser] = await tx.$queryRaw<Array<{ name: string | null }>>`
        SELECT name FROM app."User" WHERE lower(btrim(email)) = ${email} LIMIT 1`;
      const name = (aoaUser?.name?.trim() || email).slice(0, 255);
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM trade_request.users WHERE lower(email) = ${email} ORDER BY created_at ASC LIMIT 1`;
      let id: string;
      let before: State | Record<string, never> = {};
      if (existing[0]) {
        id = existing[0].id;
        before = (await stateOf(tx, id))!;
        await tx.$executeRaw`UPDATE trade_request.users SET role = 'trader', is_active = true WHERE id = ${id}::uuid`;
      } else {
        const [created] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO trade_request.users (email, name, role, is_active, aoa_provisioned_at)
          VALUES (${email}, ${name}, 'trader', true, NOW()) RETURNING id::text AS id`;
        id = created.id;
      }
      await log(tx, actor.aoaUserId, "add", id, before, (await stateOf(tx, id))!);
      return readRoster(tx);
    }
    const before = await stateOf(tx, change.memberId);
    if (!before || before.role !== "trader" || !before.is_active) throw new RosterRefusal("not_found");
    if (change.action === "remove") {
      // The standalone deactivate rules (server/src/routes/users.ts:147-175): never yourself, never the last active trader.
      const [self] = await tx.$queryRaw<Array<{ email: string }>>`SELECT email FROM trade_request.users WHERE id = ${change.memberId}::uuid`;
      if (normalizeEmail(self.email) === normalizeEmail(actor.email)) throw new RosterRefusal("self_removal");
      const [others] = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade_request.users WHERE role = 'trader' AND is_active AND id <> ${change.memberId}::uuid`;
      if (others.n < 1) throw new RosterRefusal("last_trader");
      await tx.$executeRaw`UPDATE trade_request.users SET is_active = false WHERE id = ${change.memberId}::uuid`;
    } else {
      await tx.$executeRaw`UPDATE trade_request.users SET slack_user_id = ${change.slackUserId} WHERE id = ${change.memberId}::uuid`;
    }
    await log(tx, actor.aoaUserId, change.action, change.memberId, before, (await stateOf(tx, change.memberId))!);
    return readRoster(tx);
  });
}
