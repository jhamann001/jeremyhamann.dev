// Limits for the public demo, where every visitor shares one firm until the nightly reset. Only active
// with PERSONA_SIGN_IN=on (demo-config.json sets it; a test checks).
//
// Caps on every kind of row a visitor can add, so the shared data (and Neon's 0.5 GB) stays bounded
// until the reset. Counts include the seed (S9): 124 transfers, 27 custodians, 29 custodian fees, 8
// users, 4 data-quality reviews, 741 positions, 40 documents (0.9 MB) and 60 fee reimbursements.

import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { personaSignInEnabled } from "./personas";

type Db = Prisma.TransactionClient;

const MB = 1024 * 1024;

// `lock` is the kind's advisory-lock key, under QUOTA_LOCK_NAMESPACE. A writer that holds several caps
// takes them in this order. Take them after any row lock the transaction needs (a transfer's FOR UPDATE),
// never before one: two writers that lock in different orders can deadlock.
const QUOTAS = {
  transfers: { lock: 1, max: 400, label: "transfers", held: (db: Db) => db.acatRecord.count() },
  custodians: { lock: 2, max: 60, label: "custodians", held: (db: Db) => db.custodian.count() },
  custodianFees: { lock: 3, max: 150, label: "custodian fees", held: (db: Db) => db.custodianFee.count() },
  users: { lock: 4, max: 30, label: "users", held: (db: Db) => db.allowedUser.count() },
  reviews: { lock: 5, max: 300, label: "data-quality reviews", held: (db: Db) => db.dataQualityReview.count() },
  positions: { lock: 6, max: 2500, label: "positions", held: (db: Db) => db.asset.count() },
  documents: { lock: 7, max: 300, label: "documents", held: (db: Db) => db.acatDocument.count() },
  // A document's stored bytes: the file and the CSV snapshot kept beside it.
  documentBytes: {
    lock: 8,
    max: 50 * MB,
    label: "MB of documents",
    held: async (db: Db) => {
      const [row] = await db.$queryRaw<{ n: bigint }[]>`
        SELECT coalesce(sum("byteSize" + octet_length("inputCsv")), 0)::bigint AS n FROM "AcatDocument"`;
      return Number(row?.n ?? 0);
    },
  },
  feeCredits: { lock: 9, max: 300, label: "fee reimbursements", held: (db: Db) => db.demoFeeCreditRow.count() },
} as const;
const QUOTA_LOCK_NAMESPACE = 7402;

export type DemoQuota = keyof typeof QUOTAS;
/**
 * The net amount a write adds of each kind (a batch's adds minus its removes; bytes for documentBytes).
 * A function is worked out after that kind's lock is held, for an upsert that adds a row only when it
 * is new: counted any earlier, a concurrent writer could change the answer.
 */
export type DemoHolds = Partial<Record<DemoQuota, number | ((db: Db) => Promise<number>)>>;

/** The cap on a kind, for tests and messages. */
export const demoQuotaMax = (kind: DemoQuota): number => QUOTAS[kind].max;

const UNTIL_RESET = "until its nightly reset at 07:00 UTC";

/** Refused by a demo limit (429 for a cap). Routes answer it with demoLimitResponse. */
export class DemoLimitError extends Error {
  constructor(message: string, readonly status = 429) {
    super(message);
    this.name = "DemoLimitError";
  }
}

/**
 * A transfer's delivering firm must already be on the custodian list in the demo. Outside it, an unknown
 * contra mints a new custodian card; here that card would put a visitor's typed text at the head of the
 * custodian list every visitor sees.
 */
export const unknownContraError = () =>
  new DemoLimitError("In the demo, pick the delivering firm from the list. An admin adds new firms on the Custodians page.", 400);

const capText = (kind: DemoQuota) => {
  const { max, label } = QUOTAS[kind];
  return kind === "documentBytes" ? `${max / MB} ${label}` : `${max} ${label}`;
};

/** The message for a cap already reached. */
export function demoLimitMessage(kind: DemoQuota): string {
  return `The demo holds up to ${capText(kind)} ${UNTIL_RESET}. Please try again tomorrow.`;
}

/**
 * Call inside the transaction that writes the rows, before it writes them: refuses the write if it would
 * take the demo past a cap.
 *
 * It takes a transaction-scoped advisory lock per kind first, so writers of the same kind count one at a
 * time and each sees what the one before it committed. Checking before the transaction instead let
 * batches, and simultaneous requests, pass the check together and overshoot the cap.
 */
export async function holdDemoQuota(db: Db, holds: DemoHolds): Promise<void> {
  if (!personaSignInEnabled()) return;
  for (const kind of Object.keys(QUOTAS) as DemoQuota[]) {
    const hold = holds[kind];
    if (hold === undefined || hold === 0) continue;
    const { lock, max } = QUOTAS[kind];
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${QUOTA_LOCK_NAMESPACE}::int, ${lock}::int)`;
    const adding = typeof hold === "function" ? await hold(db) : hold;
    if (adding <= 0) continue;
    const held = await QUOTAS[kind].held(db);
    if (held + adding <= max) continue;
    if (held >= max || kind === "documentBytes") throw new DemoLimitError(demoLimitMessage(kind));
    throw new DemoLimitError(
      `The demo holds up to ${capText(kind)} ${UNTIL_RESET}, and this change would add ${adding} with room for ${max - held}. Please make a smaller change.`,
    );
  }
}

/**
 * An early refusal, before costly work such as building a PDF, for kinds already at their cap. The
 * write still holds its caps in its own transaction; this only saves the work.
 */
export async function assertDemoRoom(kinds: DemoQuota[]): Promise<void> {
  if (!personaSignInEnabled()) return;
  for (const kind of kinds) {
    if ((await QUOTAS[kind].held(prisma)) >= QUOTAS[kind].max) throw new DemoLimitError(demoLimitMessage(kind));
  }
}

/** The caps a new document counts against. */
export const documentHolds = (doc: { byteSize: number; inputCsv: string }): DemoHolds => ({
  documents: 1,
  documentBytes: doc.byteSize + Buffer.byteLength(doc.inputCsv, "utf8"),
});

/**
 * Positions on one transfer in the demo. The transfer form's cost grows with the square of its
 * positions (on a laptop core, 200 took 2 s and 400 took 7 s), and the demo runs on a quarter of a core.
 */
export const DEMO_POSITIONS_PER_TRANSFER = 100;

/** Call inside a transaction that already holds the transfer's row lock, before adding positions to it. */
export async function holdTransferPositions(db: Db, acatRecordId: string, adding: number): Promise<void> {
  if (!personaSignInEnabled() || adding <= 0) return;
  const held = await db.asset.count({ where: { acatRecordId } });
  if (held + adding <= DEMO_POSITIONS_PER_TRANSFER) return;
  throw new DemoLimitError(
    `In the demo a transfer holds up to ${DEMO_POSITIONS_PER_TRANSFER} positions, and this change would add ${adding} with room for ${Math.max(0, DEMO_POSITIONS_PER_TRANSFER - held)}.`,
    400,
  );
}

// Record history grows with every edit, through dozens of write paths, so it is checked once per change
// a visitor sends (in the proxy) rather than held inside each write. That can overshoot by one request's
// entries, which bounds storage just as well. Each value is at most 2,000 characters.
const HISTORY = { entries: 20_000, bytes: 20 * MB };
export const DEMO_HISTORY_FULL_MESSAGE = `The demo holds up to ${HISTORY.entries.toLocaleString("en-US")} history entries ${UNTIL_RESET}. Please try again tomorrow.`;

export async function demoHistoryFull(): Promise<boolean> {
  if (!personaSignInEnabled()) return false;
  const [row] = await prisma.$queryRaw<{ n: bigint; bytes: bigint }[]>`
    SELECT count(*)::bigint AS n,
      coalesce(sum(octet_length(coalesce("oldValue", '')) + octet_length(coalesce("newValue", ''))), 0)::bigint AS bytes
    FROM "AuditLog"`;
  return Number(row?.n ?? 0) >= HISTORY.entries || Number(row?.bytes ?? 0) >= HISTORY.bytes;
}

/**
 * For a write that has no transaction of its own: runs `write` in one that holds the caps (see
 * holdDemoQuota). Outside the demo it is just `write(prisma)`.
 */
export async function withDemoQuota<T>(holds: DemoHolds, write: (db: Db) => Promise<T>): Promise<T> {
  if (!personaSignInEnabled()) return write(prisma);
  return prisma.$transaction(async (tx) => {
    await holdDemoQuota(tx, holds);
    return write(tx);
  });
}

/** The answer for a DemoLimitError; null for anything else. */
export function demoLimitResponse(error: unknown): NextResponse | null {
  if (!(error instanceof DemoLimitError)) return null;
  return NextResponse.json({ error: error.message }, { status: error.status });
}
