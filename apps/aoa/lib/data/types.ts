import type { EmailEnvelope } from "@/lib/email-search/envelope";
// Data-access seam contracts (TDD §3, ADR-1).
// These return types are the stable contract that Phase B screens (B1–B3) consume.
// Real functions query `mirror` via `withUserScope`; deferred functions return typed
// `lib/mock` fixtures through the *same* signature — wiring real data later means
// reimplementing the function body, never changing a component or page.

export type { Identity } from "@/lib/rls";
import type { AumSource, DealRow, DealStage } from "./deal-types";
import type { TradeRequestProfile } from "./trade-request-profile";

export type EmployeeBadgeStatus = "ACTIVE" | "FORMER" | null;

// --- Real (mirror-backed) ---------------------------------------------------

export type HouseholdRow = {
  sf_id: string;
  name: string;
  status: string | null;
  // Salesforce Entity_Client_Stage__c lifecycle: 'Client' | 'Prospect' |
  // 'Lost Client' | 'Lost Prospect' (free text — the source is authoritative;
  // null for rows synced before the all-stages feed or without a stage set).
  stage: string | null;
  aum: number | null;
  lead_advisor_email: string;
  // ticket: 'CLIENT' for every real (CRM-fed) household; 'FIRM' for the
  // synthetic "Cedar Ridge Wealth" firm household injected by the app layer. The
  // mirror.household column defaults to 'CLIENT'; the firm household reports
  // 'FIRM' from lib/data/firm-household (it is never a mirror.household row).
  household_kind: string;
};

// Households LIST row: HouseholdRow + real member count (join `mirror.client`
// on household_id — REAL B2 scope) and the advisor's display name resolved
// from `mirror.advisor` (fall back to lead_advisor_email when unmatched).
// tkt-households-aum-rollup: `aum` (inherited from HouseholdRow) is now the
// EFFECTIVE AUM — the same Apex-first fallback chain the detail page uses
// (Apex per-account SOD total → deals person_aum → mirror.household.aum),
// resolved in bulk by listHouseholds. null = unknown (all three sources empty)
// — rendered as an em dash, NEVER a fake $0. `aum_source` records which source
// won (null when the effective aum is null).
export type HouseholdListRow = HouseholdRow & {
  /** Authorized original labels for selectors; absent from bounded page rows. */
  source_names?: string[];
  member_count: number;
  advisor_name: string | null;
  aum_source: AumSource | null;
  employeeStatus: EmployeeBadgeStatus;
};

export type HouseholdMember = {
  sf_id: string;
  name: string;
  email: string | null;
  employeeStatus: EmployeeBadgeStatus;
};

// Client Portrait picker row: one client + its household context, RLS-scoped.
// Powers the /client-portrait index list (jump straight to any client without
// picking a household first). `household_stage` carries the SF lifecycle for a
// small context pill; `advisor_name` resolves from mirror.advisor (fall back to
// the email). household_* are null for a client with no household on file.
export type ClientListRow = {
  sf_id: string;
  name: string;
  household_id: string | null;
  household_name: string | null;
  household_stage: string | null;
  lead_advisor_email: string | null;
  advisor_name: string | null;
  employeeStatus: EmployeeBadgeStatus;
};

// ticket: a household's linked deals, rendered as a compact table on the
// detail page. A narrow projection of app.deal (only the columns the table
// needs) — NOT the full DealRow, which would drag in archive/ownership/PII
// fields the household view never shows. `amount` is Number()-coerced at the
// seam (the carried Decimal trap — see lib/data/households.ts / deals.ts).
export type HouseholdDeal = {
  id: string;
  name: string;
  client_first_name: string;
  client_last_name: string;
  stage: DealStage;
  amount: number; // Number() at the seam — never a raw Decimal
  close_date: Date | null;
  account_type: string | null;
  // tkt-deals-transferring-firm: the deal's sending/transferring firm (from the
  // report's "Sending Firm" or parsed from the deal name). Surfaced as a column
  // on the household Deals table; em-dash when null.
  transferring_firm: string | null;
  // tkt-deals-client-link (AUM layer): carried so getHousehold can recompute
  // managed AUM from the deals it already fetched — `householdAumFromDeals`
  // dedupes by client_sf_id (person_aum repeats across a client's deal rows)
  // and gates on full backfill. person_aum is Number()-coerced at the seam (a
  // numeric → never a Decimal). The Deals table component ignores both fields.
  client_sf_id: string | null;
  person_aum: number | null;
};

// Header stats for the Deals card: open pipeline $ (sum of amount for stages
// NOT in WON/LOST), total linked deal count, and the won-deal count (subtle
// sub-stat). Counts are Number()-coerced at the seam (COUNT(*) → bigint).
export type HouseholdDealSummary = {
  openPipeline: number;
  count: number;
  wonCount: number;
  outstandingCount: number;
  outstandingAmount: number;
  fundedCount: number;
  fundedAmount: number;
};

export type HouseholdDetail = HouseholdRow & {
  advisorName: string | null;
  members: HouseholdMember[];
  // ticket: deals linked to this household via the 15-char SF-id join.
  deals: HouseholdDeal[];
  dealSummary: HouseholdDealSummary;
  // Number of RLS-visible CRM household records represented by this one
  // reversible AOA canonical view. Source identifiers themselves stay server-
  // side; the UI may disclose only the count.
  canonicalSourceCount: number;
  // tkt-deals-client-link (AUM layer): `aum` (inherited from HouseholdRow) is
  // now the RECOMPUTED managed AUM — householdAumFromDeals(deals) once the feed
  // has FULLY backfilled the household's client_sf_id/person_aum, else the
  // mirror.household.aum fallback. `aumSource` records which one won.
  // tkt account-AUM feed prepends "apex" (the Warehouse per-account SOD total)
  // ahead of "deals" and "mirror" in the fallback chain.
  aumSource: "apex" | "custodians" | "deals" | "mirror" | null;
  // True only during the migration-to-first-governed-snapshot window. The
  // household headline must show pending rather than falling back to old data.
  aumPending: boolean;
  employeeStatus: EmployeeBadgeStatus;
};

export type ClientDetail = {
  sf_id: string;
  name: string;
  email: string | null;
  employeeStatus: EmployeeBadgeStatus;
  household: HouseholdRow | null;
  // The internal Apex/DriveWealth bridge id (mirror.client.cedar_ridge_user_id).
  // PRESENT ONLY for ADMIN/OPERATIONS viewers — the data seam omits the key for
  // every other role (lib/data/client-field-authz.ts), so it never reaches the
  // client payload for advisors/client-service/VIEWER. Optional by design.
  cedarRidgeUserId?: string | null;
};

// A CRM/Salesforce Task mirrored into mirror.task, surfaced on the Client
// Portrait at the HOUSEHOLD level (Task.AccountId → household; the per-person
// WhoId is FLS-blocked). `source_modified_at` is a Postgres timestamptz → a
// Date at runtime; a Date is serializable across the Server→Client boundary, so
// it is left as-is (no seam coercion needed).
export type HouseholdTask = {
  sf_id: string;
  subject: string | null;
  status: string | null;
  priority: string | null;
  description: string | null;
  source_modified_at: Date | null;
};

// Bounded household history adds source-confirmed assignment display only.
// Keep the legacy meeting-preparation task contract above unchanged, and keep
// source owner IDs and observation timestamps out of the browser payload.
export type HouseholdTaskHistoryRow = HouseholdTask & {
  assignment_state: "ASSIGNED" | "UNASSIGNED" | "UNAVAILABLE";
  assignee_type: "USER" | "QUEUE" | null;
  assignee_name: string | null;
};

// A CRM/Salesforce email mirrored into mirror.email, surfaced on the Client
// Portrait at the HOUSEHOLD level (Task.AccountId → household; the per-person
// WhoId is FLS-blocked). `sent_at`/`source_modified_at` are Postgres timestamptz
// → Date at runtime; a Date is serializable across the Server→Client boundary,
// so both are left as-is (no seam coercion needed). `body` is cleaned,
// disclaimer-stripped and capped upstream in the feed.
export type HouseholdEmail = {
  email_envelope?: EmailEnvelope | null;
  sf_id: string;
  subject: string | null;
  body: string | null;
  sent_at: Date | null;
  source_modified_at: Date | null;
};

export type ZendeskTicketComment = {
  zendesk_comment_id: string;
  author_id: string;
  body: string;
  created_at: Date;
};

/** Zendesk ticket content mirrored for an RLS-visible contact/household. Only
 * the initial description and public comments are carried; internal notes and
 * attachments never cross the ingest seam. */
export type ZendeskTicket = {
  zendesk_ticket_id: string;
  requester_id: string;
  subject: string | null;
  description: string | null;
  status: string;
  priority: string | null;
  ticket_type: string | null;
  ticket_url: string;
  created_at: Date;
  source_updated_at: Date;
  comments_truncated: boolean;
  comments: ZendeskTicketComment[];
};

// A CRM/Salesforce call-log Task (TaskSubtype='Call') mirrored into
// mirror.activity, surfaced on the Client Portrait "Activity & notes" card at
// the HOUSEHOLD level (Task.AccountId → household; the per-person WhoId is
// FLS-blocked). `note` is the Salesforce Description. `activity_at` (CreatedDate)
// and `source_modified_at` (LastModifiedDate) are Postgres timestamptz → Date at
// runtime; a Date is serializable across the Server→Client boundary, so both are
// left as-is (no seam coercion needed).
export type HouseholdActivity = {
  sf_id: string;
  subject: string | null;
  note: string | null;
  activity_at: Date | null;
  owner_name: string | null;
  source_modified_at: Date | null;
};

// --- Command Center (all mock now) ------------------------------------------

export type FunnelStage = {
  stage: string;
  count: number;
  desc: string;
  tone: "green" | "gold" | "blue" | "amber" | "red";
};

export type Meeting = {
  client: string;
  clientId: string;
  /**
   * STABLE per-meeting identity — `mirror.appointment.external_key` for live
   * rows, a synthetic fixture id for the mocks. This, NOT `clientId`, is what
   * the card keys rows and prep lookups on: `client_sf_id` is a best-effort
   * name match and is "often null" (the mirror_appointment migration), so a
   * clientId-keyed map silently collapses every unlinked meeting onto "".
   */
  key: string;
  when: string;
  type: string;
  prepReady: boolean;
  /** True when the meeting's start is in the past — the card shows it as
   *  "Completed" rather than hiding it. Optional: mock fixtures omit it
   *  (treated as upcoming). */
  past?: boolean;
};

/**
 * A STORED, AI-generated meeting-prep brief (app.meeting_prep) — the live
 * counterpart of the mock `MeetingPrep` fixture. Freeform markdown with the six
 * fixed headings the meeting_prep DraftKind asks for, plus the provenance the
 * panel shows on the "Generated …" line. Keyed by MEETING KEY, never clientId.
 */
export type MeetingPrepBrief = {
  /** The generated markdown. Client PII — never logged, never audited. */
  text: string;
  generatedAt: Date;
  /** The model that actually answered (may be the gemini.ts fallback). */
  model: string;
  /** Verbatim candidate finishReason; non-STOP drives a "may be truncated" note. */
  finishReason: string | null;
  /** True when caps or the char budget dropped part of the context. */
  truncated: boolean;
  /** Lifetime generation count for this row (throttle, meeting-prep-view.ts). */
  generations: number;
  generatedBy: string | null;
  /**
   * NON-NULL when this brief is ATTACHED to the client portrait (Save). NULL =
   * a Command-Center working artifact only. Save/unsave flips it; Regenerate
   * deliberately leaves it alone, so re-running a saved brief keeps it attached.
   */
  savedAt: Date | null;
};

/**
 * A saved brief as the Client Portrait reads it: the brief plus the two things
 * the card needs that the Command Center gets from the appointment row instead —
 * WHICH meeting it was for (`startsAt`) and its stable key (for the panel).
 * `savedAt` is non-null by construction: the read filters on it.
 */
export type SavedMeetingPrepBrief = MeetingPrepBrief & {
  appointmentKey: string;
  startsAt: Date;
  savedAt: Date;
  savedBy: string | null;
};

export type StalledItem = {
  what: string;
  type: string;
  age: string;
};

export type Signal = {
  client: string;
  signal: string;
  type: string;
  time: string;
  src: string;
  role: string;
};

export type CommandCenterData = {
  funnel: FunnelStage[];
  meetings: Meeting[];
  stalled: StalledItem[];
  signals: Signal[];
  // P1 (ticket) meetings-section additions — all mock until Phase D calendar.
  meetingsNextWeek: Meeting[];
  meetingWeekRanges: { thisWeek: string; nextWeek: string };
  // MOCK prep payloads for meeting rows, keyed by client sf_id (null = none on
  // file). Still the fixture seam for the mock Command Center.
  meetingPrep: Record<string, MeetingPrep | null>;
  // LIVE, AI-generated briefs (app.meeting_prep), keyed by MEETING KEY. Separate
  // from `meetingPrep` rather than widening it: the two have different shapes,
  // different keys and different lifetimes, and keeping them apart means the
  // AI_MEETING_PREP=OFF path is byte-identical to today (SC-1). Always {} when
  // the flag is off.
  meetingBriefs: Record<string, MeetingPrepBrief | null>;
};

// --- Client Portrait (identity real; the rest mock) -------------------------

export type PortraitEmail = {
  from: string;
  time: string;
  subject: string;
  preview: string;
  unread: boolean;
};

export type PortraitFeedItem = {
  kind: string;
  time: string;
  title: string;
  desc: string;
};

export type RiskProfile = {
  score: number;
  tolerance: string;
  capacity: string;
  change: string;
};

// --- P1 parity (ticket): accounts / tax budget / meeting prep --------------
// The shapes remain stable while their backing sources mature. Apex accounts
// and tax budgets are now real/RLS-scoped; deferred account details and the
// fallback meeting-prep fixtures remain invented sample data.

export type ApexAccount = {
  /** Stable key for server-authorized form selection. Absent on legacy mocks. */
  id?: string;
  /** Actual Apex number; never use the display fallback as an account number. */
  apexAccountNumber?: string | null;
  type: string;
  num: string; // account number (mock: masked "••••2100"; real: apex_account_number)
  // Free-text status: the mock uses "Active"/"Funding"; the real feed maps the
  // Apex account_status through verbatim (tkt). AccountsSection maps the status
  // to a Pill tone (OPEN/ACTIVE→green, FUNDING/PENDING→amber, CLOSED/RESTRICTED/
  // other→gray).
  status: string;
  /** Lifecycle metadata for form preparation; not inferred from the balance. */
  closeDate?: string | null;
  sourcePresent?: boolean;
  // null when the feed has no valuation for the account (unknown) — rendered as
  // an em dash, NOT "$0". A genuine $0 balance stays 0 and renders "$0".
  value: number | null;
  // Real mirror rows always set this. Legacy mock fixtures omit it and are
  // treated as display-ready; a false OPEN row is a rollout-pending balance.
  balanceCurrent?: boolean;
};

export type ExternalAccount = {
  inst: string;
  type: string;
  num: string;
  /** Holdings total for live rows (0 when unknown; see holdingsTotal). */
  balance: number;
  /** Mirror id of a live Plaid-linked summary row. Absent on mock fixtures. */
  externalAccountId?: string;
  cash?: number | null;
  securities?: number | null;
  /** Null when the mirror has no holdings total; rendered as unavailable. */
  holdingsTotal?: number | null;
  asOf?: string | null;
  institutionBalance?: number | null;
};

/** Display-only custodial balance. Never a form/report authorization input. */
export type InvestmentAccount = Omit<ApexAccount, "id" | "apexAccountNumber" | "balanceCurrent"> & {
  id: string;
  sourceAccountId: string;
  custodian: "Apex" | "Schwab";
  cash: number | null;
  securities: number | null;
  balanceAsOf: string | null;
  balanceCurrent: boolean;
  closeDate: string | null;
  closeDateSource: "APEX" | "PROVISIONAL_OVERRIDE" | null;
  clientSfId: string | null;
  householdSfId: string | null;
  firmOperating: boolean;
};

export type Beneficiary = {
  name: string;
  rel: string;
  pct: number;
  dob: string;
  acct: string; // owning account type label
  num: string; // owning account masked number (grouping key)
};

export type ClientAccounts = {
  apex: ApexAccount[];
  /** Real display seam; optional only for older synthetic preview fixtures. */
  investment?: InvestmentAccount[];
  ext: ExternalAccount[];
  bene: Beneficiary[];
  plaidLinked: boolean;
  /** True only when ext came from the RLS-scoped linked-account summary mirror. */
  plaidSummariesLive?: boolean;
  prospect?: boolean;
};

export type TaxBudgetYear = {
  budget: number;
  realized: number;
  note: string;
};

// `current` = the active tax year's budget (null when not set); `prior` = the
// most recent earlier year on file (drives the amber "needs update" state).
export type TaxBudget = {
  year: number;
  current: TaxBudgetYear | null;
  prior: { year: number; budget: number } | null;
};

export type MeetingPrep = {
  advisor: string;
  aum: string;
  tenure: string;
  riskProfile: string;
  lastMeeting: string;
  recentSignals: string[];
  openItems: string[];
  talkingPoints: string;
  notes: string;
};

export type PortraitDetail = {
  client: ClientDetail;
  feed: PortraitFeedItem[];
  risk: RiskProfile;
  riskFlag: string | null;
  instructions: { label: string; value: string }[];
  // Development-only, future-API-shaped Trade Request profile. null outside
  // canonical dev so production retains the existing preview until the live
  // read contract and owner rollout are separately approved.
  tradeRequestProfile: TradeRequestProfile | null;
  portrait: Record<string, string>;
  // tkt-deals-client-link: the client's REAL deals (via app.deal.client_sf_id
  // = mirror.client.sf_id), replacing the former single-stage mock. Empty when
  // the client has no sf_id or no linked deals. Was `deal: { stage } | null`.
  deals: DealRow[];
  // tkt-deals-client-link (AUM layer): the client's own managed AUM
  // (clientPersonAum over their deals — person_aum repeats, so first non-null),
  // and the household-context AUM shown in the header, made consistent with the
  // Household detail page: householdAumFromDeals(householdDeals) with the
  // mirror.household.aum fallback. Both null until the feed backfills.
  clientAum: number | null;
  householdAum: number | null;
  clientAumPending: boolean;
  householdAumPending: boolean;
  accounts: ClientAccounts;
  taxBudget: TaxBudget;
  prep: MeetingPrep | null;
  // Household-keyed CRM tasks/emails/activity are NOT on the portrait —
  // they link to the household (Task.AccountId), not the person (WhoId is
  // FLS-blocked), so they render on the Household detail page. See
  // HouseholdTask/HouseholdEmail/HouseholdActivity (still used by the seams and
  // the cards, now consumed by the household page).
};
