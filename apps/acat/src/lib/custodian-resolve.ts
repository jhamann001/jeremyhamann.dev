import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { custodianProjectionEnabled } from "@/lib/custodian-admin";
import { normalizeContra, ALIAS } from "./contra-normalize";
import { unknownContraError } from "@/lib/demo/limits";
import { personaSignInEnabled } from "@/lib/demo/personas";

/**
 * Resolve a free-text `transferringContra` to a Custodian row, creating one
 * only as a last resort. This is the single source of truth shared by
 * POST /api/acats and PATCH /api/acats/[id] so both paths resolve identically
 * and stop spawning duplicate/bare custodian cards.
 *
 * Server-only: imports `@/lib/prisma`. Client code that needs to normalize a
 * contra name must import from `@/lib/contra-normalize` instead.
 *
 * Resolution order:
 *   1. Exact (case-insensitive) match against an existing row.
 *   2. Alias: snap a known variant onto its canonical display name, then
 *      resolve that canonical name against existing rows.
 *   3. Normalized-equals scan against existing rows (catches whitespace /
 *      punctuation / case variants the exact match missed).
 *   4. Create — the ONLY place a new custodian is minted. Genuinely-new
 *      contras land here and are flagged `NEEDS_SETUP` for human review.
 */
export async function resolveCustodianForContra(
  transferringContra: string | null | undefined,
  tx?: Prisma.TransactionClient
): Promise<{ id: string; name: string } | null> {
  const db = tx ?? prisma;
  const raw = transferringContra?.trim();
  if (!raw) return null;

  // 1. Exact (case-insensitive) match.
  const exact = await db.custodian.findFirst({
    where: { name: { equals: raw, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (exact) return exact;

  // 2. Alias: map a known variant to its canonical display name.
  const normalized = normalizeContra(raw);
  const aliasTarget = ALIAS[normalized];
  const canonicalName = aliasTarget ?? raw;
  if (aliasTarget) {
    const aliased = await db.custodian.findFirst({
      where: { name: { equals: aliasTarget, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (aliased) return aliased;
  }

  // 3. Normalized-equals scan against existing rows.
  const canonicalNormalized = normalizeContra(canonicalName);
  const candidates =
    (await db.custodian.findMany({ select: { id: true, name: true } })) ?? [];
  const match = candidates.find((c) => {
    const n = normalizeContra(c.name);
    return n === normalized || n === canonicalNormalized;
  });
  if (match) return match;

  if (custodianProjectionEnabled()) return null;

  // The public demo never mints a card from a visitor's typed contra (see unknownContraError).
  if (personaSignInEnabled()) throw unknownContraError();

  // A native upsert avoids poisoning a caller's transaction after a concurrent
  // insert. The no-op name update keeps this eligible for ON CONFLICT in Prisma.
  if (tx) return tx.custodian.upsert({
    where: { name: canonicalName },
    create: { name: canonicalName, reviewStatus: "NEEDS_SETUP" },
    update: { name: canonicalName },
    select: { id: true, name: true },
  });

  // 4. Create — the only mint point. Flag for human setup.
  try {
    return await db.custodian.create({
      data: { name: canonicalName, reviewStatus: "NEEDS_SETUP" },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Lost a create race — the row now exists; fetch it.
      return db.custodian.findUnique({
        where: { name: canonicalName },
        select: { id: true, name: true },
      });
    }
    throw err;
  }
}
