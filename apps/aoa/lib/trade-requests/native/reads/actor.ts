import { prisma } from "@/lib/db";
import { normalizeEmail } from "../../identity";

/**
 * The moved Trade Request identity a person reads as: the earliest identity with
 * their normalized company email (the standalone rule, delegatedActor.ts:20-27).
 * Read-only. A person with no identity reads as one with no requests or
 * notifications, which is what the standalone service's new identity would see.
 */
export async function identityIdFor(email: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM trade_request.users WHERE lower(email) = ${normalizeEmail(email)} ORDER BY created_at ASC LIMIT 1`;
  return rows[0]?.id ?? null;
}
