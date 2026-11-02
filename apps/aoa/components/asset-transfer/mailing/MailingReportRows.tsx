import Link from "next/link";
import type { Identity } from "@/lib/rls";
import { getMailingReport, mailingReportCsv, type MailingReportRow } from "@/lib/transfers/mailing";
import { trackingDate } from "@/components/asset-transfer/detail/detail-model";
import { WorkspaceRecordLink } from "@/components/asset-transfer/views/WorkspaceRecordLink";

/** Per-transfer context the report row shows beside the saved mailing. */
export type MailingTransferContext = { dealRef: string | null };

const NOT_RECORDED = "—";

export function mailingStatusTone(row: Pick<MailingReportRow, "legs" | "status">): "completed" | "waiting" | "" {
  if (row.legs.at(-1)?.receivedOn) return "completed";
  return row.status === "Not yet mailed" ? "" : "waiting";
}

/**
 * AC-43..AC-45 rows: one table row per journey leg of each saved mailing,
 * each linking to its movement. A mailing's postage is shown on its first leg.
 */
export function MailingReportTable({ rows, transfers, clearHref = "/reporting/mailing", scope, listHref }: {
  rows: MailingReportRow[]; transfers?: ReadonlyMap<string, MailingTransferContext>; clearHref?: string;
  scope?: string; listHref?: string;
}) {
  const legs = rows.reduce((sum, row) => sum + row.legs.length, 0);
  const csv = mailingReportCsv(rows);
  return <>
    <div className="row between mailing-report-actions">
      <p className="small">{legs} mailing leg{legs === 1 ? "" : "s"} shown</p>
      <div className="row">
        <a className="btn tiny" href={clearHref}>Clear filters</a>
        <a className="btn" href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`} download="FedEx-manual-mailers.csv">Download CSV</a>
      </div>
    </div>
    <div className="tablewrap">
      <table className="mailing-report-table">
        <thead>
          <tr><th>Client / transfer</th><th>Reason / contents</th><th>Mailing leg</th><th>Journey status</th><th>Dates</th><th>Postage</th></tr>
        </thead>
        <tbody>
          {rows.length ? rows.flatMap(row => row.legs.map((leg, index) => (
            <tr key={`${row.id}:${leg.number}`} data-mailing-id={row.id}>
              <td>
                <strong>{row.client}</strong>
                <small>{row.sourceAccount || "Source account not recorded"}</small>
                <small>Receiving account {row.receivingAccount || "not recorded"}</small>
                <small>{transfers?.get(row.transferId)?.dealRef ?? "No deal linked"}</small>
                {scope && listHref
                  ? <WorkspaceRecordLink scope={scope} listHref={listHref} transferId={row.transferId} from="mailing" className="text-button">View transfer →</WorkspaceRecordLink>
                  : <Link href={`${row.href}?from=mailing`} prefetch={false} className="text-button">View transfer →</Link>}
              </td>
              <td><strong>{row.reason}</strong><small>{row.contents}</small></td>
              <td><strong>{leg.label}</strong><small>{leg.carrier ?? "Carrier not recorded"}</small>
                <small>{leg.trackingNumber ? `Tracking ${leg.trackingNumber}` : "Tracking not recorded"}</small></td>
              <td><span className={`badge ${mailingStatusTone(row)}`.trim()}>{row.status}</span></td>
              <td><small>Mailed {leg.mailedOn ? trackingDate(leg.mailedOn) : "Not recorded"}</small>
                <small>Received {leg.receivedOn ? trackingDate(leg.receivedOn) : "Not recorded"}</small></td>
              <td>{index === 0 ? row.postage || NOT_RECORDED : NOT_RECORDED}</td>
            </tr>
          ))) : <tr><td colSpan={6}>No mailings match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  </>;
}

export async function MailingReportRows({ identity }: { identity: Identity }) {
  const rows = await getMailingReport(identity);
  return <MailingReportTable rows={rows} />;
}
