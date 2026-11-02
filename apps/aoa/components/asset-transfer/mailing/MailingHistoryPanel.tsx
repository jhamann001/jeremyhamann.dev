import type { Identity } from "@/lib/rls";
import { getMailingReport, mailingReportCsv } from "@/lib/transfers/mailing";
import { trackingDate } from "@/components/asset-transfer/detail/detail-model";
import { WorkflowSection } from "@/components/asset-transfer/workspace/ui";
import { mailingStatusTone } from "./MailingReportRows";

/** Every mailing saved on one transfer, leg by leg; the cross-transfer report stays on the Asset Transfer tab. */
export async function MailingHistoryPanel({ identity, transferId }: { identity: Identity; transferId: string }) {
  const rows = await getMailingReport(identity, transferId);
  const legs = rows.reduce((sum, row) => sum + row.legs.length, 0);
  const status: ["completed" | "waiting" | "neutral", string] = rows.length === 0
    ? ["neutral", "No mailings"]
    : rows.every(row => mailingStatusTone(row) === "completed") ? ["completed", `${rows.length} delivered`] : ["waiting", `${rows.length} recorded`];
  return (
    <WorkflowSection id="mailing-history" title="Mailing history" related status={status} open={false}
      description="Every envelope recorded for this transfer, with each leg's carrier, tracking and dates.">
      <div className="sectionbody mailing-report">
        {rows.length === 0 ? <p className="small">No mailings recorded for this transfer.</p> : <>
          <div className="row between mailing-report-actions">
            <p className="small">{legs} mailing leg{legs === 1 ? "" : "s"}</p>
            <a className="btn tiny" href={`data:text/csv;charset=utf-8,${encodeURIComponent(mailingReportCsv(rows))}`} download="transfer-mailing-history.csv">Download CSV</a>
          </div>
          <div className="tablewrap">
            <table className="mailing-report-table">
              <thead><tr><th>Reason / contents</th><th>Mailing leg</th><th>Journey status</th><th>Dates</th><th>Postage</th></tr></thead>
              <tbody>
                {rows.flatMap(row => row.legs.map((leg, index) => (
                  <tr key={`${row.id}:${leg.number}`} data-mailing-id={row.id}>
                    <td><strong>{row.reason}</strong><small>{row.contents}</small></td>
                    <td><strong>{leg.label}</strong><small>{leg.carrier ?? "Carrier not recorded"}</small>
                      <small>{leg.trackingNumber ? `Tracking ${leg.trackingNumber}` : "Tracking not recorded"}</small></td>
                    <td><span className={`badge ${mailingStatusTone(row)}`.trim()}>{row.status}</span></td>
                    <td><small>Mailed {leg.mailedOn ? trackingDate(leg.mailedOn) : "Not recorded"}</small>
                      <small>Received {leg.receivedOn ? trackingDate(leg.receivedOn) : "Not recorded"}</small></td>
                    <td>{index === 0 ? row.postage || "—" : "—"}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </>}
      </div>
    </WorkflowSection>
  );
}
