import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  canManageEmployeeRoster,
  employeeContactCandidates,
  employeeRosterPageData,
} from "@/lib/data/employee-roster";
import { evaluateEmployeeRosterReminder } from "@/lib/data/employee-roster-reminder";
import { Card, CardBody, CardHeader, Pill, SectionLabel, StatTile } from "@/components/ui";
import {
  applyEmployeeRosterSnapshot,
  previewEmployeeRoster,
} from "./actions";
import { EmployeeMatchReview } from "./EmployeeMatchReview";
import styles from "./page.module.css";

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

const MESSAGES: Record<string, string> = {
  created: "Workbook validated. Review the snapshot and contact matches before applying it.",
  existing: "This exact workbook was already uploaded. Its existing preview is shown.",
  applied: "The roster snapshot is active and employee badges have been refreshed.",
  saved: "The contact decision was saved.",
  conflict: "That CRM contact is already confirmed for another employee.",
  older_snapshot: "This snapshot is older than the active roster. Applying it requires a separate, explicit rollback workflow.",
  forbidden: "Your role cannot manage employee rosters.",
  "invalid-file": "Choose a non-empty .xlsx workbook no larger than 1 MB.",
  "invalid-roster": "The workbook or effective date could not be validated.",
  "invalid-workbook": "The file is not a readable .xlsx workbook.",
  "unsafe-archive": "The workbook archive failed the security preflight. Export a fresh .xlsx file from Rippling.",
  "missing-header": "The workbook is missing one of the required Rippling columns.",
  "duplicate-header": "A required Rippling column appears more than once.",
  "missing-employee-id": "At least one row is missing its Employee ID.",
  "missing-employee-name": "At least one employee row is missing a name.",
  "unsupported-status": "The workbook contains an employment status other than Active or Terminated.",
  "inconsistent-duplicate": "Repeated rows for an Employee ID disagree on employee-level fields.",
  "invalid-date": "The workbook contains an unreadable employment date.",
  "field-too-long": "A workbook field exceeds the accepted length.",
  "too-many-rows": "The workbook exceeds the 10,000-row safety limit.",
  "file-too-large": "The workbook exceeds the 1 MB safety limit.",
  invalid: "The requested change could not be validated.",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${value.slice(0, 10)}T00:00:00.000Z`));
}

export default async function EmployeeRosterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canManageEmployeeRoster(role)) notFound();
  const sp = await searchParams;
  const uploadId = one(sp.upload);
  const entryId = one(sp.entry);
  const message = one(sp.message);
  const identity = { role, email: session.user.email ?? null };
  const data = await employeeRosterPageData(identity, uploadId || undefined);
  if (!data) notFound();
  const selectedEmployee = data.rows.find((row) => row.entryId === entryId) ?? null;
  const initialSearch = selectedEmployee
    ? await employeeContactCandidates(identity, selectedEmployee.entryId, selectedEmployee.displayName)
    : { candidates: [], previousRejections: [] };
  const active = data.uploads.find((upload) => upload.status === "APPLIED") ?? null;
  const rosterReminder = evaluateEmployeeRosterReminder({
    activeEffectiveDate: active?.effectiveDate ?? null,
  });

  return (
    <>
      <Link className={styles.back} href="/crm">← CRM Explorer</Link>
      <SectionLabel>Admin · CRM Explorer</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1>Employee roster</h1>
          <p className={styles.intro}>
            Upload a complete Rippling snapshot after employment changes and after each quarter,
            review suggested CRM contacts, then apply it.
            Exact-name results are suggestions only and always require human confirmation.
          </p>
        </div>
        <Pill tone="green">Admin / Operations only</Pill>
      </div>

      {message && MESSAGES[message] ? (
        <div className={message === "conflict" || message.startsWith("invalid")
          || message === "older_snapshot" || message === "unsafe-archive"
          || message.includes("header") || message.includes("missing")
          || message.includes("status") || message.includes("duplicate")
          || message.includes("too-") || message.includes("large")
          ? styles.error : styles.success} role="status">
          {MESSAGES[message]}
        </div>
      ) : null}

      <div className={rosterReminder.state === "OVERDUE" ? styles.rosterOverdue : styles.rosterSchedule}>
        <div>
          <strong>{rosterReminder.notification?.title ?? "Employee roster is current"}</strong>
          <p>
            {rosterReminder.notification?.body
              ?? `The next quarterly refresh notification appears ${formatDate(rosterReminder.nextReminderDate)}.`}
          </p>
        </div>
        <Pill tone={rosterReminder.state === "OVERDUE" ? "red" : rosterReminder.state === "DUE" ? "amber" : "green"} dot>
          {rosterReminder.state.toLowerCase()}
        </Pill>
      </div>

      <div className={styles.stats}>
        <StatTile label="Current effective date" value={active ? formatDate(active.effectiveDate) : "Not applied"} />
        <StatTile label="Employees" value={(active?.employeeCount ?? 0).toLocaleString()} />
        <StatTile label="Active" value={(active?.activeCount ?? 0).toLocaleString()} />
        <StatTile label="Former" value={(active?.formerCount ?? 0).toLocaleString()} />
      </div>

      <Card className={styles.card}>
        <CardHeader>
          <h2>1. Upload complete snapshot</h2>
          <p className={styles.hint}>
            The workbook is validated in memory and discarded. Dependent names are never stored
            and dependent rows never create employee flags.
          </p>
        </CardHeader>
        <CardBody>
          <form action={previewEmployeeRoster} className={styles.uploadForm}>
            <label>
              <span>Rippling .xlsx workbook</span>
              <input type="file" name="workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
            </label>
            <label>
              <span>Snapshot effective date</span>
              <input type="date" name="effectiveDate" defaultValue={new Date().toISOString().slice(0, 10)} required />
            </label>
            <button className="btn" type="submit">Validate and preview</button>
          </form>
        </CardBody>
      </Card>

      {data.selectedUpload ? (
        <Card className={styles.card}>
          <CardHeader className={styles.previewHeader}>
            <div>
              <h2>2. Review snapshot</h2>
              <p className={styles.hint}>
                Effective {formatDate(data.selectedUpload.effectiveDate)} · {data.selectedUpload.rowCount} source rows · {data.selectedUpload.dependentRowCount} dependent rows ignored for matching
              </p>
            </div>
            <Pill tone={data.selectedUpload.status === "APPLIED" ? "green" : data.selectedUpload.status === "DRAFT" ? "amber" : "gray"} dot>
              {data.selectedUpload.status.toLowerCase()}
            </Pill>
          </CardHeader>
          <CardBody>
            {data.selectedUpload.status === "DRAFT" ? (
              <div className={styles.applyBar}>
                <p>Applying replaces the current roster snapshot. Existing confirmed and rejected CRM decisions are preserved.</p>
                <form action={applyEmployeeRosterSnapshot}>
                  <input type="hidden" name="uploadId" value={data.selectedUpload.id} />
                  <button className="btn" type="submit">Apply complete snapshot</button>
                </form>
              </div>
            ) : null}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Employee</th><th>Status</th><th>Dates</th><th>Legal entity</th><th>CRM match</th><th /></tr></thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.entryId}>
                      <td><strong>{row.displayName}</strong>{row.dependentRowCount > 0 ? <small>{row.dependentRowCount} dependent row{row.dependentRowCount === 1 ? "" : "s"} excluded</small> : null}</td>
                      <td><Pill tone={row.employmentState === "ACTIVE" ? "green" : "gray"}>{row.employmentState === "ACTIVE" ? "Employee" : "Former employee"}</Pill></td>
                      <td><small>Start {formatDate(row.startDate)}<br />Last day {formatDate(row.lastDay)}</small></td>
                      <td>{row.legalEntity ?? "—"}</td>
                      <td>{row.confirmedClientName ? <><strong>{row.confirmedClientName}</strong><small>Confirmed</small></> : <><span>Not confirmed</span>{row.rejectedCount > 0 ? <small>{row.rejectedCount} rejected suggestion{row.rejectedCount === 1 ? "" : "s"}</small> : null}</>}</td>
                      <td><Link className={styles.reviewLink} href={`/crm/employees?upload=${encodeURIComponent(data.selectedUpload!.id)}&entry=${encodeURIComponent(row.entryId)}#match-review`}>{row.confirmedClientName ? "Change" : "Review"} →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {selectedEmployee && data.selectedUpload ? (
        <Card className={styles.card} id="match-review">
          <CardHeader>
            <h2>3. Match {selectedEmployee.displayName}</h2>
            <p className={styles.hint}>Choose the correct CRM contact. A name match never confirms itself.</p>
          </CardHeader>
          <CardBody>
            <EmployeeMatchReview
              uploadId={data.selectedUpload.id}
              entryId={selectedEmployee.entryId}
              employeeName={selectedEmployee.displayName}
              initialState={{
                query: selectedEmployee.displayName,
                ...initialSearch,
                error: null,
              }}
            />
          </CardBody>
        </Card>
      ) : null}

      {data.uploads.length > 0 ? (
        <Card className={styles.card}>
          <CardHeader><h2>Recent snapshots</h2></CardHeader>
          <CardBody><div className={styles.history}>{data.uploads.map((upload) => (
            <Link key={upload.id} href={`/crm/employees?upload=${encodeURIComponent(upload.id)}`}>
              <span>{formatDate(upload.effectiveDate)} · {upload.employeeCount} employees</span>
              <Pill tone={upload.status === "APPLIED" ? "green" : upload.status === "DRAFT" ? "amber" : "gray"}>{upload.status.toLowerCase()}</Pill>
            </Link>
          ))}</div></CardBody>
        </Card>
      ) : null}
    </>
  );
}
