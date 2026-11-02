// ticket: counts-only access reconciliation between moved Trade Request identities and AOA accounts.
// Prints one JSON line (run id, verdict, counts) and records it in trade_request.reconciliation_runs. Never prints
// a name, an email, the exception list or a database message. Writes nothing to AOA's own user or account tables.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { computeReconciliation, type AoaAccount, type StandaloneIdentity } from "../../lib/trade-requests/access-reconciliation";
import { normalizeEmail } from "../../lib/trade-requests/identity";

class ExceptionsUnreadable extends Error {}

function readExceptions(file: string | undefined): Set<string> {
  if (!file) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ExceptionsUnreadable();
  }
  if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) throw new ExceptionsUnreadable();
  return new Set(parsed.map((e) => normalizeEmail(e)).filter(Boolean));
}

export async function reconcileAccessMain(): Promise<void> {
  let exceptions: Set<string>;
  try {
    exceptions = readExceptions(process.env.TRADE_REQUEST_ACCESS_EXCEPTIONS_FILE);
  } catch {
    console.error("exceptions file unreadable");
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  try {
    const identities = (
      await prisma.$queryRaw<Array<{ email: string; role: "advisor" | "trader"; is_active: boolean }>>`
        SELECT email, role, is_active FROM trade_request.users`
    ).map((r): StandaloneIdentity => ({ email: r.email, role: r.role, isActive: r.is_active }));
    const accounts = await prisma.$queryRaw<AoaAccount[]>`SELECT email, role::text AS role FROM app."User"`;
    const { verdict, counts } = computeReconciliation(identities, accounts, exceptions);
    const [run] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO trade_request.reconciliation_runs (verdict, counts)
      VALUES (${verdict}, ${JSON.stringify(counts)}::jsonb) RETURNING id::text AS id`;
    console.log(JSON.stringify({ runId: run.id, verdict, counts }));
    process.exitCode = verdict === "failed" ? 1 : 0;
  } catch {
    console.error("reconciliation failed");
    process.exitCode = 2;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void reconcileAccessMain();
}
