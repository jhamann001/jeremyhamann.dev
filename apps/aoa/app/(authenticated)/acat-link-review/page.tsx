import Link from "next/link";
import { Prisma } from "@prisma/client";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import type { AoaAcatCandidate, LinkageRecord, LinkageSnapshot } from "@/lib/data/acat-link-contract";
import { readHistoricalAcatIntentWithinScope, readHistoricalReviewContext } from "@/lib/data/acat-historical-review";
import { historicalCandidatePresentation, historicalFundingLane, readTrackerDirectoryLabels, historicalCohort, historicalCohortWhere, historicalHoldScope, HISTORICAL_COHORT_LABELS } from "@/lib/data/acat-reconciliation/historical-presentation";
import { getAcatStatusByRecordId, type AcatStatus } from "@/lib/data/acat-status";
import { Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import { acatAutoLinkReviewEnabled } from "@/lib/flags";
import { usdFromCents } from "@/lib/format";
import { withUserScope } from "@/lib/rls";
import { reviewCandidateChoices } from "@/lib/data/acat-reconciliation/candidate-presentation";
import { REVIEW_CATEGORIES, REVIEW_CATEGORY_LABELS, REVIEW_POPULATIONS, reviewDecisionLabel, reviewListFilter } from "@/lib/data/acat-reconciliation/presentation";
import { transferLinkageConfiguration, fetchTransferLinkageSnapshot, readAcatCandidatesWithinScope } from "@/lib/data/acat-match-source";
import { verifyReconciliationRun } from "@/lib/data/acat-reconciliation/verification";
import { applyReviewedAcatDecision, prepareAcatPair, prepareAcatReview, prepareHistoricalAcatPair, reviewAcatDecision, undoReviewedAcatDecision } from "./actions";
import styles from "./page.module.css";
import ReviewFocus from "./review-focus";

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value) ?? "";
const label = (value: string): string => value.toLowerCase().replaceAll("_", " ");
const day = (value: string | Date): string => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/New_York" }).format(new Date(value));
const reviewTime = (value: string | Date): string => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York" }).format(new Date(value));
type EarlierReviewNote = {
  transfer_id: string; run_id: string; run_created_at: Date;
  review_reason: string; reviewed_at: Date | null; reviewed_by: string | null;
};
const noteTime = (value: Date | null): string => value && Number.isFinite(new Date(value).getTime())
  ? reviewTime(value) : "Date unavailable";
const noteReviewer = (value: string | null): string => value?.trim() || "Reviewer unavailable";
const calendarDay = (value: string | Date | null | undefined): string => value && Number.isFinite(new Date(value).getTime())
  ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)) : "Not recorded";
const safeDay = (value: string | Date | null | undefined): string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? calendarDay(value) : value && Number.isFinite(new Date(value).getTime()) ? day(value) : "Not recorded";
const maskedAccount = (value: string | null | undefined): string => value && /^[*•]+[A-Za-z0-9]{1,4}$/.test(value) ? value : "Unavailable";
const money = (value: unknown): string => value !== null && value !== undefined && Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value)) : "Not recorded";
const recordDescription = (row: LinkageRecord): string => `${safeDay(row.requestDate ?? row.createdAt)} · ${label(row.transferType)} · ${label(row.status)} · ${row.controlNumber ?? row.acatTransferId ?? "No transaction reference"}`;
const MESSAGES: Record<string, string> = {
  historical_invalid: "Complete the historical evidence form: choose an evidence type, enter a stable reference without spaces, explain the correspondence in 40–2000 characters, and confirm that you reviewed the same-transfer evidence.",
  prepared: "Review is ready. Preparing it did not link any records.",
  reviewed: "Your review was saved.",
  stale: "The records or review changed. Prepare a fresh review before continuing.",
  unavailable: "The complete source evidence could not be loaded. Existing links were preserved.",
  applied: "The reviewed link was applied.",
  blocked: "The link could not be applied. Refresh the evidence and review the records.",
  undone: "The link was undone and automatic relinking is on hold.",
};

export default async function AcatLinkReviewPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!acatAutoLinkReviewEnabled() || !["ADMIN", "OPERATIONS"].includes(role) || !session.user.email) notFound();
  const identity = { role, email: session.user.email };
  const params = await searchParams;
  const requestedRun = one(params.run);
  const requestedPage = Math.max(1, Math.min(1000, Math.floor(Number(one(params.page))) || 1));
  // Existing fixture/run links paginate the full ledger without a population.
  const population = params.population === undefined && params.page !== undefined ? "all" : one(params.population);
  const cohort = historicalCohort(one(params.cohort));
  const filter = reviewListFilter(cohort === "all" ? population : "aoa", one(params.category));
  const data = await withUserScope(identity, async (tx) => {
    const fundingGroups = await tx.transfer.groupBy({ by: ["funding_type"], where: historicalHoldScope, _count: { _all: true } });
    const historyCounts = { known_acat: 0, not_applicable: 0, evidence_needed: 0 };
    for (const group of fundingGroups) historyCounts[historicalFundingLane(group.funding_type)] += group._count._all;
    const runs = await tx.acatLinkRun.findMany({ orderBy: { created_at: "desc" }, take: 10,
      select: { id: true, created_at: true, source_count: true, target_count: true, status: true } });
    const runId = requestedRun || runs[0]?.id;
    if (!runId) return { runs, runId: null, count: 0, decisions: [], transfers: [], verification: null, page: 1, historyCounts, cohortUnavailable: false };
    const cohortTargets = cohort === "all" ? null : await tx.transfer.findMany({ where: historicalCohortWhere(cohort), select: { id: true }, take: 5001 });
    const cohortUnavailable = cohortTargets !== null && cohortTargets.length > 5000;
    const where = { run_id: runId, ...filter.where, ...(cohortTargets ? { transfer_id: { in: cohortUnavailable ? [] : cohortTargets.map((row) => row.id) } } : {}) };
    const count = await tx.acatLinkDecision.count({ where });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(count / 50)));
    const rawDecisions = await tx.acatLinkDecision.findMany({ where, orderBy: { id: "asc" }, take: 50, skip: (page - 1) * 50,
      select: { id: true, transfer_id: true, record_id: true, reason: true, action: true, disposition: true,
        review_version: true, evidence_digest: true, outcome: true, expected_target_version: true, payload: true,
        review_reason: true, reviewed_at: true, reviewed_by: true } });
    const noteTransferIds = [...new Set(rawDecisions.flatMap((row) =>
      row.transfer_id && !row.review_reason?.trim() ? [row.transfer_id] : []))];
    // Only this page's transfers; one earlier annotation each, under the same RLS snapshot.
    // Resolve the selected run directly: requested older runs may be outside the ten-run menu.
    const earlierNotes = noteTransferIds.length ? await tx.$queryRaw<EarlierReviewNote[]>(Prisma.sql`
      SELECT requested.transfer_id, note.*
      FROM app.acat_link_run selected
      CROSS JOIN unnest(ARRAY[${Prisma.join(noteTransferIds)}]::text[]) AS requested(transfer_id)
      CROSS JOIN LATERAL (
        SELECT previous.run_id, earlier.created_at AS run_created_at,
          previous.review_reason, previous.reviewed_at, previous.reviewed_by
        FROM app.acat_link_decision previous
        JOIN app.acat_link_run earlier ON earlier.id = previous.run_id
        WHERE previous.transfer_id = requested.transfer_id
          AND previous.run_id <> selected.id AND earlier.created_at < selected.created_at
          AND previous.review_reason ~ '[^[:space:]]'
        ORDER BY previous.reviewed_at DESC NULLS LAST, previous.id DESC
        LIMIT 1
      ) note
      WHERE selected.id = ${runId}
    `) : [];
    const earlierByTransfer = new Map(earlierNotes.map((note) => [note.transfer_id, note]));
    // Project only the bounded reviewed fields; never render the raw manifest or identity/account payload.
    const decisions = rawDecisions.map(({ payload, ...row }) => {
      const savedNote = row.review_reason?.trim() ? {
        review_reason: row.review_reason, reviewed_at: row.reviewed_at, reviewed_by: row.reviewed_by, run_created_at: null,
      } : row.transfer_id ? earlierByTransfer.get(row.transfer_id) ?? null : null;
      try { return { ...row, savedNote, historical: readHistoricalReviewContext(payload), historicalInvalid: false }; }
      catch { return { ...row, savedNote, historical: null, historicalInvalid: true }; }
    });
    const ids = decisions.flatMap((row) => row.transfer_id ? [row.transfer_id] : []);
    const transfers = await tx.transfer.findMany({ where: { id: { in: ids } }, select: {
      id: true, client_first_name: true, client_last_name: true, stage: true, funding_type: true, created_at: true, transferring_firm: true,
      acat_auto_link_hold: true, acat_link_version: true,
    } });
    const verification = await verifyReconciliationRun(tx, identity, runId);
    return { runs, runId, count, decisions, transfers, verification, page, historyCounts, cohortUnavailable };
  }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
  const page = data.page;
  const reviewUrl = (extra: Record<string, string>) => `?${new URLSearchParams({ run: data.runId ?? "", population: filter.population, category: filter.category, ...(cohort !== "all" ? { cohort } : {}), ...extra })}`;
  const transfers = new Map(data.transfers.map((row) => [row.id, row]));
  let trackerBase: string | null = null;
  try {
    const config = transferLinkageConfiguration();
    if (config.environment === "production") trackerBase = config.baseUrl;
  } catch { /* Configuration absence does not hide saved review history. */ }

  const selectedTransfer = one(params.transfer);
  const historicalTransfer = one(params.historical);
  const selectedRecord = one(params.record);
  const requestedCandidatePage = Math.max(1, Math.floor(Number(one(params.candidatePage))) || 1);
  const opaque = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
  let choices: Array<{ id: string; description: string }> = [];
  let candidateMessage = selectedTransfer ? "This transfer selection is invalid. Choose a transfer from the saved review." : "";
  let historyMessage = historicalTransfer ? "This transfer selection is invalid. Choose a transfer from the saved review." : "";
  let historical: ReturnType<typeof historicalCandidatePresentation> | null = null;
  let historicalTarget: AoaAcatCandidate | undefined;
  let historicalTransferDisplay: typeof data.transfers[number] | null = null;
  let dealDisplay: { id: string; account_last4: string | null; account_type: string | null; transferring_firm: string | null; amount: unknown; created_date: Date; close_date: Date | null } | null = null;
  let transferValue: unknown = null;
  let snapshot: LinkageSnapshot | null = null;
  let historicalSource: LinkageRecord | undefined;
  let historicalSourceBlocker: string | null = null;
  let detail: AcatStatus | null = null;
  const recordIds = new Set(data.decisions.filter((row) => !row.transfer_id).flatMap((row) => row.record_id ? [row.record_id] : []));
  let directoryLabels = new Map<string, string>();
  const freshRecords = new Map<string, LinkageRecord>();
  if (opaque(selectedTransfer) || opaque(historicalTransfer) || recordIds.size > 0) {
    try {
      snapshot = await fetchTransferLinkageSnapshot();
      if (opaque(selectedTransfer) || opaque(historicalTransfer)) {
        const selected = await withUserScope(identity, async (tx) => {
          const targets = await readAcatCandidatesWithinScope(tx);
          const target = targets.find((row) => row.transferId === historicalTransfer);
          const intent = target ? await readHistoricalAcatIntentWithinScope(tx, target.transferId) : null;
          const display = target ? await tx.transfer.findUnique({ where: { id: target.transferId }, select: {
            id: true, client_first_name: true, client_last_name: true, stage: true, funding_type: true, created_at: true,
            transferring_firm: true, value: true, deal_id: true, acat_auto_link_hold: true, acat_link_version: true,
          } }) : null;
          const deal = display?.deal_id ? await tx.deal.findUnique({ where: { id: display.deal_id }, select: {
            id: true, account_last4: true, account_type: true, transferring_firm: true, amount: true, created_date: true, close_date: true,
          } }) : null;
          return { targets, intent, display, deal };
        }, { isolationLevel: "RepeatableRead" });
        if (opaque(selectedTransfer)) {
          const candidates = reviewCandidateChoices(selected.targets.find((row) => row.transferId === selectedTransfer), snapshot.records);
          choices = candidates.records.map((row) => ({ id: row.recordId, description: recordDescription(row) }));
          candidateMessage = candidates.message ?? "";
        }
        if (opaque(historicalTransfer)) {
          historicalTarget = selected.targets.find((row) => row.transferId === historicalTransfer);
          historicalTransferDisplay = selected.display;
          dealDisplay = selected.deal; transferValue = selected.display?.value;
          historical = historicalCandidatePresentation(snapshot, selected.targets, historicalTarget, selected.intent, { page: requestedCandidatePage, selectedRecordId: selectedRecord });
          historyMessage = historical.message;
          const selectedPair = historical.selected;
          historicalSource = selectedPair?.record;
          historicalSourceBlocker = selectedPair?.message ?? null;
          if (selectedRecord && !selectedPair && !historyMessage) historyMessage = "This record is not in the current same-client comparison list. Choose a record from this review.";
        }
      }
      for (const row of snapshot.records) if (recordIds.has(row.recordId)) freshRecords.set(row.recordId, row);
      if (historicalSource) freshRecords.set(historicalSource.recordId, historicalSource);
    } catch {
      if (selectedTransfer) candidateMessage = "Candidate evidence is unavailable. Existing links were preserved.";
      if (historicalTransfer) historyMessage = "Fresh source or prior review evidence is unavailable. Historical linking is blocked; existing links and holds were preserved.";
      historical = null; historicalTarget = undefined; historicalSource = undefined;
    }
  }
  // Display enrichment has no effect on candidate eligibility or link evidence.
  if (freshRecords.size) {
    try { directoryLabels = await withUserScope(identity, (tx) => readTrackerDirectoryLabels(tx, [...freshRecords.values()]), { isolationLevel: "RepeatableRead" }); }
    catch { /* The source links remain available when directory labels cannot be loaded. */ }
  }
  // Mirror the status reader's default only in the production app. Development
  // still requires an explicit URL, and every read must match the linkage base.
  const metadataBase = (process.env.TRANSFER_TRACKER_URL ?? (process.env.APP_ENV === "prod"
    ? "https://transfers.jeremyhamann.dev" : undefined))?.replace(/\/+$/, "");
  if (historicalSource && trackerBase && metadataBase === trackerBase) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try { detail = await Promise.race([getAcatStatusByRecordId(historicalSource.recordId, { signal: controller.signal }),
      new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }))]); }
    catch { /* Optional masked metadata is not matching authority. */ }
    finally { clearTimeout(timer); }
  }
  const candidatePage = historical?.page ?? 1;
  const historicalPageRecords = historical?.records ?? [];
  const message = MESSAGES[one(params.message)];
  const focus = one(params.focus);
  const focusedDecision = opaque(focus) ? data.decisions.find((row) => row.id === focus) : undefined;
  const verification = data.verification;
  const coverage = verification?.coverage;
  return <>
    {focusedDecision && <ReviewFocus decisionId={focusedDecision.id} revision={`${focusedDecision.review_version}:${focusedDecision.outcome}:${one(params.message)}`} />}
    <SectionLabel>Operations · transfer matching</SectionLabel>
    <div className={styles.title}>
      <div><h1>Review ACAT links</h1><p>Confirm which Tracker record belongs to each asset transfer. Manual corrections remain protected.</p></div>
      <form action={prepareAcatReview}><button className={styles.primary} type="submit">Prepare fresh review</button></form>
    </div>
    {message && <p role="status" className={styles.notice}>{message}</p>}
    <p className={styles.help}>A saved review records the evidence for your decision. Applying a link checks the current records again and leaves funding and transfer stages unchanged.</p>
    {data.runs.length > 0 && <nav className={styles.runs} aria-label="Saved reviews">
      {data.runs.map((run) => <Link key={run.id} href={`?run=${encodeURIComponent(run.id)}`} aria-current={data.runId === run.id ? "page" : undefined}>
        {reviewTime(run.created_at)} · {run.source_count} ACATs / {run.target_count} transfers
      </Link>)}
    </nav>}
    {verification && <section aria-label="Saved review summary" className={styles.summary}>
      <h2>Population at preparation</h2>
      <p className={styles.help}>These are two separate populations. A linked pair appears in both; the counts should not be added together. Holds and records without a counterpart are not proposed links.</p>
      {coverage ? <>
        <div className={styles.populationGrid}>{(["aoa", "tracker"] as const).map((population) => <Card key={population}>
          <CardHeader><h3>{population === "aoa" ? "AOA asset transfers" : "Tracker ACAT records"} · {coverage[population].total}</h3></CardHeader>
          <CardBody><dl className={styles.counts}>{REVIEW_CATEGORIES.map((category) => <div key={category}>
            <dt>{REVIEW_CATEGORY_LABELS[category]}</dt><dd>{coverage[population].categories[category]}</dd>
          </div>)}</dl></CardBody>
        </Card>)}</div>
        <p className={styles.help}>Proposed pairs still need current evidence checks before a link can be applied. A hold prevents automatic linking; it does not confirm a match or complete historical review. Not yet matched means this run selected no counterpart; holds can prevent matching, so a historical match may still exist.</p>
      </> : <p className={styles.notice}>The saved evidence cannot support a complete population summary. Prepare a fresh review before using these counts.</p>}
      <h3>Link attempts for this saved review</h3>
      <p className={styles.notice}>
        {verification.outcomes.APPLIED} applied · {verification.outcomes.NOOP} already satisfied · {verification.outcomes.CONFLICT} conflicted · {verification.outcomes.BLOCKED} blocked · {verification.outcomes.UNDONE} undone
        {verification.linkStateDriftCount > 0 && ` · ${verification.linkStateDriftCount} links changed since this run`}
        {(!verification.manifestValid || verification.invalidOutcomeCount > 0 || verification.outcomeMetadataMissingCount > 0)
          && " · Saved evidence needs technical review before further use"}
      </p>
      <p className={styles.help}>Entries without a link attempt are listed by their matching disposition below. Preparing a review does not apply links. The population summary stays as it was when prepared; link attempts can change afterward.</p>
    </section>}
    <section aria-label="Historical review scope" className={styles.summary}>
      <h2>Historical transfers on hold</h2>
      <p className={styles.help}>Current unarchived, unlinked AOA transfers on hold, across the whole population. These counts can differ from the saved review above.</p>
      <dl className={styles.scopeCounts}>
        <div><dt><Link href={reviewUrl({ population: "aoa", category: "all", cohort: "known_acat" })}>Known full or partial ACAT · evidence review</Link></dt><dd>{data.historyCounts.known_acat}</dd></div>
        <div><dt><Link href={reviewUrl({ population: "aoa", category: "all", cohort: "not_applicable" })}>Other funding method · ACAT not applicable</Link></dt><dd>{data.historyCounts.not_applicable}</dd></div>
        <div><dt><Link href={reviewUrl({ population: "aoa", category: "all", cohort: "evidence_needed" })}>Funding type not recorded · evidence needed</Link></dt><dd>{data.historyCounts.evidence_needed}</dd></div>
      </dl>
      <p className={styles.help}>Only recorded full or partial ACAT funding can enter historical pair review. A missing funding type remains in the evidence queue. This page does not change funding methods, stages, amounts or dates, and historical links keep automatic linking on hold.</p>
    </section>
    {historicalTransfer && <Card><CardHeader><h2>Review a historical ACAT link</h2></CardHeader><CardBody>
      <p>This creates an association between two existing records. It will not change funding, transfer status, dates or amounts. Automatic linking will remain on hold.</p>
      <p className={styles.help}>Amounts, dates and firm details are current display context. They are not saved matching proof; use the transfer reference or document to confirm the association.</p>
      {historicalTransferDisplay && <section aria-label="AOA transfer to review" className={styles.comparison}>
        <h3><Link href={`/asset-transfer/${encodeURIComponent(historicalTransferDisplay.id)}`}>{historicalTransferDisplay.client_first_name} {historicalTransferDisplay.client_last_name} · Open AOA transfer</Link></h3>
        <dl><div><dt>Funding method</dt><dd>{historicalTransferDisplay.funding_type ? label(historicalTransferDisplay.funding_type) : "Not recorded"}</dd></div>
          <div><dt>Stage</dt><dd>{label(historicalTransferDisplay.stage)}</dd></div>
          <div><dt>AOA record created</dt><dd>{safeDay(historicalTransferDisplay.created_at)}</dd></div>
          <div><dt>Transferring firm</dt><dd>{historicalTransferDisplay.transferring_firm ?? dealDisplay?.transferring_firm ?? "Not recorded"}</dd></div>
          <div><dt>AOA value</dt><dd>{money(transferValue)}</dd></div>
          <div><dt>Parent deal amount</dt><dd>{money(dealDisplay?.amount)}</dd></div>
          <div><dt>Deal account ending</dt><dd>{dealDisplay?.account_last4 && /^[A-Za-z0-9]{4}$/.test(dealDisplay.account_last4) ? `•••• ${dealDisplay.account_last4}` : "Not recorded"}</dd></div>
          <div><dt>Deal funding description</dt><dd>{dealDisplay?.account_type ?? "Not recorded"}</dd></div>
          <div><dt>Deal created / close date</dt><dd>{calendarDay(dealDisplay?.created_date)} / {calendarDay(dealDisplay?.close_date)}</dd></div>
        </dl>
      </section>}
      {historyMessage ? <p role="status" className={styles.notice}>{historyMessage}</p> : <>
        <p className={styles.help}>These records share a verified client identity; they are not confirmed matches. Dates, names, amounts and a single candidate do not prove the same transfer. Open both records and review transfer-specific evidence.</p>
        <p>{historical?.total ?? 0} same-client records · comparison page {candidatePage} of {Math.max(1, Math.ceil((historical?.total ?? 0) / 20))}</p>
        <ul className={styles.candidates}>{historicalPageRecords.map(({ record, message: blockerMessage }) => <li key={record.recordId}>
          <strong>{recordDescription(record)}</strong>
          <p>{blockerMessage ?? "Identity and lifecycle checks allow evidence review. This is not a confirmed match."}</p>
          <Link href={reviewUrl({ historical: historicalTransfer, record: record.recordId, candidatePage: String(candidatePage), page: String(page) })}>Compare this Tracker record</Link>
          {trackerBase && <> · <a href={`${trackerBase}/records?open=${encodeURIComponent(record.recordId)}`} target="_blank" rel="noreferrer">Open in Tracker</a></>}
        </li>)}</ul>
        {(historical?.total ?? 0) > 20 && <nav className={styles.runs} aria-label="Historical candidate pages">
          {candidatePage > 1 && <Link href={reviewUrl({ historical: historicalTransfer, candidatePage: String(candidatePage - 1), page: String(page) })}>Previous candidates</Link>}
          {candidatePage * 20 < (historical?.total ?? 0) && <Link href={reviewUrl({ historical: historicalTransfer, candidatePage: String(candidatePage + 1), page: String(page) })}>Next candidates</Link>}
        </nav>}
        {!historicalSource && <p className={styles.notice}>Choose “Compare this Tracker record” to review one specific pair. No record has been selected automatically.</p>}
        {historicalSource && <section aria-label="Selected Tracker comparison" className={styles.comparison}>
          <h3>Selected Tracker record</h3>
          <p>{directoryLabels.get(historicalSource.recordId) ?? "Client directory: name unavailable"}</p>
          <dl><div><dt>Request date</dt><dd>{safeDay(historicalSource.requestDate)}</dd></div>
            <div><dt>Tracker record created</dt><dd>{safeDay(historicalSource.createdAt)}</dd></div>
            <div><dt>Transfer</dt><dd>{label(historicalSource.direction)} · {label(historicalSource.transferType)} · {label(historicalSource.status)}</dd></div>
            <div><dt>Transaction reference</dt><dd>{historicalSource.acatTransferId ?? "Not recorded"}</dd></div>
            <div><dt>Control reference</dt><dd>{historicalSource.controlNumber ?? "Not recorded"}</dd></div>
            <div><dt>Custodian</dt><dd>{detail?.transferringContra ?? "Unavailable"}</dd></div>
            <div><dt>Tracker statement amount</dt><dd>{detail?.statementAmount == null ? "Not recorded" : usdFromCents(detail.statementAmount)}</dd></div>
            <div><dt>Receiving account (masked)</dt><dd>{maskedAccount(detail?.apexAccountId)}</dd></div>
            <div><dt>Delivering account (masked)</dt><dd>{maskedAccount(detail?.statementAccountNumber)}</dd></div>
          </dl>
          {trackerBase && <a href={`${trackerBase}/records?open=${encodeURIComponent(historicalSource.recordId)}`} target="_blank" rel="noreferrer">Open selected ACAT in Tracker</a>}
          {!detail && <p className={styles.help}>Masked account and custodian details are unavailable. This display read does not change identity checks or supply transfer evidence.</p>}
          {historicalSourceBlocker ? <p role="status" className={styles.notice}>{historicalSourceBlocker}</p> : historicalTarget && snapshot && <form action={prepareHistoricalAcatPair} className={styles.form}>
            <input type="hidden" name="transferId" value={historicalTarget.transferId} />
            <input type="hidden" name="recordId" value={historicalSource.recordId} />
            <input type="hidden" name="expectedTargetVersion" value={historicalTarget.linkVersion} />
            <input type="hidden" name="expectedTargetDigest" value={historicalTarget.evidenceDigest} />
            <input type="hidden" name="expectedSourceDigest" value={snapshot.snapshotDigest} />
            <h3>What evidence identifies these as the same transfer?</h3>
            <label>Evidence type<select name="evidenceKind" required defaultValue=""><option value="">Select evidence type</option>
              <option value="TRANSACTION_REFERENCE">Exact ACAT transaction reference</option><option value="TRANSFER_DOCUMENT">Transfer request, confirmation or document</option>
            </select></label>
            <label>Internal document or transfer reference<input name="evidenceReference" required minLength={3} maxLength={256} /></label>
            <label>Explain how this reference connects both records<textarea name="correspondence" required minLength={40} maxLength={2000} rows={4} /></label>
            <p className={styles.help}>Use a stable internal reference. Do not paste statements, account numbers or client documents. Matching a name, date or amount alone is insufficient. Missing account or joint-holder proof cannot be overridden here.</p>
            <label className={styles.confirmation}><input type="checkbox" name="historicalConfirmed" value="yes" required />I reviewed this evidence and confirm that these two records represent the same transfer. Automatic linking will remain on hold.</label>
            <button type="submit">Prepare historical pair</button>
          </form>}
        </section>}
      </>}
    </CardBody></Card>}
    {selectedTransfer && <Card><CardHeader><h2>Choose the ACAT to review</h2></CardHeader><CardBody>
      {candidateMessage ? <p role="status">{candidateMessage}</p> : <>
        <p>Open each candidate in Tracker to check its details before preparing a specific pair.</p>
        <ul>{choices.map((choice) => <li key={choice.id}>
          {trackerBase ? <a href={`${trackerBase}/records?open=${encodeURIComponent(choice.id)}`} target="_blank" rel="noreferrer">{choice.description}</a> : choice.description}
        </li>)}</ul>
        <form action={prepareAcatPair} className={styles.form}>
          <input type="hidden" name="transferId" value={selectedTransfer} />
          <label>ACAT record<select name="recordId" required><option value="">Select a record</option>
            {choices.map((choice, index) => <option key={choice.id} value={choice.id}>{index + 1}. {choice.description}</option>)}
          </select></label>
          <button type="submit">Prepare selected pair</button>
        </form>
      </>}
    </CardBody></Card>}
    {!data.runId && <Card><CardBody><p>No saved review yet. Prepare one to see matches and records that need attention.</p></CardBody></Card>}
    {data.runId && <section aria-label="Review entry filters">
      <form className={styles.filters} method="get">
        <input type="hidden" name="run" value={data.runId} />
        <label>Show<select name="population" defaultValue={filter.population}>
          {Object.entries(REVIEW_POPULATIONS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select></label>
        <label>Prepared disposition<select name="category" defaultValue={filter.category}>
          <option value="all">All dispositions</option>
          {REVIEW_CATEGORIES.map((category) => <option key={category} value={category}>{REVIEW_CATEGORY_LABELS[category]}</option>)}
        </select></label>
        <label>Current historical cohort<select name="cohort" defaultValue={cohort}>
          {Object.entries(HISTORICAL_COHORT_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select></label>
        <button type="submit">Filter entries</button>
      </form>
      <p className={styles.help}>{data.count} entries · {REVIEW_POPULATIONS[filter.population]} · {filter.category === "all" ? "All dispositions" : REVIEW_CATEGORY_LABELS[filter.category]}. The population summary above always includes the whole saved review.</p>
      {cohort !== "all" && <p className={styles.help}>Current cohort: {HISTORICAL_COHORT_LABELS[cohort]}. This filters saved AOA entries to transfers currently unarchived, unlinked and on hold. The saved disposition is a separate filter; prepare a fresh review to include newly created transfers.</p>}
      {data.cohortUnavailable && <p role="alert">This cohort exceeds the bounded review population. No partial result is shown; narrow the supported population before continuing.</p>}
      {data.count === 0 && !data.cohortUnavailable && <p role="status">No entries in this saved review match these filters.</p>}
    </section>}
    <div className={styles.list}>{data.decisions.map((decision) => {
      const transfer = decision.transfer_id ? transfers.get(decision.transfer_id) : undefined;
      const paired = Boolean(decision.transfer_id && decision.record_id);
      const sourceDisplay = decision.record_id ? freshRecords.get(decision.record_id) : undefined;
      const historicalContext = decision.historical;
      const historicalFinal = Boolean(historicalContext && ["APPLIED", "NOOP", "UNDONE"].includes(decision.outcome));
      return <Card key={decision.id} id={`decision-${decision.id}`} tabIndex={-1} className={focusedDecision?.id === decision.id ? styles.focusedCard : undefined}><CardHeader>
        <h2>{transfer ? <Link href={`/asset-transfer/${encodeURIComponent(transfer.id)}`}>{transfer.client_first_name} {transfer.client_last_name}</Link> : decision.transfer_id ? "AOA transfer unavailable" : "Tracker ACAT not yet matched in this run"}</h2>
        <Pill tone={decision.outcome === "APPLIED" || (decision.outcome === "PENDING" && decision.action === "preserve" && decision.disposition !== "REJECT") ? "green" : "gray"}>{reviewDecisionLabel(decision)}</Pill>
      </CardHeader><CardBody>
        <p>Prepared matching reason: {label(decision.reason)}</p>
        {transfer && <p>Current AOA stage: {label(transfer.stage)}{transfer.acat_auto_link_hold ? " · Automatic linking on hold" : ""}</p>}
        {!transfer && decision.record_id && <><p>{directoryLabels.get(decision.record_id) ?? "Client directory: name unavailable"}</p>{sourceDisplay && <p>{recordDescription(sourceDisplay)}</p>}<p className={styles.help}>Directory labels help identify records; they do not establish a matching transfer.</p></>}
        {decision.record_id && trackerBase && <a href={`${trackerBase}/records?open=${encodeURIComponent(decision.record_id)}`} target="_blank" rel="noreferrer">Open ACAT in Tracker</a>}
        {!decision.record_id && transfer && <div className={styles.buttons}>
          <Link href={reviewUrl({ transfer: transfer.id, page: String(page) })}>Choose an open ACAT to review</Link>
          <Link href={reviewUrl({ historical: transfer.id, page: String(page) })}>{historicalFundingLane(transfer.funding_type) === "known_acat" ? "Review historical ACAT evidence" : historicalFundingLane(transfer.funding_type) === "evidence_needed" ? "Funding evidence needed" : "View why ACAT linking is not applicable"}</Link>
        </div>}
        {historicalContext && <section aria-label="Saved historical evidence" className={styles.comparison}>
          <h3>Historical pair · {historicalFinal ? "saved evidence" : "evidence saved for review"}</h3>
          <dl><div><dt>Evidence type</dt><dd>{historicalContext.evidenceKind === "TRANSACTION_REFERENCE" ? "Exact ACAT transaction reference" : "Transfer request, confirmation or document"}</dd></div>
            <div><dt>Internal reference</dt><dd>{historicalContext.evidenceReference}</dd></div>
            <div><dt>How the records correspond</dt><dd>{historicalContext.correspondence}</dd></div></dl>
          <p>{historicalFinal
            ? decision.outcome === "UNDONE"
              ? "This historical link was undone. The saved evidence is retained for audit; this review cannot be confirmed again."
              : decision.outcome === "NOOP"
                ? "This historical link needed no further change. The saved evidence is retained for audit."
                : "This historical link was applied using the saved evidence. To reverse it, use Undo this link and hold automation."
            : "Review both records and the saved evidence before confirming. Applying this association leaves funding and business fields unchanged and keeps automatic linking on hold."}</p>
        </section>}
        {decision.historicalInvalid && <p role="alert">The saved historical evidence is invalid. Prepare a fresh historical review; this pair cannot be confirmed or applied here.</p>}
        {decision.savedNote && <section aria-label={decision.savedNote.run_created_at ? "Earlier review of this transfer" : "Saved note for this review"}>
          <h3>{decision.savedNote.run_created_at ? "Earlier review of this transfer" : "Saved note for this review"}</h3>
          <p className={styles.help}>Note saved: {noteTime(decision.savedNote.reviewed_at)} · {noteReviewer(decision.savedNote.reviewed_by)}</p>
          {decision.savedNote.run_created_at && <>
            <p className={styles.help}>Earlier review prepared: {noteTime(decision.savedNote.run_created_at)}</p>
            <p className={styles.help}>Historical context only. This note may concern a different ACAT and is not evidence or approval for the current pair.</p>
          </>}
          <p style={{ whiteSpace: "pre-wrap" }}>{decision.savedNote.review_reason}</p>
        </section>}
        {!historicalFinal && <form action={reviewAcatDecision} className={styles.form}>
          <input type="hidden" name="decisionId" value={decision.id} />
          <input type="hidden" name="reviewVersion" value={decision.review_version} />
          <input type="hidden" name="evidenceDigest" value={decision.evidence_digest} />
          {transfer && <input type="hidden" name="targetVersion" value={transfer.acat_link_version} />}
          <label>Review note<textarea name="reason" maxLength={2000} rows={2} /></label>
          <div className={styles.buttons}>
            {historicalContext && <label className={styles.confirmation}><input type="checkbox" name="historicalConfirmed" value="yes" />I reviewed the saved transfer evidence and confirm that these two records represent the same transfer. Automatic linking will remain on hold.</label>}
            {!decision.historicalInvalid && paired && decision.action === "review" && <button name="action" value="ACCEPT" type="submit">{historicalContext ? "Confirm this historical pair" : "Confirm this pair"}</button>}
            {!decision.historicalInvalid && paired && decision.action === "propose" && <button name="action" value="ACCEPT" type="submit">Confirm proposed link</button>}
            {paired && <button name="action" value="REJECT" type="submit">Reject pair</button>}
            <button name="action" value="PENDING" type="submit">Keep pending</button>
            {transfer && !historicalContext && !decision.historicalInvalid && <button name="action" value={transfer.acat_auto_link_hold ? "RESUME" : "HOLD"} type="submit">
              {transfer.acat_auto_link_hold ? "Resume automatic linking" : "Hold automatic linking"}
            </button>}
          </div>
        </form>}
        <p className={styles.help}>Review: {decision.disposition === "PENDING" ? "Not confirmed or rejected" : label(decision.disposition)}</p>
        {!decision.historicalInvalid && decision.disposition === "ACCEPT" && ["PENDING", "CONFLICT", "BLOCKED"].includes(decision.outcome) && <form action={applyReviewedAcatDecision}>
          <input type="hidden" name="decisionId" value={decision.id} />
          <input type="hidden" name="reviewVersion" value={decision.review_version} />
          <button type="submit" className={styles.primary}>{historicalContext ? (decision.outcome === "PENDING" ? "Apply confirmed historical link" : "Retry confirmed historical link") : (decision.outcome === "PENDING" ? "Apply confirmed link" : "Retry confirmed link")}</button>
        </form>}
        {decision.outcome === "APPLIED" && <form action={undoReviewedAcatDecision}>
          <input type="hidden" name="decisionId" value={decision.id} />
          <input type="hidden" name="reviewVersion" value={decision.review_version} />
          <button type="submit">Undo this link and hold automation</button>
        </form>}
      </CardBody></Card>;
    })}</div>
    {data.count > 50 && <nav className={styles.runs} aria-label="Review pages">
      {page > 1 && <Link href={reviewUrl({ page: String(page - 1) })}>Previous</Link>}
      <span>Page {page} of {Math.ceil(data.count / 50)}</span>
      {page * 50 < data.count && <Link href={reviewUrl({ page: String(page + 1) })}>Next</Link>}
    </nav>}
  </>;
}
