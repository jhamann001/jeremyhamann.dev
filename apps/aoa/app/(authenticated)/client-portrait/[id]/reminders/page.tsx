import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { clientReminders } from "@/lib/data/client-reminders";
import { Card, Kpi, Pill, SectionLabel } from "@/components/ui";
import { ClientRemindersPanel } from "@/components/client-portrait";
import { TableEmptyState } from "@/components/tasks/TableEmptyState";
import { usd } from "@/lib/format";

// Reminders tab — the REAL client-scoped projection of the Phase C workflow
// engine (Phase F / F2, ticket; replaces the F1 stopgap). Read-only: the
// data fn filters getWorkflowSeed() to this client (TDD ADR-3/4) and every row
// links to the firm-wide screen for the action. Client identity + household
// are REAL and RLS-scoped (ADR-5); the nudge/decision bodies are Phase C
// fixtures, badged per panel.

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };

  // REAL client + household through the RLS-scoped seam; a client the caller
  // cannot see (outside their book, or unknown id) yields null → 404.
  const data = await clientReminders(identity, id);
  if (!data) notFound();

  const { client, household, householdAum, decisions, nudges } = data;

  // KPI counts computed from the CLIENT-SCOPED set — real counts, not the
  // mockup's fabricated firm-wide stats (TDD §5).
  const items = decisions.flatMap((d) => d.items);
  const queued = nudges.filter((n) => n.status !== "sent").length;
  const sent = nudges.filter((n) => n.status === "sent").length;
  const open = items.filter((i) => i.status === "open").length;
  const snoozed = items.filter((i) => i.status === "snoozed").length;

  const empty = decisions.length === 0 && nudges.length === 0;

  return (
    <>
      {/* Header — REAL identity + household context. No PreviewBadge. */}
      <SectionLabel>Client · Reminders</SectionLabel>
      <h1>{client.name}</h1>
      {household ? (
        <p style={{ color: "var(--muted)", marginTop: 6 }}>
          {household.name}
          {household.status ? (
            <>
              {" · "}
              <Pill tone="green" dot>
                {household.status}
              </Pill>
            </>
          ) : null}
          {" · "}
          {/* Recomputed household AUM (deals-derived with mirror fallback) —
              consistent with the Portrait tab and Household detail page. */}
          {usd(householdAum)} AUM
        </p>
      ) : (
        <p style={{ color: "var(--muted)", marginTop: 6 }}>
          No household on file
        </p>
      )}
      <p style={{ color: "var(--muted)", marginTop: 8, maxWidth: 640, fontSize: 13 }}>
        Read-only projection of the firm-wide workflow, scoped to this client.
        Reminder content is sample data (wired to real sources in Phase D);
        send, schedule, and decide actions live on Smart Nudges and Decision
        Center.
      </p>

      {empty ? (
        <div style={{ marginTop: 18 }}>
          <TableEmptyState
            title={`No reminders for ${client.name} yet`}
            hint="Decisions and nudges for this client's household will appear here as the workflow picks them up."
          />
        </div>
      ) : (
        <>
          {/* KPIs — computed from the client-scoped set above. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 16,
              marginTop: 18,
            }}
          >
            <Card>
              <Kpi label="Reminders queued" value={queued} />
            </Card>
            <Card>
              <Kpi label="Reminders sent" value={sent} />
            </Card>
            <Card>
              <Kpi label="Open decisions" value={open} />
            </Card>
            <Card>
              <Kpi label="Snoozed" value={snoozed} />
            </Card>
          </div>

          <ClientRemindersPanel
            clientName={client.name}
            decisions={decisions}
            nudges={nudges}
          />
        </>
      )}
    </>
  );
}
