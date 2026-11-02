import "server-only";

import Link from "next/link";
import { Card, CardBody } from "@/components/ui";
import type { OperationsSlackPreview as Preview } from "@/lib/data/operations-slack-preview";
import styles from "./OperationsSlackPreview.module.css";

export function OperationsSlackPreview({ preview }: { preview: Preview | null }) {
  if (process.env.APP_ENV !== "dev") return null;
  const notification = preview?.notification;
  return (
    <Card className={styles.panel} role="region" aria-labelledby="operations-slack-preview-title">
      <details className={styles.details}>
        <summary id="operations-slack-preview-title">Slack readiness · development only</summary>
        <CardBody className={styles.body}>
          <p>Preview only — no message sent by this view.</p>
          {!preview ? <p role="status">Slack preview is temporarily unavailable. No notification action was taken. Reload this request to try again.</p> : <>
        <dl className={styles.metadata}>
          <div><dt>Capture flag now</dt><dd>{preview.captureEnabled ? "ON" : "OFF"}</dd></div>
          <div><dt>Delivery flag now</dt><dd>{preview.deliveryFlagEnabled ? "ON" : "OFF"}</dd></div>
          <div><dt>Effective delivery</dt><dd>Blocked in development</dd></div>
          <div><dt>Fixed production channel</dt><dd>{preview.channel}</dd></div>
        </dl>
        <p>{preview.captureEnabled
          ? "Capture is enabled for new submissions. The saved record below is the evidence for this request; the flag alone is not."
          : "Capture is off. A future capture cutover requires separate approval; this view does not enable it."}</p>
        <h3>Saved notification record</h3>
        {notification ? <dl className={styles.metadata}>
          <div><dt>Queue status</dt><dd>{notification.status}</dd></div>
          <div><dt>Delivery attempts</dt><dd>{notification.attempts}</dd></div>
          <div><dt>Submitted event ID</dt><dd>{notification.eventId}</dd></div>
          <div><dt>Captured at</dt><dd><time dateTime={notification.capturedAt}>{notification.capturedAt}</time></dd></div>
          <div><dt>Stored Slack receipt</dt><dd>{notification.receiptPresent ? "Present" : "None"}</dd></div>
        </dl> : <p>No notification record exists for this request.</p>}
        <p>Viewing this request does not capture, send, retry, acknowledge, or replay a notification. Historical and pre-capture requests are not backfilled. A saved receipt is separate from this preview.</p>
        <h3>Production message template · NOT SENT by this preview</h3>
        <p>This is the new-submission template, not evidence of capture or delivery and not a statement of the request&apos;s current review status. The production URL below is inert; this development request may not exist in production.</p>
        <pre className={styles.message}>{preview.message}</pre>
        <Link href={`/operations/fee-requests?request=${preview.requestId}#request-${preview.requestId}`} prefetch={false}>Open this request in development</Link>
          </>}
        </CardBody>
      </details>
    </Card>
  );
}
