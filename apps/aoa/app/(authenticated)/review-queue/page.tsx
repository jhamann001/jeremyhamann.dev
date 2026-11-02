import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardBody, CardHeader, Pill, SectionLabel, StatTile } from "@/components/ui";
import {
  canManageReviewQueue,
  listReviewQueue,
  type ReviewQueueRow,
} from "@/lib/data/review-queue";
import { reviewQueueEnabled } from "@/lib/flags";
import { updateReviewQueueItem } from "./actions";
import styles from "./page.module.css";

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short",
  }).format(new Date(value));
}

function statusTone(status: string): "red" | "amber" | "green" | "gray" | "blue" {
  if (status === "NEW") return "red";
  if (status === "IN_REVIEW") return "amber";
  if (status === "RESOLVED") return "green";
  return "blue";
}

function label(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/^\w/, (char) => char.toUpperCase());
}

function freshnessLabel(state: string): string {
  return {
    NOT_RUN: "Not run",
    RUNNING: "Sweep running",
    PROGRESSING: "Sweep progressing",
    FRESH: "Current",
    STALE: "Stale",
    FAILED: "Needs attention",
  }[state] ?? "Unknown";
}

function context(row: ReviewQueueRow): string[] {
  const values: string[] = [];
  if (row.snapshot.accountLast4) values.push(`Account ending ${row.snapshot.accountLast4}`);
  if (row.snapshot.candidateCount != null) values.push(`${row.snapshot.candidateCount} candidates`);
  if (row.snapshot.accountCount != null) values.push(`${row.snapshot.accountCount} accounts`);
  if (row.snapshot.identityType) values.push(label(row.snapshot.identityType));
  if (row.snapshot.reasonCode) values.push(label(row.snapshot.reasonCode));
  return values;
}

export default async function ReviewQueuePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!reviewQueueEnabled() || !canManageReviewQueue(role)) notFound();

  const sp = await searchParams;
  const result = await listReviewQueue(
    { role, email: session.user.email ?? null },
    {
      page: Number(one(sp.page)) || 1,
      source: one(sp.source),
      type: one(sp.type),
      status: one(sp.status),
      owner: one(sp.owner),
      age: Number(one(sp.age)) || undefined,
      includeCleared: one(sp.cleared) === "1",
    },
  );
  if (!result.ok) notFound();

  const active = result.rows.filter((row) => row.sourceActive);
  const unassigned = active.filter((row) => !row.assignedTo).length;
  const oldest = active[0]?.detectedAt ?? null;
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    for (const key of ["source", "type", "status", "owner", "age", "cleared"]) {
      const value = one(sp[key]);
      if (value) params.set(key, value);
    }
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return query ? `/review-queue?${query}` : "/review-queue";
  };

  return (
    <>
      <SectionLabel>Operations · data review</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1>Review queue</h1>
          <p>Firm-wide oversight for Trade Request and CRM identity conditions. CRM mappings are resolved directly in CRM Explorer; this page tracks ownership, age, and history.</p>
        </div>
        <Pill tone="green" dot>Materialized reads</Pill>
      </div>

      <div className={styles.stats}>
        <StatTile label="Matching items" value={result.total.toLocaleString()} />
        <StatTile label="Unassigned on page" value={unassigned} />
        <StatTile label="Oldest on page" value={formatDate(oldest)} />
        <StatTile label="Sweep health" value={freshnessLabel(result.freshness.state)} />
      </div>

      {result.freshness.state !== "FRESH" &&
        result.freshness.state !== "RUNNING" &&
        result.freshness.state !== "PROGRESSING" && (
        <Card className={styles.freshnessBanner}>
          <CardBody>
            <p role="alert"><b>Review data may not be current.</b>{" "}
              {result.freshness.state === "FAILED"
                ? `The latest sweep failed${result.freshness.lastFailureSource ? ` in ${label(result.freshness.lastFailureSource)}` : ""}.`
                : result.freshness.state === "STALE"
                  ? "No complete sweep has finished in the last two hours."
                  : "The recurring materializer has not completed its first sweep."}
              {result.freshness.lastCompletedAt ? ` Last complete: ${formatDate(result.freshness.lastCompletedAt)}.` : ""}
            </p>
          </CardBody>
        </Card>
      )}

      {one(sp.queueMessage) === "conflict" && (
        <Card className={styles.conflictBanner}>
          <CardBody>
            <p role="alert"><b>This review item changed before your save completed.</b> Reload the latest item, then reapply your decision.</p>
          </CardBody>
        </Card>
      )}

      <Card className={styles.card}>
        <CardHeader><h2>Filters</h2></CardHeader>
        <CardBody>
          <form action="/review-queue" method="get" className={styles.filters}>
            <label><span>Source</span><select name="source" defaultValue={result.filters.source ?? ""}>
              <option value="">All sources</option><option value="TRADE_REQUEST">Trade Request</option><option value="CRM_IDENTITY">CRM identity</option>
            </select></label>
            <label><span>Type</span><select name="type" defaultValue={result.filters.type ?? ""}>
              <option value="">All types</option>{result.types.map((type) => <option key={type} value={type}>{label(type)}</option>)}
            </select></label>
            <label><span>Status</span><select name="status" defaultValue={result.filters.status ?? ""}>
              <option value="">All statuses</option>{["NEW", "IN_REVIEW", "RESOLVED", "SNOOZED"].map((status) => <option key={status} value={status}>{label(status)}</option>)}
            </select></label>
            <label><span>Owner</span><select name="owner" defaultValue={result.filters.owner ?? ""}>
              <option value="">All owners</option><option value="unassigned">Unassigned</option>{result.owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
            </select></label>
            <label><span>Minimum age</span><select name="age" defaultValue={result.filters.age ? String(result.filters.age) : ""}>
              <option value="">Any age</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
            </select></label>
            <label className={styles.checkbox}><input type="checkbox" name="cleared" value="1" defaultChecked={result.filters.includeCleared} /> Include source-cleared history</label>
            <div className={styles.filterActions}><button className="btn" type="submit">Apply</button><Link href="/review-queue">Clear</Link></div>
          </form>
        </CardBody>
      </Card>

      <div className={styles.queue}>
        {result.rows.length === 0 ? (
          <Card><CardBody><p className={styles.empty}>No review items match these filters.</p></CardBody></Card>
        ) : result.rows.map((row) => (
          <Card key={row.id} className={!row.sourceActive ? styles.cleared : undefined}>
            <CardHeader className={styles.itemHeader}>
              <div>
                <div className={styles.pills}><Pill tone={row.source === "TRADE_REQUEST" ? "blue" : "gray"}>{label(row.source)}</Pill><Pill tone={statusTone(row.status)}>{label(row.status)}</Pill>{!row.sourceActive && <Pill tone="green">Source cleared</Pill>}</div>
                <h2>{row.summary}</h2>
                <p>{label(row.type)} · First detected {formatDate(row.detectedAt)} · Last checked {formatDate(row.lastSeenAt)}</p>
              </div>
              <Link className="btn" href={row.href}>{row.source === "CRM_IDENTITY" ? "Resolve in CRM Explorer →" : "Open client resolution →"}</Link>
            </CardHeader>
            <CardBody>
              {context(row).length > 0 && <div className={styles.context}>{context(row).map((value) => <span key={value}>{value}</span>)}</div>}
              {row.sourceActive ? (
                <form action={updateReviewQueueItem} className={styles.workflow}>
                  <input type="hidden" name="itemId" value={row.id} />
                  <input type="hidden" name="expectedUpdatedAt" value={row.updatedAt} />
                  <input type="hidden" name="returnTo" value={pageHref(result.page)} />
                  <label><span>Status</span><select name="status" defaultValue={row.status}>{["NEW", "IN_REVIEW", "RESOLVED", "SNOOZED"].map((status) => <option key={status} value={status}>{label(status)}</option>)}</select></label>
                  <label><span>Assigned owner</span><input type="email" name="assignedTo" defaultValue={row.assignedTo ?? ""} placeholder="Unassigned" list="review-queue-owners" /></label>
                  <label><span>Snooze until</span><input type="date" name="snoozedUntil" defaultValue={row.snoozedUntil?.slice(0, 10) ?? ""} /></label>
                  <label className={styles.note}><span>Resolution note (optional)</span><textarea name="resolutionNote" maxLength={1000} defaultValue={row.resolutionNote} /></label>
                  <button type="submit" className="btn">Save workflow</button>
                </form>
              ) : <p className={styles.sourceCleared}>The authoritative source no longer reports this condition. The history remains available for audit.</p>}
              <details className={styles.history}><summary>Status and assignment history ({row.history.length}{row.history.length === 8 ? "+" : ""})</summary>
                {row.history.length === 0 ? <p>No workflow events recorded.</p> : <ol>{row.history.map((event) => <li key={event.id}><b>{label(event.action)}</b> · {formatDate(event.at)} · {event.actorEmail ?? "System"}{event.fromStatus || event.toStatus ? ` · ${event.fromStatus ? label(event.fromStatus) : "—"} → ${event.toStatus ? label(event.toStatus) : "—"}` : ""}{event.fromAssignee !== event.toAssignee && (event.fromAssignee || event.toAssignee) ? ` · Assignment: ${event.fromAssignee ?? "Unassigned"} → ${event.toAssignee ?? "Unassigned"}` : ""}</li>)}</ol>}
              </details>
            </CardBody>
          </Card>
        ))}
      </div>
      <datalist id="review-queue-owners">{result.owners.map((owner) => <option key={owner} value={owner} />)}</datalist>
      <nav className={styles.pagination} aria-label="Review queue pages"><Link aria-disabled={result.page <= 1} href={pageHref(Math.max(1, result.page - 1))}>← Previous</Link><span>Page {result.page} of {result.pageCount}</span><Link aria-disabled={result.page >= result.pageCount} href={pageHref(Math.min(result.pageCount, result.page + 1))}>Next →</Link></nav>
    </>
  );
}
