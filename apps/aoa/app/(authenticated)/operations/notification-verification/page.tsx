import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { OPERATIONS_SLACK_VERIFICATION_REQUEST_ID } from "@/lib/operations/operations-slack-verification";
import { readOperationsSlackDiagnostic } from "@/lib/data/operations-slack-diagnostic";
import { buildOperationsSlackMessage } from "@/lib/slack/operations-fee-notifications";
import { confirmOperationsSlackVerification } from "./actions";

export const dynamic = "force-dynamic";

export default async function NotificationVerificationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role;
  const email = session.user.email;
  const expires = Date.parse(session.expires);
  if (!canAccessOperationsTools(role) || !email?.trim() || !session.navigationScope
    || !Number.isFinite(expires) || expires <= Date.now()) notFound();
  const query = await searchParams;
  if (Object.keys(query).some((key) => key !== "result")
    || (query.result !== undefined && !["denied", "unavailable", "recorded"].includes(String(query.result)))) notFound();
  let diagnostic: Awaited<ReturnType<typeof readOperationsSlackDiagnostic>> | null = null;
  try {
    diagnostic = await readOperationsSlackDiagnostic({ role, email });
    if (Date.now() >= expires) diagnostic = null;
  } catch { /* Show a generic unavailable state, never private error contents. */ }
  return <>
    <Link href="/operations">← Operations Tools</Link>
    <SectionLabel>Operations · Notification verification</SectionLabel>
    <h1>AOA Operations notification test</h1>
    <Pill tone="gold">TEST — no client action</Pill>
    <p>This page checks notification delivery without using a real client or account. The synthetic request is canceled before it becomes visible. No money moves and no billing changes.</p>
    {query.result === "recorded" && <p role="status">The one-time test is recorded. Refresh to check its receipt. Repeating the confirmation does not queue another message.</p>}
    {query.result === "denied" && <p role="alert">The confirmation was not accepted. No test was created.</p>}
    {query.result === "unavailable" && <p role="alert">The test could not be confirmed. Refresh the status below before taking any further action; do not assume a timeout means nothing was recorded.</p>}
    <Card><CardHeader><h2>Queue and test receipt</h2></CardHeader><CardBody>
      {diagnostic ? <>
        <p>Capture: {diagnostic.captureEnabled ? "enabled" : "disabled"}. Delivery: {diagnostic.deliveryEnabled ? "enabled" : "disabled"}.
          {diagnostic.writesPaused && " Application writes are paused."}</p>
        <table><caption>Current notification queue</caption><thead><tr><th scope="col">Status</th><th scope="col">Count</th></tr></thead>
          <tbody>{Object.entries(diagnostic.counts).map(([status, count]) => <tr key={status}><th scope="row">{status}</th><td>{count}</td></tr>)}</tbody>
        </table>
        {diagnostic.needsReviewCount > 0 && <p role="alert">{diagnostic.needsReviewCount} delivery result(s) need review before testing.</p>}
        {diagnostic.test ? <dl>
          <dt>Test ID</dt><dd>{diagnostic.test.requestId}</dd>
          <dt>Synthetic request</dt><dd>{diagnostic.test.requestStatus} — no action required</dd>
          <dt>Notification</dt><dd>{diagnostic.test.notificationStatus}</dd>
          <dt>Delivery attempts</dt><dd>{diagnostic.test.attempts}</dd>
          <dt>Destination</dt><dd>#alerts-ops ({diagnostic.test.channelId})</dd>
          <dt>Slack receipt timestamp</dt><dd>{diagnostic.test.slackTs ?? "No receipt yet"}</dd>
          <dt>Last result</dt><dd>{diagnostic.test.lastCode ?? "No error recorded"}</dd>
          <dt>Captured</dt><dd>{diagnostic.test.capturedAt}</dd>
          <dt>Last updated</dt><dd>{diagnostic.test.updatedAt}</dd>
        </dl> : <p>No test has been recorded.</p>}
      </> : <p role="alert">Notification verification is unavailable.</p>}
      <Link href="/operations/notification-verification" prefetch={false}>Refresh status</Link>
    </CardBody></Card>
    <Card><CardHeader><h2>One-time test notification</h2></CardHeader><CardBody>
      <p>Destination: #alerts-ops. Production uses the existing scheduler. Development captures the test but does not send Slack messages.</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{buildOperationsSlackMessage("SERVICE_GUARANTEE", OPERATIONS_SLACK_VERIFICATION_REQUEST_ID)}</pre>
      <p>The confirmation is single-use for this database. Existing pending work or delivery problems must be reviewed first; this test does not replay or clear them.</p>
      {diagnostic && <form action={confirmOperationsSlackVerification}>
        <label><input type="checkbox" name="confirm" value={OPERATIONS_SLACK_VERIFICATION_REQUEST_ID} required /> I confirm this clearly labeled test notification to #alerts-ops.</label>
        <p><button type="submit">{diagnostic.test ? "Verify existing test (no new message)" : "Confirm one-time test"}</button></p>
      </form>}
    </CardBody></Card>
  </>;
}
