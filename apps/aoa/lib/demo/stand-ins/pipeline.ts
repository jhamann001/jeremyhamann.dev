import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { aoaRuntimeServiceAccount } from "@/lib/data/asset-map";
import { isAccountTypeOption, isPositionStatus } from "@/components/asset-mapping/workspace/edits/edit-model";
import { recordOutbox } from "../outbox";
import { allHouseholdsPdf, householdPdf } from "./asset-map-pdf";
import { changeRecord, listRecords, readRecord, saveRecord } from "./store";
import type { StandInCall, StandInReply, StandInRoute } from "./fetch";

// The statement pipeline (the Statement Analyzer), answered in the demo. Its records are the household runs it read
// from statements, kept in the shape of its bulk API (/api/v1/households), plus each client folder's destination
// accounts and the mutual fund restriction list. AoA's own import reads the runs into its mirror tables exactly as in
// production, so the asset-mapping pages show what is here. Behaviour follows the pipeline's routes: soft removal,
// manual overrides on top of the engine's status, counts from the effective status. Client linking is not part of
// the demo (/api/config says so, and AoA hides it).

export interface PipelinePosition {
  id: string;
  symbol: string | null;
  description: string | null;
  quantity: number | null;
  market_value: number | null;
  asset_type: string | null;
  transfer_eligible: string | null;
  transfer_notes: string | null;
  override_status?: string | null;
  override_notes?: string | null;
  overridden_by?: string | null;
  overridden_at?: string | null;
  transferring?: "YES" | "NO" | null;
  transferring_by?: string | null;
  transferring_at?: string | null;
  deleted_at?: string | null;
  [field: string]: unknown;
}

export interface PipelineAccount {
  id: string;
  custodian: string | null;
  account_type: string | null;
  account_type_other?: string | null;
  account_number: string | null;
  account_holder?: string | null;
  statement_date?: string | null;
  total_value: number | null;
  is_rollover?: boolean;
  is_inherited?: boolean;
  apex_restriction?: string | null;
  deleted_at?: string | null;
  assets: PipelinePosition[];
  [field: string]: unknown;
}

export interface PipelineHousehold {
  id: string;
  client_name: string;
  run_number: number;
  processed_at: string;
  superseded_by: string | null;
  source_folder_id: string | null;
  docs_total?: number;
  docs_extracted?: number;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  updated_at?: string | null;
  accounts: PipelineAccount[];
  [field: string]: unknown;
}

export interface PipelineDestination {
  id: string;
  /** Empty once the destination is removed; the record stays, as removal is never a delete in the store. */
  source_folder_id: string;
  owner: string | null;
  target_account_type: string | null;
  existing_apex_number: string | null;
  needs_to_be_opened: boolean;
  /** Account numbers are kept whole and masked on the way out, as the pipeline does. */
  sources: { link_id: string; custodian: string | null; account_number: string | null }[];
}

export interface FundRestriction {
  symbol: string;
  /** Omnibus-eligible at Apex: transfers in kind. */
  omni: boolean;
}

/** One open account at the receiving custodian (the pipeline's active_accounts_roster), matched against a destination
 *  to suggest an existing account. `owner_norm` and `type_norm` are stored normalized, as the pipeline stores them. */
export interface RosterAccount {
  household: string | null;
  owner: string | null;
  owner_norm: string | null;
  account_type: string | null;
  type_norm: string | null;
  account_title_raw: string | null;
  trading_account_no: string | null;
  apex_number: string | null;
  total_value: number | null;
}

const ok = (json: unknown, status = 200): StandInReply => ({ status, json });
const notFound = (): StandInReply => ({ status: 404, json: { detail: "Not found" } });
const bad = (detail: string): StandInReply => ({ status: 400, json: { detail } });
const now = () => new Date().toISOString();
const caller = () => aoaRuntimeServiceAccount() ?? "aoa";
const live = <T extends { deleted_at?: string | null }>(rows: T[]) => rows.filter((r) => !r.deleted_at);
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hourCycle: "h23",
});

/** Midnight in New York on a calendar date, as an instant. */
function newYorkMidnight(year: number, month: number, day: number): number {
  const guess = Date.UTC(year, month - 1, day);
  const p = Object.fromEntries(NEW_YORK.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return guess - (shown - guess);
}

// strptime's %B and %b: a month's full name or its three-letter abbreviation.
const MONTH_NUMBER: Record<string, number> = Object.fromEntries(
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .flatMap((name, i) => [[name, i + 1], [name.slice(0, 3), i + 1]]),
);

function parseStatementDay(text: string): [number, number, number] | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (m) return [Number(m[3]), Number(m[1]), Number(m[2])];
  m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text);
  const month = m ? MONTH_NUMBER[m[1].toLowerCase()] : undefined;
  return m && month ? [Number(m[3]), month, Number(m[2])] : null;
}

/** The pipeline's _statement_age_days: whole days since the statement date (a period's end date) in New York, or
 *  null when there is no readable date. */
export function statementAgeDays(value: unknown, now = new Date()): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const s = value.trim();
  const candidates = [s];
  const sameMonth = /^([A-Za-z]+)\.?\s+\d{1,2}\s*[-–]+\s*(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (sameMonth) candidates.push(`${sameMonth[1]} ${sameMonth[2]}, ${sameMonth[3]}`);
  if (s.includes("-") || s.includes("–")) {
    const trailing = /([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})\s*$/.exec(s);
    if (trailing) candidates.push(trailing[1]);
    candidates.push(s.split(/[-–]/).pop()!.trim());
  }
  for (const candidate of candidates) {
    const day = parseStatementDay(candidate.trim().replace(/,$/, "").trim());
    if (day) return Math.floor((now.getTime() - newYorkMidnight(...day)) / 86_400_000);
  }
  return null;
}

// The pipeline flags a statement older than this as stale (STATEMENT_STALE_DAYS, default 60).
const STALE_AFTER_DAYS = 60;

/** One household run as /api/v1/households returns it: removed rows left out, counts from the effective status, and
 *  statement freshness recomputed for today, as the pipeline recomputes it on every read. */
export function bulkHousehold(h: PipelineHousehold, now = new Date()) {
  const accounts = live(h.accounts).map(({ deleted_at: _account, assets, ...account }) => ({
    ...account,
    ...((age) => ({ statement_age_days: age, is_stale: age != null && age > STALE_AFTER_DAYS }))(
      statementAgeDays(account.statement_date, now)),
    assets: live(assets).map(({ deleted_at: _position, ...p }) => ({
      ...p,
      account_id: account.id,
      effective_status: p.override_status || p.transfer_eligible,
      effective_notes: p.override_status ? p.override_notes ?? null : p.transfer_notes,
    })),
  }));
  const positions = accounts.flatMap((a) => a.assets);
  const count = (status: string) => positions.filter((p) => p.effective_status === status).length;
  return {
    ...h,
    accounts,
    total_value: accounts.reduce((sum, a) => sum + (Number(a.total_value) || 0), 0),
    total_accounts: accounts.length,
    total_positions: positions.length,
    acat_count: count("ACAT"),
    liquidate_count: count("LIQUIDATE"),
    unsupported_count: count("UNSUPPORTED"),
    review_count: count("REVIEW"),
    transfer_count: count("ACH/WIRE"),
  };
}

export type BulkHousehold = ReturnType<typeof bulkHousehold>;

async function households(includeSuperseded = true): Promise<PipelineHousehold[]> {
  return (await listRecords<PipelineHousehold>("pipeline", "household"))
    .map((r) => r.doc)
    .filter((h) => includeSuperseded || !h.superseded_by)
    .sort((a, b) => b.processed_at.localeCompare(a.processed_at) || a.id.localeCompare(b.id));
}

async function listHouseholds({ url }: StandInCall): Promise<StandInReply> {
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page"))) || 1);
  const perPage = Math.min(500, Math.max(1, Math.trunc(Number(url.searchParams.get("per_page"))) || 50));
  const all = await households(url.searchParams.get("include_superseded") === "true");
  const slice = all.slice((page - 1) * perPage, page * perPage);
  return ok({ page, per_page: perPage, total: all.length, households: slice.map((h) => bulkHousehold(h)) });
}

async function scheduleStatus(): Promise<StandInReply> {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const active = !["Sat", "Sun"].includes(parts.weekday) && hour >= 8 && hour < 19;
  return ok({ active, scan_interval_minutes: 30, business_hours: "8:00 AM – 7:00 PM ET", business_days: "Mon–Fri", server_time: now() });
}

const findPosition = (h: PipelineHousehold, id: string) => h.accounts.flatMap((a) => a.assets).find((p) => p.id === id);
const findAccount = (h: PipelineHousehold, id: string) => h.accounts.find((a) => a.id === id);

/** Finds the run holding a position or account and changes it under the row lock. `change` edits the run in place
 *  and returns the reply; a reply of 300 or more leaves the run as it was. */
async function changeRun(
  holds: (h: PipelineHousehold) => boolean,
  change: (h: PipelineHousehold) => StandInReply,
): Promise<StandInReply> {
  const owner = (await households()).find(holds);
  if (!owner) return notFound();
  let reply = notFound();
  await changeRecord<PipelineHousehold>("pipeline", "household", owner.id, (h) => {
    reply = change(h);
    return reply.status < 300 ? { ...h, updated_at: now() } : null;
  });
  return reply;
}

function positionEdit(kind: "status" | "transferring" | "remove" | "restore") {
  return async ({ params: { id }, body }: StandInCall): Promise<StandInReply> => {
    const input = (body ?? {}) as Record<string, unknown>;
    if (kind === "status" && !isPositionStatus(input.status)) return bad("Invalid status");
    const value = kind === "transferring" && typeof input.value === "string" ? input.value.toUpperCase() : input.value ?? null;
    if (kind === "transferring" && value !== null && value !== "YES" && value !== "NO") return bad("Invalid value");
    return changeRun((h) => !!findPosition(h, id), (h) => {
      const p = findPosition(h, id)!;
      if (kind === "restore") {
        if (!p.deleted_at) return notFound();
        p.deleted_at = null;
        return ok({ position_id: id, restored: true });
      }
      if (p.deleted_at) return notFound();
      if (kind === "remove") {
        p.deleted_at = now();
        return ok({ position_id: id, deleted: true });
      }
      if (kind === "status") {
        const notes = text(input.notes, 500);
        Object.assign(p, { override_status: input.status, override_notes: notes, overridden_by: caller(), overridden_at: now() });
        return ok({ position_id: id, new_status: input.status, notes });
      }
      Object.assign(p, { transferring: value, transferring_by: caller(), transferring_at: now() });
      return ok({ position_id: id, transferring: value });
    });
  };
}

function accountEdit(kind: "type" | "remove" | "restore") {
  return async ({ params: { id }, body }: StandInCall): Promise<StandInReply> => {
    const input = (body ?? {}) as Record<string, unknown>;
    if (kind === "type" && !isAccountTypeOption(input.account_type)) return bad("Invalid account type");
    return changeRun((h) => !!findAccount(h, id), (h) => {
      const a = findAccount(h, id)!;
      if (kind === "restore") {
        if (!a.deleted_at) return notFound();
        for (const p of a.assets) if (p.deleted_at === a.deleted_at) p.deleted_at = null;
        a.deleted_at = null;
        return ok({ account_id: id, restored: true });
      }
      if (a.deleted_at) return notFound();
      if (kind === "remove") {
        a.deleted_at = now();
        for (const p of a.assets) p.deleted_at ??= a.deleted_at;
        return ok({ account_id: id, deleted: true });
      }
      const type = input.account_type as string;
      Object.assign(a, {
        account_type: type,
        account_type_other: type === "Other" ? text(input.account_type_other, 60) : null,
        is_inherited: type.startsWith("Inherited"),
        account_type_overridden_by: caller(),
        account_type_overridden_at: now(),
      });
      return ok({
        account_id: id, account_type: a.account_type, account_type_other: a.account_type_other ?? null,
        is_rollover: a.is_rollover === true, is_inherited: a.is_inherited === true, apex_restriction: a.apex_restriction ?? null,
        positions_reclassified: 0, engine_status_changed: 0,
        overrides_preserved: a.assets.filter((p) => p.override_status).length, apex_rules_loaded: true,
      });
    });
  };
}

/** The pipeline's _mask_account_number: a bullet for every character before the last four that aren't dashes (all
 *  of a shorter number). */
export function maskAccountNumber(n: string | null): string | null {
  if (!n) return n;
  let seen = 0;
  let reveal = n.length;
  for (let i = n.length - 1; i >= 0; i--) {
    if (n[i] !== "-") seen++;
    if (seen === 4) {
      reveal = i;
      break;
    }
  }
  return reveal === 0 ? n : "•".repeat(reveal) + n.slice(reveal);
}

async function destinationsFor(folder: string): Promise<PipelineDestination[]> {
  return (await listRecords<PipelineDestination>("pipeline", "destination"))
    .map((r) => r.doc)
    .filter((d) => folder !== "" && d.source_folder_id === folder)
    .sort((a, b) => (a.owner ?? "").localeCompare(b.owner ?? "") || (a.target_account_type ?? "").localeCompare(b.target_account_type ?? ""));
}

/** The pipeline's normalize_owner: lowercase, punctuation and single-letter initials dropped, joints keep "&". */
export function normalizeOwner(name: string | null): string | null {
  if (!name) return null;
  const tokens = name.toLowerCase().replace(/[^a-z& ]/g, " ").split(/\s+/).filter((t) => t.length > 1 || t === "&");
  return tokens.join(" ") || null;
}

/** The pipeline's normalize_acct_type: INDIVIDUAL / JOINT / ROTH IRA / TRAD IRA (+ " INHERITED"), else the type. */
export function normalizeAccountType(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replaceAll("_", " ").replaceAll("companion", "").trim();
  const inherited = s.includes("inherited") || s.includes("beneficiary") || s.includes("bene ");
  const has = (...words: string[]) => words.some((w) => s.includes(w));
  const base = has("joint", "jwros", "jtwros", "jtic", "wros", "tenants", "survivorship", "community property", "entirety")
    ? "JOINT"
    : has("roth") ? "ROTH IRA"
      : has("trad", "ira") ? "TRAD IRA"
        : has("401", "403", "rollover", "pension") ? "TRAD IRA"
          : has("brokerage", "individual") ? "INDIVIDUAL"
            : s.toUpperCase().trim();
  return base + (inherited ? " INHERITED" : "");
}

async function listDestinations({ params }: StandInCall): Promise<StandInReply> {
  const all = await destinationsFor(params.folder);
  const roster = (await listRecords<RosterAccount>("pipeline", "roster")).map((r) => r.doc);
  // query_roster: the receiving custodian's open accounts with the destination's normalized owner and type.
  const matchesFor = (d: PipelineDestination) => {
    const owner = normalizeOwner(d.owner);
    const type = normalizeAccountType(d.target_account_type);
    return owner && type ? roster.filter((r) => r.owner_norm === owner && r.type_norm === type) : [];
  };
  return ok({
    destinations: all.map((d) => {
      const matches = matchesFor(d);
      const numbers = matches.map((m) => m.apex_number).filter((n): n is string => !!n);
      return {
        id: d.id, owner: d.owner, target_account_type: d.target_account_type, existing_apex_number: d.existing_apex_number,
        needs_to_be_opened: d.needs_to_be_opened,
        sources: d.sources.map((s) => ({ link_id: s.link_id, custodian: s.custodian, account_number: maskAccountNumber(s.account_number) })),
        suggestion: {
          existing_count: matches.length,
          matched_titles: matches.map((m) => m.account_title_raw).slice(0, 5),
          matched_numbers: numbers,
          suggested_apex_number: numbers.length === 1 && !d.existing_apex_number ? numbers[0] : null,
        },
      };
    }),
  });
}

const demoFull = (): StandInReply => ({ status: 429, json: { detail: "The demo can't hold more destination accounts until tonight's reset." } });

function newDestination(folder: string, owner: unknown, type: string): PipelineDestination {
  return {
    id: randomUUID(), source_folder_id: folder, owner: text(owner, 120), target_account_type: type,
    existing_apex_number: null, needs_to_be_opened: true, sources: [],
  };
}

async function addDestination({ params, body }: StandInCall): Promise<StandInReply> {
  const input = (body ?? {}) as Record<string, unknown>;
  const type = text(input.target_account_type, 60);
  if (!type) return bad("target_account_type is required");
  if (!(await households()).some((h) => h.source_folder_id === params.folder)) return notFound();
  if ((await destinationsFor(params.folder)).length >= 12) return { status: 429, json: { detail: "This client already has 12 destination accounts." } };
  const destination = newDestination(params.folder, input.owner, type);
  // The 12 counts live destinations; a removed one stays as a record, so the store's own cap is what bounds them.
  if ((await saveRecord("pipeline", "destination", destination.id, destination)) === "full") return demoFull();
  return ok({ id: destination.id });
}

async function changeDestination({ params, body }: StandInCall): Promise<StandInReply> {
  const input = (body ?? {}) as Record<string, unknown>;
  const type = text(input.target_account_type, 60);
  const changed = await changeRecord<PipelineDestination>("pipeline", "destination", params.id, (d) => (d.source_folder_id ? {
    ...d,
    ...(typeof input.needs_to_be_opened === "boolean" ? { needs_to_be_opened: input.needs_to_be_opened } : {}),
    ...(type ? { target_account_type: type } : {}),
  } : null));
  return changed?.source_folder_id ? ok({ id: params.id }) : notFound();
}

async function removeDestination({ params }: StandInCall): Promise<StandInReply> {
  const record = await readRecord<PipelineDestination>("pipeline", "destination", params.id);
  if (!record?.doc.source_folder_id) return notFound();
  if (record.doc.sources.length) return { status: 409, json: { detail: "Move this destination's source accounts first." } };
  await changeRecord<PipelineDestination>("pipeline", "destination", params.id, (d) => ({ ...d, source_folder_id: "" }));
  return ok({ id: params.id, deleted: true });
}

async function reassignSource({ body }: StandInCall): Promise<StandInReply> {
  const input = (body ?? {}) as Record<string, unknown>;
  const linkId = String(input.link_id ?? "");
  const all = (await listRecords<PipelineDestination>("pipeline", "destination")).map((r) => r.doc);
  const from = all.find((d) => d.source_folder_id && d.sources.some((s) => s.link_id === linkId));
  if (!from) return notFound();
  if (input.source_folder_id && input.source_folder_id !== from.source_folder_id) return bad("source_folder_id does not match the link");
  let targetId = typeof input.target_account_id === "string" ? input.target_account_id : null;
  if (!targetId) {
    const created = newDestination(from.source_folder_id, input.new_owner, text(input.new_target_account_type, 60) ?? "Individual");
    if ((await saveRecord("pipeline", "destination", created.id, created)) === "full") return demoFull();
    targetId = created.id;
  } else if (!all.some((d) => d.id === targetId && d.source_folder_id === from.source_folder_id)) {
    return notFound();
  }
  const source = from.sources.find((s) => s.link_id === linkId)!;
  await changeRecord<PipelineDestination>("pipeline", "destination", from.id, (d) => ({ ...d, sources: d.sources.filter((s) => s.link_id !== linkId) }));
  await changeRecord<PipelineDestination>("pipeline", "destination", targetId, (d) => ({ ...d, sources: [...d.sources, source] }));
  return ok({ link_id: linkId, target_account_id: targetId });
}

const today = () => now().slice(0, 10);
const reportName = (client: string) => `${client.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_report_${today()}.pdf`;
const pdfReply = (bytes: Uint8Array<ArrayBuffer>, filename: string): StandInReply => ({
  status: 200, bytes, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"` },
});

async function householdPdfReply({ params }: StandInCall): Promise<StandInReply> {
  const record = await readRecord<PipelineHousehold>("pipeline", "household", params.id);
  if (!record) return notFound();
  return pdfReply(await householdPdf(bulkHousehold(record.doc)), reportName(record.doc.client_name));
}

async function allHouseholdsPdfReply(): Promise<StandInReply> {
  const current = await households(false);
  if (!current.length) return notFound();
  return pdfReply(await allHouseholdsPdf(current.map((h) => bulkHousehold(h))), `all_clients_report_${today()}.pdf`);
}

/** "Save to Drive" files the household's PDF in its client folder and marks the run reviewed. In the demo the file
 *  goes to the Outbox. */
async function saveToDrive({ params }: StandInCall): Promise<StandInReply> {
  const record = await readRecord<PipelineHousehold>("pipeline", "household", params.id);
  if (!record) return notFound();
  const filename = reportName(record.doc.client_name);
  const run = bulkHousehold(record.doc);
  const reviewedAt = now();
  // No subject: the statement pipeline's folders are linked to households for operations only, so only admin and
  // operations read this message.
  await recordOutbox(prisma, {
    channel: "Google Drive",
    destination: `${record.doc.client_name} client folder`,
    title: `Asset map saved for ${record.doc.client_name}`,
    detail: `${filename} · ${run.total_accounts} accounts, ${run.total_positions} positions`,
    body: `${filename}\n\nThe household's asset map as a PDF, filed in its client folder, and the run marked reviewed.`,
  });
  await changeRecord<PipelineHousehold>("pipeline", "household", params.id, (h) => ({ ...h, reviewed_at: reviewedAt, reviewed_by: caller(), updated_at: reviewedAt }));
  return ok({ file_id: `demo-${params.id}`, web_view_link: "", filename, reviewed_at: reviewedAt, reviewed_by: caller() });
}

/** The scan reads new statements from the clients' Drive folders. The demo's folders get none. */
async function scan(): Promise<StandInReply> {
  return ok({ timestamp: now(), clients_processed: 0, results: [] });
}

async function config(): Promise<StandInReply> {
  return ok({ demo: true, client_linking_enabled: false, client_linking_writes_enabled: false });
}

const SECURITY_TYPES: Record<string, string> = {
  "mutual fund": "Mutual Fund", mutual_fund: "Mutual Fund", etf: "ETF", equity: "Equity",
  "fixed income": "Fixed Income", fixed_income: "Fixed Income", cash: "Cash",
};

/** The pipeline's holdings preview (holdings_transferability.py), with the demo's fund restriction list. */
async function holdingsTransferability({ body }: StandInCall): Promise<StandInReply> {
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length > 200) return bad("rows must be a list of at most 200");
  const funds = new Map((await listRecords<FundRestriction>("pipeline", "fund_restriction")).map((r) => [r.doc.symbol, r.doc.omni]));
  const unknown = (reason: string) => ({ label: "unknown", reason });
  const classify = (row: unknown) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const symbol = typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    const rawType = typeof r.security_type === "string" ? r.security_type.trim().split(/\s+/).join(" ").toLowerCase() : "";
    const type = SECURITY_TYPES[rawType];
    if (!type) return unknown(rawType ? "unrecognized_security_type" : "missing_security_type");
    if (!symbol && type !== "Fixed Income") return unknown("missing_symbol");
    if (type === "Mutual Fund") {
      if (!funds.has(symbol)) return unknown("mutual_fund_unlisted");
      return funds.get(symbol) ? { label: "likely_transferable", reason: "omni" } : unknown("mutual_fund_non_omni");
    }
    if (type === "Fixed Income") return { label: "likely_not", reason: "fixed_income" };
    return { label: "likely_transferable", reason: type === "Cash" ? "cash" : "standard_security" };
  };
  return { status: 200, json: { rules_status: "ok", rows: rows.map(classify) }, headers: { "cache-control": "no-store" } };
}

export const PIPELINE_ROUTES: readonly StandInRoute[] = [
  ["GET", "/api/v1/households", listHouseholds],
  ["GET", "/api/schedule-status", scheduleStatus],
  ["PATCH", "/api/positions/:id/status", positionEdit("status")],
  ["PATCH", "/api/positions/:id/transferring", positionEdit("transferring")],
  ["DELETE", "/api/positions/:id", positionEdit("remove")],
  ["PATCH", "/api/positions/:id/restore", positionEdit("restore")],
  ["PATCH", "/api/accounts/:id/type", accountEdit("type")],
  ["DELETE", "/api/accounts/:id", accountEdit("remove")],
  ["PATCH", "/api/accounts/:id/restore", accountEdit("restore")],
  ["GET", "/api/v1/clients/:folder/destinations", listDestinations],
  ["POST", "/api/clients/:folder/destinations", addDestination],
  ["PATCH", "/api/destinations/:id", changeDestination],
  ["DELETE", "/api/destinations/:id", removeDestination],
  ["POST", "/api/source-accounts/reassign", reassignSource],
  ["GET", "/api/households/export/pdf", allHouseholdsPdfReply],
  ["GET", "/api/households/:id/pdf", householdPdfReply],
  ["POST", "/api/households/:id/save-to-drive", saveToDrive],
  ["POST", "/api/scan", scan],
  ["GET", "/api/config", config],
  ["POST", "/api/v1/holdings-transferability", holdingsTransferability],
];
