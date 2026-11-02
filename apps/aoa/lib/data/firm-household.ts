// ticket — the "Cedar Ridge Wealth" firm household: a static, app-side seed that
// represents the firm's own corporate custodian accounts as a self-contained
// household. PURE (no Prisma, no React) so the cron feed, the data seams, the
// pages, and the unit tests all share ONE source of truth.
//
// WHY app-side (not the warehouse): Warehouse card 6601 emits a NULL
// `household_sf_id` for these 4 accounts (they belong to no Salesforce client
// household). The APP — not the warehouse — knows they are the firm's, so the
// ULID→household attribution and the display titles live here as a fixed seed.
// The daily feed OVERRIDES the card's NULL household_sf_id to FIRM_HOUSEHOLD_ID
// for any account whose custodian ULID is in FIRM_ACCOUNT_IDS below.

/** Sentinel Salesforce-shaped id for the synthetic firm household. No real SF
 *  household id collides with it (SF ids are 15/18-char alnum), and it is short
 *  enough that the left(...,15) width-normalization joins compare it verbatim. */
export const FIRM_HOUSEHOLD_ID = "FIRM-CEDAR-RIDGE";

/** Display name of the firm household (Households list + detail header). */
export const FIRM_HOUSEHOLD_NAME = "Cedar Ridge Wealth";

/** Sentinel lead-advisor email. No real advisor logs in as this, so the existing
 *  household_own_book RLS predicate (lead_advisor_email = the caller's email)
 *  never matches it for an advisor — belt to the role-gate suspenders below. */
export const FIRM_HOUSEHOLD_ADVISOR_EMAIL = "firm@example.com";

/** household_kind flag values (mirror.household gains a `household_kind` column,
 *  NOT NULL DEFAULT 'CLIENT'; the synthetic firm household reports 'FIRM'). */
export const HOUSEHOLD_KIND_CLIENT = "CLIENT";
export const HOUSEHOLD_KIND_FIRM = "FIRM";

/** The 4 firm corporate accounts, keyed by their custodian ULID (ALWAYS present
 *  in card 6601; these rows carry a NULL apex_account_number). The label is the
 *  display title shown on the firm household's Combined-accounts card. */
export const FIRM_ACCOUNT_TITLES: Readonly<Record<string, string>> = {
  "01SYNTH6BDYNAGTJ07KC0SFYGY": "Fee Account",
  "01SYNTH69JZYE3TD78SPZ4PBWK": "Deposit Account",
  "01SYNTH1B11MYXFS3Q5B5D2WNW": "Error Account",
  "01SYNTH85BR7BT1ZPYKBDZAC9C": "Allocation Account",
};

/** Fast membership set of the 4 firm custodian ULIDs. */
export const FIRM_ACCOUNT_IDS: ReadonlySet<string> = new Set(
  Object.keys(FIRM_ACCOUNT_TITLES),
);

/** True when a custodian ULID belongs to the firm household seed. */
export function isFirmAccount(custodianAccountId: string | null | undefined): boolean {
  return custodianAccountId != null && FIRM_ACCOUNT_IDS.has(custodianAccountId);
}

/** The firm account's display title, or null when the ULID is not a firm account. */
export function firmAccountTitle(
  custodianAccountId: string | null | undefined,
): string | null {
  if (custodianAccountId == null) return null;
  return FIRM_ACCOUNT_TITLES[custodianAccountId] ?? null;
}

/** Roles allowed to see the firm household and its accounts: ADMIN / OPERATIONS
 *  only. This mirrors, in TS, the mirror RLS `*_ops_all` policies — the firm
 *  household is synthetic (never a mirror.household row), so the TS layer that
 *  injects it must gate it the same way the DB would. */
export const FIRM_HOUSEHOLD_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

/** True when the caller's role may see the firm household (and its accounts). */
export function canSeeFirmHousehold(role: string | null | undefined): boolean {
  return role != null && FIRM_HOUSEHOLD_ROLES.has(role);
}

/** Split a firm-wide AUM sum into Client (excludes FIRM) vs Total (includes
 *  FIRM). PURE + penny-exact: rounds to whole cents so a float subtraction never
 *  leaks a sub-cent tail (e.g. 25335920.80 − 87604.38 → exactly 25248316.42).
 *  `total` = SUM over ALL account rows (ties to Apex's report); `firm` = SUM
 *  over the firm household's accounts; `client` = total − firm. */
export function splitAum(
  total: number,
  firm: number,
): { total: number; firm: number; client: number } {
  const client = Math.round((total - firm) * 100) / 100;
  return { total, firm, client };
}
