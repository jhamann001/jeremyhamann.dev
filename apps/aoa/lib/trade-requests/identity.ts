import type { Prisma } from "@prisma/client";

export type AoaRole = "ADMIN" | "OPERATIONS" | "ADVISOR" | "CLIENT_SERVICE" | "VIEWER";
export type MatchStatus = "matched" | "missing" | "ambiguous";

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Pure: index AOA accounts by normalized email (several accounts on one email → ambiguous). */
export function indexAoaAccounts<T extends { email: string | null }>(accounts: readonly T[]): Map<string, T[]> {
  const byEmail = new Map<string, T[]>();
  for (const a of accounts) {
    const key = normalizeEmail(a.email);
    if (!key) continue;
    byEmail.set(key, [...(byEmail.get(key) ?? []), a]);
  }
  return byEmail;
}

/** Pure: match one identity email against the index and the number of identities sharing that email. */
export function matchIdentity<T>(email: string, index: Map<string, T[]>, identitiesOnEmail: number): { status: MatchStatus; account: T | null } {
  const candidates = index.get(normalizeEmail(email)) ?? [];
  if (candidates.length > 1 || identitiesOnEmail > 1) return { status: "ambiguous", account: null };
  if (candidates.length === 0) return { status: "missing", account: null };
  return { status: "matched", account: candidates[0] };
}

export type TradeRequestIdentity = {
  id: string;
  email: string;
  name: string | null;
  role: "advisor" | "trader";
  isActive: boolean;
  slackUserId: string | null;
};

type IdentityRow = { id: string; email: string; name: string | null; role: "advisor" | "trader"; is_active: boolean; slack_user_id: string | null };

/**
 * Resolve the acting AOA user to a Trade Request identity, creating an inactive advisor identity for a first-time
 * actor (the standalone delegated rule). Runs inside the caller's transaction.
 */
export async function resolveActorIdentity(tx: Prisma.TransactionClient, actor: { email: string; name: string }): Promise<TradeRequestIdentity> {
  const email = normalizeEmail(actor.email);
  const select = () => tx.$queryRaw<IdentityRow[]>`
    SELECT id::text AS id, email, name, role, is_active, slack_user_id
      FROM trade_request.users WHERE lower(email) = ${email} ORDER BY created_at ASC LIMIT 1`;
  let rows = await select();
  if (rows.length === 0) {
    await tx.$executeRaw`
      INSERT INTO trade_request.users (email, name, role, is_active, aoa_provisioned_at)
      VALUES (${email}, ${actor.name.slice(0, 255)}, 'advisor', false, NOW())
      ON CONFLICT (email) DO NOTHING`;
    rows = await select();
  }
  const r = rows[0];
  if (!r) throw new Error("trade_request_actor_unresolved");
  return { id: r.id, email: r.email, name: r.name, role: r.role, isActive: r.is_active, slackUserId: r.slack_user_id };
}
