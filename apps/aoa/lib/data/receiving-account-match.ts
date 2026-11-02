import "server-only";
import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";

// Derived "receiving account" for a transfer's linked asset-map account (rework
// S6). When a transfer is linked to a mapping account, that account's
// registration TYPE (e.g. "Roth IRA") implies a receiving Apex account of the
// same type. This seam answers: does the transfer's client ALREADY hold an
// (open) Apex account of that type, or does one still need to be opened?
//
// SOURCE (owner decision 2026-07-21): read entirely from the Warehouse-fed
// mirror.client_account_aum — the accounts+AUM card, refreshed every morning by
// the account-aum cron, which carries account_type, account_status, the real
// apex_account_number, AND the client/household SF ids. We match by the
// transfer's client_sf_id + registration type. (This SUPERSEDES the earlier read
// of mirror.account/account_holder-by-cedar_ridge_user_id, whose n8n push feed
// isn't wired — so the open state now rides the one live feed the rest of the
// app already uses.)
//
// READ-ONLY + DERIVED: never writes an app.transfer_account row — computed live
// from the link + the feed, so it can't go stale and needs no cleanup on
// relink/unlink. Rendered as a non-toggleable row alongside the manual rows.
//
// RLS: one withUserScope read — client_account_aum is gated by its ops/own-book
// policies, so a non-permitted caller sees zero rows → TO_OPEN (fail-safe: never
// a false OPEN). PII: the account NUMBER is returned MASKED to last-4; nothing
// is logged.

export type DerivedReceivingStatus = "OPEN" | "TO_OPEN";

export type DerivedReceivingAccount = {
  /** The registration type the receiving account must be (from the linked map). */
  registrationType: string;
  status: DerivedReceivingStatus;
  /** Masked Apex account number when an OPEN match exists (last-4); null otherwise. */
  apexAccountMasked: string | null;
};

/** One row from the accounts+AUM feed for the match. `apex_account_number` is the
 *  real custodian account number (nullable — feed lag / numberless firm accts). */
export type AumAccountRow = {
  account_type: string | null;
  account_status: string | null;
  apex_account_number: string | null;
};

type BatchedAumAccountRow = AumAccountRow & { client_sf_id: string };

export type ReceivingAccountKey = {
  transferId: string;
  clientSfId: string | null;
  accountType: string | null;
};

// The account_status values that count as "opened" (an account that exists and
// is usable as a receiving account). Observed feed vocab: OPEN (opened, may be
// unfunded $0) and ACTIVE (funded). Anything else — CLOSED, null, or an
// unrecognized status — is treated as NOT open (fail-safe toward TO_OPEN, never
// a false OPEN). Extend here if the card surfaces another live status.
const OPEN_STATUSES: ReadonlySet<string> = new Set(["OPEN", "ACTIVE"]);

function isOpenStatus(status: string | null): boolean {
  return status != null && OPEN_STATUSES.has(status.trim().toUpperCase());
}

/** Normalize a registration type — strip case, spaces, and punctuation so
 *  "Roth IRA" / "ROTH_IRA" / "Roth-IRA" all compare equal. PURE. */
export function normalizeRegistrationType(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Registration-type SYNONYMS (owner 2026-07-21): the asset-map label and the
// Apex feed label for the same account often differ ("IRA" / "Traditional IRA" /
// "Trad IRA"). Canonicalizing collapses each family to one key BEFORE matching.
// Each entry is `canonical → [normalized aliases]`. Aliases must be UNAMBIGUOUS:
// a bare "IRA" resolves to Traditional (owner rule — the default IRA), and no
// alias here is a prefix/substring trap because lookup is EXACT on the fully
// normalized string ("rothira" ≠ "ira"). Extend as new vocab shows up.
const REGISTRATION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  traditional_ira: ["ira", "traditionalira", "tradira", "traditional"],
  roth_ira: ["rothira", "roth"],
  sep_ira: ["sepira", "sep"],
  simple_ira: ["simpleira", "simple"],
};

// Reverse index: normalized alias → canonical key. Built once at module load.
const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  Object.entries(REGISTRATION_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((a) => [a, canonical] as const),
  ),
);

/** Canonical key for matching: normalize, then fold known synonyms to one key
 *  (a bare "IRA" → Traditional IRA, etc.). Unknown types fall back to their
 *  normalized form, so exact matching still works for anything not aliased. PURE. */
export function canonicalizeRegistrationType(s: string | null | undefined): string {
  const n = normalizeRegistrationType(s);
  return ALIAS_TO_CANONICAL.get(n) ?? n;
}

/** PURE matcher: given the linked type + the client's feed accounts, decide OPEN
 *  (a same-type account exists with an open status) vs TO_OPEN (none / only
 *  closed). Type equality is by CANONICAL key, so synonyms match. Returns the
 *  matched row so the caller can read its real number. */
export function matchReceivingAccount(
  accountType: string | null,
  accounts: AumAccountRow[],
): { status: DerivedReceivingStatus; match: AumAccountRow | null } {
  const want = canonicalizeRegistrationType(accountType);
  if (want === "") return { status: "TO_OPEN", match: null };
  const sameType = accounts.filter(
    (a) => canonicalizeRegistrationType(a.account_type) === want,
  );
  const open = sameType.find((a) => isOpenStatus(a.account_status));
  return open ? { status: "OPEN", match: open } : { status: "TO_OPEN", match: null };
}

/** Mask an Apex account number to its last 4 (never the full number). */
function maskAccount(num: string): string {
  return `••••${num.slice(-4)}`;
}

function buildDerivedReceivingAccount(
  accountType: string,
  accounts: AumAccountRow[],
): DerivedReceivingAccount {
  const { status, match } = matchReceivingAccount(accountType, accounts);
  const number = match?.apex_account_number ?? null;
  return {
    registrationType: accountType,
    status,
    apexAccountMasked: number ? maskAccount(number) : null,
  };
}

/**
 * The derived receiving account for a transfer's linked asset-map registration.
 * Returns null when there's nothing to derive (no linked type, or no client
 * sf id to match the feed against). Otherwise returns the registration type +
 * OPEN/TO_OPEN + the masked Apex account number when open. Read-only.
 */
export async function getDerivedReceivingAccount(
  id: Identity,
  key: { clientSfId: string | null; accountType: string | null },
): Promise<DerivedReceivingAccount | null> {
  const { clientSfId, accountType } = key;
  if (!clientSfId || !accountType) return null;

  const accounts = await withUserScope(id, (tx) =>
    tx.$queryRaw<AumAccountRow[]>`
      SELECT account_type, account_status, apex_account_number
      FROM mirror.client_account_aum
      WHERE client_sf_id = ${clientSfId}
        AND source_present
        AND balance_current
      -- Deterministic pick when a client holds >1 same-type open account: prefer
      -- one whose number is known (feed lag), then stable by id (the matcher
      -- takes the first open row in this order).
      ORDER BY (apex_account_number IS NULL), custodian_account_id`,
  );

  return buildDerivedReceivingAccount(accountType, accounts);
}

/**
 * Board-sized version of getDerivedReceivingAccount. Reads every relevant
 * client's Apex rows in ONE RLS-scoped query, then applies the identical pure
 * matcher per transfer. This avoids an account-feed query per card while still
 * returning only last-four masked account numbers.
 */
export async function getDerivedReceivingAccounts(
  id: Identity,
  keys: readonly ReceivingAccountKey[],
): Promise<Record<string, DerivedReceivingAccount>> {
  return withUserScope(id, tx => getDerivedReceivingAccountsWithinScope(tx, keys));
}

/** Caller must supply a withUserScope transaction; used for coherent board pages. */
export async function getDerivedReceivingAccountsWithinScope(
  tx: Prisma.TransactionClient,
  keys: readonly ReceivingAccountKey[],
): Promise<Record<string, DerivedReceivingAccount>> {
  const eligible = keys.filter(
    (key): key is ReceivingAccountKey & {
      clientSfId: string;
      accountType: string;
    } => !!key.clientSfId && !!key.accountType,
  );
  if (eligible.length === 0) return {};

  const clientSfIds = [...new Set(eligible.map((key) => key.clientSfId))];
  const accounts = await tx.$queryRaw<BatchedAumAccountRow[]>`
      SELECT client_sf_id, account_type, account_status, apex_account_number
      FROM mirror.client_account_aum
      WHERE client_sf_id IN (${Prisma.join(clientSfIds)})
        AND source_present
        AND balance_current
      ORDER BY client_sf_id, (apex_account_number IS NULL), custodian_account_id`;

  const byClient = new Map<string, AumAccountRow[]>();
  for (const account of accounts) {
    const rows = byClient.get(account.client_sf_id) ?? [];
    rows.push(account);
    byClient.set(account.client_sf_id, rows);
  }

  return Object.fromEntries(
    eligible.map((key) => [
      key.transferId,
      buildDerivedReceivingAccount(
        key.accountType,
        byClient.get(key.clientSfId) ?? [],
      ),
    ]),
  );
}
