import "server-only";
import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";

// Read seams over the mirror asset-map tables (rework S3/S4 + the funding-
// picture hub). TWO reads live here:
//   • listAssignableAssetMapAccounts — the "assign an asset map to a transfer"
//     picker: the live asset-mapping ACCOUNTS assignable to a transfer, with a
//     recommended sub-set matched by the deal's last-4 account number.
//   • getAssignedAssetMapDetail — the ASSIGNED account's facts + positions for
//     the hub's Asset-mapping expansion (keyed by the transfer's own triple).
// Each is one withUserScope read: the mirror asset-map tables' ops SELECT
// policy AND app.transfer's ops policy (where joined) gate them, so a non-ops
// caller sees zero rows.
//
// CARDINALITY (owner decision, revised S4 2026-07-19): a mapping account is
// REUSABLE across transfers — one source registration is routinely split into
// multiple receiving registrations (a Traditional IRA transfer AND a Roth IRA
// transfer both funded by the same account). So already-linked accounts are NOT
// hidden; each row carries how many OTHER transfers link it (`linkedTransferCount`
// + client names) so the picker can annotate reuse as a deliberate choice. Only
// the account linked to the CURRENT transfer is excluded (it's shown in the
// linked-state, not the picker). The S3 partial-unique index is dropped in
// migration 20260725000000.
//
// RECOMMENDED (owner's ask + caveat): the deal carries account_last4
// (lib/data/deal-types DealRow.account_last4), so accounts whose account_number
// ends in those 4 digits are surfaced as `recommended`. BUT not every mapping
// account has a comparable number and last-4 can collide, so `others` ALWAYS
// carries the full remaining list — the recommendation never hides it.
//
// PII: picker payloads carry only masked account numbers and an opaque mirror
// account ID. The write action resolves the durable key inside its existing
// user-scoped transaction; raw numbers never enter the picker response.
// total_value is a Postgres numeric → Number()-coerced HERE (NULL stays null).

/** One assignable mapping account (the picker option). */
export type AssetMapAccountOption = {
  /** Opaque mirror account ID, resolved server-side when the operator picks it. */
  accountId: string;
  sourceFolderId: string;
  custodian: string;
  /** Compile-time guard against adding the durable key to browser payloads. */
  accountNumber?: never;
  accountNumberMasked: string | null;
  /** Registration type (e.g. "Roth IRA") — part of the durable key (S5) and the
   *  disambiguator shown when there's no number. */
  accountType: string | null;
  accountHolder: string | null;
  householdName: string | null;
  totalValue: number | null;
  /** How many OTHER transfers already link this account (0 = unlinked). Reuse is
   *  allowed (S4); this lets the picker annotate a reused account so it's a
   *  deliberate choice, never a hidden surprise. */
  linkedTransferCount: number;
  /** Distinct client names of those other transfers, for the "also linked to …"
   *  note (masked-free — a client name, the same class of PII the picker already
   *  shows as householdName). */
  linkedTransferClients: string[];
};

/** The picker payload: recommended (deal last-4 match) on top, then the full
 *  remaining list. The two are disjoint; their union is every assignable account. */
export type AssignableAssetMapAccounts = {
  recommended: AssetMapAccountOption[];
  others: AssetMapAccountOption[];
};

type RawRow = {
  account_id: string;
  source_folder_id: string;
  household_name: string | null;
  custodian: string;
  account_number: string | null;
  account_type: string | null;
  account_holder: string | null;
  total_value: unknown; // Decimal | null at runtime
  linked_count: number | bigint;
  linked_clients: string[] | null;
};

/** Mask an account number to its last 4 (design §6 — display masked; full gated).
 *  NULL number → null (S5: numberless accounts show their type instead). */
function maskAccount(accountNumber: string | null): string | null {
  return accountNumber == null ? null : `••••${accountNumber.slice(-4)}`;
}

/** Normalize a deal's last-4 to exactly its trailing 4 digits, or null if it has
 *  no usable digits (so a blank/short value never spuriously "recommends"). */
function normalizeLast4(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : digits.length > 0 ? digits : null;
}

// Both listing and resolving must use the same current inventory. Keep the
// latest-per-client selection in one SQL fragment, rather than let a stale ID
// resolve against a household that is no longer offered in the picker.
// This differs from getAssignedAssetMapDetail: an existing assignment continues
// resolving its stored folder, whereas a new choice must use the newest run.
const assignableLiveHouseholds = Prisma.sql`
  SELECT DISTINCT ON (COALESCE(NULLIF(btrim(h.client_name), ''), h.source_folder_id))
         h.source_folder_id, h.id, h.client_name
  FROM mirror.acat_asset_map_household h
  WHERE h.superseded_by IS NULL AND h.source_folder_id IS NOT NULL
  ORDER BY COALESCE(NULLIF(btrim(h.client_name), ''), h.source_folder_id),
           h.processed_at DESC NULLS LAST, h.synced_at DESC, h.id
`;

/** A directory client whose linked asset-map folders the intake may offer. */
export type AssetMapClientScope = { clientSfId: string; householdSfId: string | null };

const sfIdMatch = (column: Prisma.Sql, sfId: string): Prisma.Sql =>
  Prisma.sql`(${column} = ${sfId} OR (length(${sfId}) = 15 AND left(${column}, 15) = ${sfId}))`;

/** The folder has an auto-linked or confirmed folder link to the client or their household. */
function folderLinkedToClient(folder: Prisma.Sql, scope: AssetMapClientScope): Prisma.Sql {
  const household = scope.householdSfId?.trim();
  return Prisma.sql`EXISTS (
    SELECT 1 FROM mirror.acat_asset_map_link l
     WHERE l.source_folder_id = ${folder}
       AND l.match_status IN ('AUTO_LINKED', 'CONFIRMED')
       AND (${sfIdMatch(Prisma.sql`l.client_sf_id`, scope.clientSfId.trim())}
            ${household ? Prisma.sql`OR ${sfIdMatch(Prisma.sql`l.household_sf_id`, household)}` : Prisma.empty}))`;
}

async function readAssignableAssetMapAccounts(
  tx: Prisma.TransactionClient,
  currentTransferId: string | null,
  scope: AssetMapClientScope | null = null,
): Promise<RawRow[]> {
  return tx.$queryRaw<RawRow[]>`
      WITH live AS (${assignableLiveHouseholds}),
      accts AS (
        SELECT a.id AS account_id, live.source_folder_id,
               live.client_name AS household_name,
               a.custodian, a.account_number, a.account_type,
               a.account_holder, a.total_value
        FROM live
        JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
        -- S5: no longer require an account number — numberless accounts are
        -- valid picks, disambiguated by account_type. Custodian is still part
        -- of the key so it must be present.
        WHERE a.custodian IS NOT NULL
          ${scope ? Prisma.sql`AND ${folderLinkedToClient(Prisma.sql`live.source_folder_id`, scope)}` : Prisma.empty}
      )
      -- Preserve the existing logical grouping. The schema has a physical ID
      -- primary key, but no uniqueness constraint on this logical account key.
      -- A representative ID must not split an existing picker row into several.
      SELECT MIN(accts.account_id) AS account_id,
             accts.source_folder_id,
             accts.household_name,
             accts.custodian,
             accts.account_number,
             accts.account_type,
             accts.account_holder,
             accts.total_value,
             COUNT(t.id)::int AS linked_count,
             COALESCE(
               array_agg(DISTINCT trim(
                 COALESCE(t.client_first_name, '') || ' ' || COALESCE(t.client_last_name, '')
               )) FILTER (WHERE t.id IS NOT NULL),
               ARRAY[]::text[]
             ) AS linked_clients
      FROM accts
      -- NULL-safe key match (S5): account_number/type may be NULL, so IS NOT
      -- DISTINCT FROM (folder + custodian are non-null equality).
      LEFT JOIN app.transfer t
        ON t.asset_map_folder_id      = accts.source_folder_id
       AND t.asset_map_custodian      = accts.custodian
       AND t.asset_map_account_number IS NOT DISTINCT FROM accts.account_number
       AND t.asset_map_account_type   IS NOT DISTINCT FROM accts.account_type
       AND (${currentTransferId}::text IS NULL OR t.id <> ${currentTransferId})
      WHERE NOT EXISTS (
        SELECT 1 FROM app.transfer tc
        WHERE tc.asset_map_folder_id      = accts.source_folder_id
          AND tc.asset_map_custodian      = accts.custodian
          AND tc.asset_map_account_number IS NOT DISTINCT FROM accts.account_number
          AND tc.asset_map_account_type   IS NOT DISTINCT FROM accts.account_type
          AND tc.id = ${currentTransferId}
      )
      GROUP BY accts.source_folder_id, accts.household_name, accts.custodian,
               accts.account_number, accts.account_type, accts.account_holder,
               accts.total_value
      ORDER BY accts.household_name NULLS LAST, accts.custodian,
               accts.account_number NULLS LAST, accts.account_type NULLS LAST`;
}

/**
 * List the mapping accounts assignable to a transfer, split into `recommended`
 * (account_number ends in the deal's last-4) and `others`. Already-linked
 * accounts are INCLUDED and annotated with `linkedTransferCount` + the linking
 * clients (S4 reuse); only the account linked to `currentTransferId` is excluded.
 * Read-only, one RLS-scoped read; masked numbers.
 */
export async function listAssignableAssetMapAccounts(
  id: Identity,
  opts: { hrqjSbevsbySbin8?: string | null; currentTransferId?: string | null; client?: AssetMapClientScope } = {},
): Promise<AssignableAssetMapAccounts> {
  const last4 = normalizeLast4(opts.hrqjSbevsbySbin8);
  const rows = await withUserScope(id, (tx) =>
    readAssignableAssetMapAccounts(tx, opts.currentTransferId ?? null, opts.client ?? null),
  );

  const recommended: AssetMapAccountOption[] = [];
  const others: AssetMapAccountOption[] = [];
  for (const r of rows) {
    const option: AssetMapAccountOption = {
      accountId: r.account_id,
      sourceFolderId: r.source_folder_id,
      custodian: r.custodian,
      accountNumberMasked: maskAccount(r.account_number),
      accountType: r.account_type,
      accountHolder: r.account_holder,
      householdName: r.household_name,
      totalValue: r.total_value == null ? null : Number(r.total_value),
      linkedTransferCount: Number(r.linked_count),
      linkedTransferClients: r.linked_clients ?? [],
    };
    // Recommended only when there's a number to match the deal's last-4 against.
    if (
      last4 != null &&
      r.account_number != null &&
      r.account_number.replace(/\D/g, "").slice(-4) === last4
    ) {
      recommended.push(option);
    } else {
      others.push(option);
    }
  }
  return { recommended, others };
}

/** Server-only durable assignment key. Never return this in an action response. */
export type AssignableAssetMapAccountKey = {
  sourceFolderId: string;
  custodian: string;
  accountNumber: string | null;
  accountType: string | null;
};

/**
 * Resolve a picker ID using the current eligible inventory, inside the caller's
 * existing withUserScope transaction. RLS and the shared latest-per-client
 * selection reject forbidden, missing and stale IDs. Last-4 is display/matching
 * assistance only; it is never used to identify the selected account.
 * Reuse across transfers remains allowed, so no transfer is excluded here.
 */
export async function resolveAssignableAssetMapAccount(
  tx: Prisma.TransactionClient,
  accountId: string,
  scope: AssetMapClientScope | null = null,
): Promise<AssignableAssetMapAccountKey | null> {
  if (!accountId) return null;
  // Lookup the selected PK rather than recomputing transfer reuse annotations
  // for the whole inventory. The sibling minimum preserves the list's existing
  // logical grouping: only its representative ID can be submitted.
  const rows = await tx.$queryRaw<
    Pick<RawRow, "source_folder_id" | "custodian" | "account_number" | "account_type">[]
  >`
    WITH live AS (${assignableLiveHouseholds})
    SELECT live.source_folder_id, a.custodian, a.account_number, a.account_type
    FROM live
    JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
    WHERE a.id = ${accountId}
      AND a.custodian IS NOT NULL
      ${scope ? Prisma.sql`AND ${folderLinkedToClient(Prisma.sql`live.source_folder_id`, scope)}` : Prisma.empty}
      AND a.id = (
        SELECT MIN(sibling.id)
        FROM mirror.acat_asset_map_account sibling
        WHERE sibling.household_id = a.household_id
          AND sibling.custodian = a.custodian
          AND sibling.account_number IS NOT DISTINCT FROM a.account_number
          AND sibling.account_type IS NOT DISTINCT FROM a.account_type
          AND sibling.account_holder IS NOT DISTINCT FROM a.account_holder
          AND sibling.total_value IS NOT DISTINCT FROM a.total_value
      )`;
  const account = rows[0];
  if (!account) return null;
  return {
    sourceFolderId: account.source_folder_id,
    custodian: account.custodian,
    accountNumber: account.account_number,
    accountType: account.account_type,
  };
}

/** One position line of the ASSIGNED account (display projection — numerics
 *  Number()-coerced at the seam; NULLs stay null). */
export type AssignedMapPosition = {
  symbol: string | null;
  description: string | null;
  quantity: number | null;
  marketValue: number | null;
  /** effective_status wins over transfer_eligible (the override-aware value). */
  eligibility: string | null;
};

/** The assigned account's detail for the hub expansion. Account number is
 *  returned MASKED ONLY (§6 posture) — the raw number never leaves this seam. */
export type AssignedAssetMapDetail = {
  custodian: string;
  accountNumberMasked: string | null; // null when the account has no number (S5)
  accountHolder: string | null;
  householdName: string | null;
  accountType: string | null;
  /** ISO day (YYYY-MM-DD) or null. */
  statementDate: string | null;
  totalValue: number | null;
  cashBalance: number | null;
  positions: AssignedMapPosition[];
};

type RawAccountDetailRow = {
  id: string;
  household_name: string | null;
  account_holder: string | null;
  account_type: string | null;
  statement_date: unknown; // Date | null at runtime
  cash_balance: unknown; // Decimal | null
  total_value: unknown; // Decimal | null
};

type RawPositionRow = {
  symbol: string | null;
  description: string | null;
  quantity: unknown; // Decimal | null
  market_value: unknown; // Decimal | null
  transfer_eligible: string | null;
  effective_status: string | null;
};

/** numeric → Number()-or-null at the seam (never a raw Decimal to the UI). */
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/** `date` column → ISO YYYY-MM-DD string or null (UTC — the column is a plain
 *  day, not an instant). */
function isoDayOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * The ASSIGNED mapping account's detail (facts + positions) for the funding-
 * picture hub expansion, keyed by THIS transfer's assignment key (folder +
 * custodian + account_number + account_type — S5 added type so numberless
 * same-custodian siblings resolve distinctly; number/type match NULL-safe). Under
 * the S4 reuse model an account may back several transfers — this read is per-
 * transfer by construction (it reads the key stored on the caller's
 * transfer) and is unaffected by other links. Resolves the LIVE household by the
 * STORED folder key, so its live CTE stays keyed on source_folder_id (superseded
 * rows excluded). NOTE: this deliberately DIFFERS from
 * listAssignableAssetMapAccounts's `live`, which dedupes per-client to collapse a
 * stale mirror's repeated folders — that collapse is wrong here (this read must
 * find the exact stored folder, not the client's newest one). No live row
 * matching the key → null (stale assignment — the caller renders a visible "not
 * found" note; the stored assignment is never touched here). Read-only, one
 * RLS-scoped read (two statements); masked number only — the raw account number
 * never leaves this seam, and nothing is logged.
 */
export async function getAssignedAssetMapDetail(
  id: Identity,
  key: {
    folderId: string;
    custodian: string;
    accountNumber: string | null;
    accountType: string | null;
  },
): Promise<AssignedAssetMapDetail | null> {
  return withUserScope(id, async (tx) => {
    const accounts = await tx.$queryRaw<RawAccountDetailRow[]>`
      WITH live AS (
        SELECT DISTINCT ON (h.source_folder_id)
               h.source_folder_id, h.id, h.client_name
        FROM mirror.acat_asset_map_household h
        WHERE h.superseded_by IS NULL AND h.source_folder_id IS NOT NULL
        ORDER BY h.source_folder_id, h.processed_at DESC NULLS LAST, h.synced_at DESC
      )
      SELECT a.id,
             live.client_name AS household_name,
             a.account_holder,
             a.account_type,
             a.statement_date,
             a.cash_balance,
             a.total_value
      FROM live
      JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
      WHERE live.source_folder_id = ${key.folderId}
        AND a.custodian = ${key.custodian}
        AND a.account_number IS NOT DISTINCT FROM ${key.accountNumber}
        AND a.account_type   IS NOT DISTINCT FROM ${key.accountType}
      LIMIT 1`;
    const account = accounts[0];
    if (account == null) return null;

    const positions = await tx.$queryRaw<RawPositionRow[]>`
      SELECT symbol, description, quantity, market_value,
             transfer_eligible, effective_status
      FROM mirror.acat_asset_map_position
      WHERE account_id = ${account.id}
      ORDER BY market_value DESC NULLS LAST, symbol NULLS LAST`;

    return {
      custodian: key.custodian,
      accountNumberMasked: maskAccount(key.accountNumber),
      accountHolder: account.account_holder,
      householdName: account.household_name,
      accountType: account.account_type,
      statementDate: isoDayOrNull(account.statement_date),
      totalValue: numOrNull(account.total_value),
      cashBalance: numOrNull(account.cash_balance),
      positions: positions.map((p) => ({
        symbol: p.symbol,
        description: p.description,
        quantity: numOrNull(p.quantity),
        marketValue: numOrNull(p.market_value),
        eligibility: p.effective_status ?? p.transfer_eligible,
      })),
    };
  });
}

// ── Partial-ACAT "what to transfer" positions ────────────────────────────────
// The linked asset-map account's positions (symbol + value + COST BASIS) with a
// resolved is-transferring flag: the AOA per-(transfer,symbol) override wins,
// else the pipeline's `transferring`, else false. One withUserScope read joins
// the mirror positions to app.transfer_position_flag. Returns null when the
// account doesn't resolve (no link / not visible) so the caller can fall back.

export type PartialAcatPosition = {
  symbol: string;
  description: string | null;
  marketValue: number | null;
  costBasis: number | null;
  isTransferring: boolean;
  /** advisory only — the pipeline says this position isn't transfer-eligible. */
  ineligible: boolean;
};

/** Frozen source facts saved with an approved funding plan. */
export type AssetMapApprovalSnapshot = {
  statementDate: string | null;
  positions: Array<{
    symbol: string;
    description: string | null;
    marketValue: number | null;
    costBasis: number | null;
    ineligible: boolean;
    isTransferring: boolean;
    /** Trimmed, uppercased effective_status ?? transfer_eligible ("" when both null). */
    status: string;
  }>;
};

/** PURE resolver: AOA override wins, else the pipeline flag, else false. */
export function resolvePositionTransferring(
  override: boolean | null,
  pipeline: boolean | null,
): boolean {
  if (override !== null) return override;
  return pipeline ?? false;
}

type RawPartialPositionRow = {
  symbol: string;
  description: string | null;
  market_value: unknown;
  cost_basis: unknown;
  pipeline_transferring: boolean | null;
  effective_status: string | null;
  transfer_eligible: string | null;
  override_is_transferring: boolean | null;
};

/**
 * Resolve the current linked account and its source positions inside an
 * existing user-scoped transaction. Approval uses this instead of trusting
 * values posted by the browser; a changed symbol set then fails closed.
 */
export async function getAssetMapApprovalSnapshot(
  tx: Prisma.TransactionClient,
  key: {
    transferId?: string;
    folderId: string;
    custodian: string;
    accountNumber: string | null;
    accountType: string | null;
  },
): Promise<AssetMapApprovalSnapshot | null> {
  const accounts = await tx.$queryRaw<
    { id: string; statement_date: unknown }[]
  >`
    WITH live AS (
      SELECT DISTINCT ON (h.source_folder_id)
             h.source_folder_id, h.id
      FROM mirror.acat_asset_map_household h
      WHERE h.superseded_by IS NULL AND h.source_folder_id IS NOT NULL
      ORDER BY h.source_folder_id, h.processed_at DESC NULLS LAST, h.synced_at DESC
    )
    SELECT a.id, a.statement_date
    FROM live
    JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
    WHERE live.source_folder_id = ${key.folderId}
      AND a.custodian = ${key.custodian}
      AND a.account_number IS NOT DISTINCT FROM ${key.accountNumber}
      AND a.account_type   IS NOT DISTINCT FROM ${key.accountType}
    LIMIT 1`;
  const account = accounts[0];
  if (account == null) return null;

  const rows = await tx.$queryRaw<RawPartialPositionRow[]>`
    SELECT p.symbol, p.description, p.market_value, p.cost_basis,
           p.transferring AS pipeline_transferring,
           p.effective_status, p.transfer_eligible,
           f.is_transferring AS override_is_transferring
    FROM mirror.acat_asset_map_position p
    LEFT JOIN app.transfer_position_flag f
      ON f.transfer_id = ${key.transferId ?? null} AND f.symbol = p.symbol
    WHERE p.account_id = ${account.id} AND p.symbol IS NOT NULL
    ORDER BY p.market_value DESC NULLS LAST, p.symbol NULLS LAST`;

  return {
    statementDate: isoDayOrNull(account.statement_date),
    positions: rows.map((row) => {
      const status = (row.effective_status ?? row.transfer_eligible ?? "")
        .trim()
        .toUpperCase();
      const ineligible = status !== "ACAT";
      return {
        symbol: row.symbol,
        description: row.description,
        marketValue: numOrNull(row.market_value),
        costBasis: numOrNull(row.cost_basis),
        ineligible,
        status,
        isTransferring: resolvePositionTransferring(
          row.override_is_transferring, row.pipeline_transferring ?? !ineligible,
        ),
      };
    }),
  };
}

export async function getPartialAcatPositions(
  id: Identity,
  key: {
    transferId: string;
    folderId: string;
    custodian: string;
    accountNumber: string | null;
    accountType: string | null;
  },
): Promise<PartialAcatPosition[] | null> {
  return withUserScope(id, async (tx) => {
    // Resolve the linked account exactly as getAssignedAssetMapDetail does.
    const accounts = await tx.$queryRaw<{ id: string }[]>`
      WITH live AS (
        SELECT DISTINCT ON (h.source_folder_id)
               h.source_folder_id, h.id
        FROM mirror.acat_asset_map_household h
        WHERE h.superseded_by IS NULL AND h.source_folder_id IS NOT NULL
        ORDER BY h.source_folder_id, h.processed_at DESC NULLS LAST, h.synced_at DESC
      )
      SELECT a.id
      FROM live
      JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
      WHERE live.source_folder_id = ${key.folderId}
        AND a.custodian = ${key.custodian}
        AND a.account_number IS NOT DISTINCT FROM ${key.accountNumber}
        AND a.account_type   IS NOT DISTINCT FROM ${key.accountType}
      LIMIT 1`;
    const account = accounts[0];
    if (account == null) return null;

    const rows = await tx.$queryRaw<RawPartialPositionRow[]>`
      SELECT p.symbol, p.description, p.market_value, p.cost_basis,
             p.transferring AS pipeline_transferring,
             p.effective_status, p.transfer_eligible,
             f.is_transferring AS override_is_transferring
      FROM mirror.acat_asset_map_position p
      LEFT JOIN app.transfer_position_flag f
        ON f.transfer_id = ${key.transferId} AND f.symbol = p.symbol
      WHERE p.account_id = ${account.id} AND p.symbol IS NOT NULL
      ORDER BY p.market_value DESC NULLS LAST, p.symbol NULLS LAST`;

    return rows.map((r) => {
      // The pipeline classifies each position's transfer-eligibility in
      // effective_status / transfer_eligible. The vocab is ACAT (transfers via
      // ACAT — eligible), LIQUIDATE, REVIEW, UNSUPPORTED. Eligible ⟺ "ACAT".
      const isAcat =
        (r.effective_status ?? r.transfer_eligible ?? "")
          .trim()
          .toUpperCase() === "ACAT";
      // Default is-transferring: the pipeline's explicit boolean if set, else the
      // eligibility classification (an ACAT-eligible position defaults to
      // transferring). The pipeline rarely populates the boolean, so eligibility
      // is the real seed. Ops overrides win over both (resolvePositionTransferring).
      const pipelineDefault = r.pipeline_transferring ?? isAcat;
      return {
        symbol: r.symbol,
        description: r.description,
        marketValue: numOrNull(r.market_value),
        costBasis: numOrNull(r.cost_basis),
        isTransferring: resolvePositionTransferring(
          r.override_is_transferring,
          pipelineDefault,
        ),
        // Advisory tag only for genuinely non-ACAT positions (LIQUIDATE/REVIEW/…).
        ineligible: !isAcat,
      };
    });
  });
}
