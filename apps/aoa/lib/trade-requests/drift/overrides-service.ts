import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveActorIdentity } from "@/lib/trade-requests/identity";
import { pgCompatFromTransaction } from "@/lib/trade-requests/pg-compat";
import { clearOverride, upsertOverride } from "@/lib/trade-requests/drift/drift-status-overrides";
import type { AccountDriftOverride, DriftOverrideReason } from "@/lib/trade-requests/shared-types";

// Drift override writes for the Drift screens (ticket). The ported upsert and delete run unchanged; this adds
// the Trade Request identity of the acting AOA user (set_by, so the re-check reminder reaches them) and a change
// log row carrying their name for both save and clear.
export type OverrideActor = { aoaUserId: string; email: string; name: string };
export type OverrideInput = { reason: DriftOverrideReason; note: string; expiresOn: string | null };

type Tx = Prisma.TransactionClient;
type StoredOverride = { reason: string; note: string; expires_on: string | null; set_by_name: string };

async function stored(tx: Tx, accountId: string): Promise<StoredOverride | null> {
  const rows = await tx.$queryRaw<StoredOverride[]>`
    SELECT reason, note, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, set_by_name
      FROM trade_request.drift_status_overrides WHERE account_id = ${accountId}`;
  return rows[0] ?? null;
}

async function logChange(tx: Tx, actor: OverrideActor, accountId: string, action: "save" | "clear", before: StoredOverride | null, after: StoredOverride | null) {
  await tx.$executeRaw`
    INSERT INTO trade_request.drift_override_changes (actor_aoa_user_id, actor_name, account_id, action, before_state, after_state)
    VALUES (${actor.aoaUserId}, ${actor.name}, ${accountId}, ${action},
            ${before ? JSON.stringify(before) : null}::jsonb, ${after ? JSON.stringify(after) : null}::jsonb)`;
}

export async function saveDriftOverride(actor: OverrideActor, accountId: string, input: OverrideInput): Promise<AccountDriftOverride> {
  return prisma.$transaction(async (raw) => {
    const tx = raw as unknown as Tx;
    const identity = await resolveActorIdentity(tx, { email: actor.email, name: actor.name });
    const before = await stored(tx, accountId);
    const override = await upsertOverride(pgCompatFromTransaction(tx), {
      accountId,
      reason: input.reason,
      note: input.note,
      expiresOn: input.expiresOn,
      setBy: identity.id,
      setByName: actor.name,
    });
    await logChange(tx, actor, accountId, "save", before, await stored(tx, accountId));
    return override;
  });
}

export async function clearDriftOverride(actor: OverrideActor, accountId: string): Promise<boolean> {
  return prisma.$transaction(async (raw) => {
    const tx = raw as unknown as Tx;
    const before = await stored(tx, accountId);
    const cleared = await clearOverride(pgCompatFromTransaction(tx), accountId);
    if (cleared) await logChange(tx, actor, accountId, "clear", before, null);
    return cleared;
  });
}
