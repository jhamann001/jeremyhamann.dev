import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { FeeRequestIntake } from "@/components/operations";
import { FeeRequestWorkspace } from "@/components/operations/FeeRequestWorkspace";
import { FeeRequestCard } from "@/components/operations/FeeRequestCard";
import { FeeRequestBackLink } from "@/components/operations/FeeRequestBackLink";
import { FeeRequestIntakePanel } from "@/components/operations/FeeRequestIntakePanel";
import { OperationsSlackPreview } from "@/components/operations/OperationsSlackPreview";
import { Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import { operationsFeeRequestDirectory, operationsFeeRequestDetail, type OperationsFeeRequestDirectory } from "@/lib/data/operations-fee-requests";
import { feeRequestSearchParams, parseFeeRequestQuery } from "@/lib/operations/fee-request-query";
import { operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { operationsSlackPreview } from "@/lib/data/operations-slack-preview";
import styles from "./page.module.css";

type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : new Date().toISOString().slice(0, 7);
}

function currentDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : new Date().toISOString().slice(0, 10);
}


export default async function OperationsFeeRequestsPage({ searchParams }: {
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsFeeRequestsPreviewEnabled() || !canAccessOperationsTools(role)) notFound();
  const query = await searchParams;
  const selectedRequestId = query.request;
  if (selectedRequestId !== undefined && (
    typeof selectedRequestId !== "string" || selectedRequestId.length < 16
    || selectedRequestId.length > 64 || /[^A-Za-z0-9_-]/.test(selectedRequestId)
  )) notFound();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "request" || key === "message") continue;
    if (typeof value !== "string" || key === "snapshot" || key === "pageSize") notFound();
    params.set(key, value);
  }
  let parsed;
  try { parsed = parseFeeRequestQuery(params, false); } catch { notFound(); }
  const identity = { role, email: session.user.email ?? null };
  const selected = selectedRequestId ? await operationsFeeRequestDetail(identity, selectedRequestId) : null;
  if (selectedRequestId && !selected) notFound();
  let directory: OperationsFeeRequestDirectory | null = null;
  if (!selectedRequestId) {
    try { directory = await operationsFeeRequestDirectory(identity, parsed); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "fee_request_page_out_of_range") throw error;
      // A retained numbered window can disappear after deletions or access changes.
      // Keep its safe filters and explain the first-page fallback after redirect.
      const fallback = feeRequestSearchParams(parsed.filters);
      fallback.set("message", "history-refreshed");
      redirect(`/operations/fee-requests?${fallback}`);
    }
  }
  const message = first(query.message);
  const submissionKey = randomUUID();
  const isDevelopment = process.env.APP_ENV?.toLowerCase() === "dev";
  const scope = session.navigationScope ?? "";
  let slackPreview: Awaited<ReturnType<typeof operationsSlackPreview>> = null;
  let slackPreviewUnavailable = false;
  if (selected && process.env.APP_ENV === "dev") {
    try { slackPreview = await operationsSlackPreview(identity, selected.id); }
    catch { slackPreviewUnavailable = true; }
  }

  return (
    <>
      <Link className={styles.back} href="/operations" prefetch>← Operations Tools</Link>
      <SectionLabel>Operations · Fee credits &amp; service guarantees</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1>Fee Credits &amp; Service Guarantees</h1>
          <p>Create a controlled request tied to an AOA client and their current account records.</p>
        </div>
        <div className={styles.titleActions}>
          <a className={styles.exportLink} href="/api/operations/fee-requests/export?area=credits">Export all fee credits</a>
          <a className={styles.exportLink} href="/api/operations/fee-requests/export?area=exceptions">Export all service guarantees &amp; exceptions</a>
          <Pill tone="gold">{isDevelopment ? "Development workflow" : "Request workflow"}</Pill>
        </div>
      </div>

      <div className={styles.warning} role="note">
        <b>AOA records the request and review workflow.</b> It does not calculate an advisory fee, move money, or alter billing. Slack notifications are disabled in development. Every request starts pending; authorized Operations and Admin users can approve, reject, cancel, or record a completed credit here.
      </div>
      {message === "submitted" && <p className={styles.success} role="status">Request submitted to the pending queue.</p>}
      {message === "workflow-updated" && <p className={styles.success} role="status">The request workflow was updated.</p>}
      {message === "workflow-conflict" && <p className={styles.error} role="alert">This request changed before your update was saved. Review its current status and try again.</p>}
      {message === "workflow-invalid" && <p className={styles.error} role="alert">That workflow action is not available for the request&apos;s current status.</p>}
      {message === "workflow-failed" && <p className={styles.error} role="alert">The workflow update could not be saved. Check the required fields and try again.</p>}
      {message === "submission-failed" && <p className={styles.error} role="alert">The request could not be submitted. Check the required fields and account selection, then try again.</p>}
      {message === "history-refreshed" && <p className={styles.warning} role="status">The previous page is no longer available. Showing the first page with your filters preserved.</p>}


      {selected ? (
        <>
          <FeeRequestBackLink scope={scope} detailHref={`/operations/fee-requests?request=${selected.id}`} className={styles.back} />
          <FeeRequestCard request={selected} defaultCreditedDate={currentDate()} open />
          {(slackPreview || slackPreviewUnavailable) && <OperationsSlackPreview preview={slackPreview} />}
        </>
      ) : directory && (
        <>
          <FeeRequestIntakePanel defaultOpen={message === "submission-failed"}>
            <Card className={styles.intakeCard}>
              <CardHeader className={styles.cardHeader}>
                <h2>New request</h2>
                <p>The authenticated user is recorded automatically; users cannot submit under another role.</p>
              </CardHeader>
              <CardBody><FeeRequestIntake defaultWaiverMonth={currentMonth()} submissionKey={submissionKey} /></CardBody>
            </Card>
          </FeeRequestIntakePanel>
          <FeeRequestWorkspace key={`${scope}:${parsed.queryKey}:${directory.page}:${directory.snapshot}`}
            initial={directory} filters={parsed.filters} scope={scope} defaultCreditedDate={currentDate()} />
        </>
      )}
    </>
  );
}
