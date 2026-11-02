import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { withUserScope } from "@/lib/rls";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import { demoMode } from "@/lib/demo/mode";
import { listOutbox } from "@/lib/demo/outbox";
import { Card, SectionLabel } from "@/components/ui";
import { TableEmptyState } from "@/components/tasks/TableEmptyState";
import { relTime } from "@/components/audit/audit-time";
import styles from "./page.module.css";

// The public demo's Outbox (lib/demo/outbox.ts): what the app would have sent, newest first, for every visitor's
// actions, not only the reader's own. So it is read under the reader's row security: an advisor sees the messages about
// the households and clients in their own book, admin and operations every message. Outside the demo the page
// doesn't exist.
export default async function OutboxPage() {
  if (!demoMode()) notFound();
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = normalizeAppRole((session.user as { role?: string }).role);
  const messages = await withUserScope({ role, email: session.user.email ?? null }, (tx) => listOutbox(tx, 100));
  const everyMessage = role === "ADMIN" || role === "OPERATIONS";
  return <>
    <SectionLabel>Admin · Captured messages</SectionLabel>
    <h1 style={{ marginTop: 4 }}>Outbox</h1>
    <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
      Everything Always-On-Advice would send in production lands here instead: Slack posts, closeout checklists and
      Operations alerts. Nothing leaves the demo.
      {everyMessage ? " You see every message." : " You see the messages about the households and clients you can see."}
    </p>
    {messages.length === 0 ? (
      <TableEmptyState title="Nothing sent yet"
        hint="Move a transfer to In Transfer, submit a trade request or file a fee request, and the message it would send shows up here." />
    ) : (
      <Card className={styles.list}>
        <ul>
          {messages.map((m) => (
            <li key={m.id}>
              <span className={styles.where}>{m.channel} · {m.destination}</span>
              <time className={styles.when} dateTime={m.createdAt}>{relTime(m.createdAt)}</time>
              <strong className={styles.title}>{m.title}</strong>
              {m.detail && <span className={styles.detail}>{m.detail}</span>}
              <details className={styles.message}>
                <summary>Message as it would have been sent</summary>
                <pre>{m.body}</pre>
              </details>
            </li>
          ))}
        </ul>
      </Card>
    )}
  </>;
}
