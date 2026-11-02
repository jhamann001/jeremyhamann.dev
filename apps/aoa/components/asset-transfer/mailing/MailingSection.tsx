import type { Identity } from "@/lib/rls";
import { getMailingReport } from "@/lib/transfers/mailing";
import { FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { trackingDate } from "@/components/asset-transfer/detail/detail-model";
import { mailingStatusTone } from "./MailingReportRows";
import { EditMailingDialog, MailingDialog } from "./MailingForm";

/** ATW-05 mailing & delivery on the movement detail (AC-41, AC-45). */
export async function MailingSection({
  identity,
  transferId,
  canRecord,
  transferContext,
  bare = false,
}: {
  identity: Identity;
  transferId: string;
  canRecord: boolean;
  transferContext?: { title: string; detail: string };
  bare?: boolean;
}) {
  const mailings = await getMailingReport(identity, transferId);
  const context = transferContext ? <FormTransferContext title={transferContext.title} detail={transferContext.detail} /> : undefined;
  const section = (
    <section className="mailing-section" id="mailing-delivery" aria-label="Mailing & delivery">
      <div className="mailing-section-heading">
        <div>
          <span className="kicker">Paperwork & check delivery</span>
          <h3>Mailing & delivery</h3>
          <p className="small">Contents, tracking and postage stay with this client&rsquo;s transfer.</p>
        </div>
        {canRecord && <div className="row"><MailingDialog transferId={transferId} context={context} /></div>}
      </div>
      {mailings.length === 0 ? (
        <p className="small mailing-empty">No mailings recorded for this transfer.</p>
      ) : (
        mailings.map((mailing) => (
          <article key={mailing.id} className="mailing-record" id={`mailing-record-${mailing.id}`} data-mailing-id={mailing.id}>
            <header className="mailing-record-heading">
              <div>
                <strong>{mailing.reason}</strong>
                <span className={`badge ${mailingStatusTone(mailing)}`.trim()}>{mailing.status}</span>
                <p className="small">{mailing.contents} · {mailing.journey}</p>
              </div>
              {canRecord && (
                <EditMailingDialog transferId={transferId} mailingId={mailing.id} context={context}
                  legs={mailing.legs.map((leg) => ({
                    number: leg.number, label: leg.label, from: leg.from,
                    carrier: leg.carrier ?? "", trackingNumber: leg.trackingNumber ?? "",
                    mailedOn: leg.mailedOn ?? "", receivedOn: leg.receivedOn ?? "",
                  }))} />
              )}
            </header>
            <div className="mailing-journey">
              {mailing.legs.map((leg) => (
                <div key={leg.number} className="mailing-leg">
                  <div className="mailing-leg-heading">
                    <span className="mailing-leg-number">{leg.number}</span>
                    <strong>{leg.label}</strong>
                  </div>
                  <p className="small">{leg.carrier ?? "Carrier not recorded"}{leg.trackingNumber ? ` · Tracking ${leg.trackingNumber}` : ""}</p>
                  <dl>
                    <div><dt>Mailed</dt><dd>{leg.mailedOn ? trackingDate(leg.mailedOn) : "Not recorded"}</dd></div>
                    <div><dt>Received</dt><dd>{leg.receivedOn ? trackingDate(leg.receivedOn) : "Not recorded"}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
            <div className="mailing-record-footer">
              <strong>{mailing.postage ? `Postage ${mailing.postage}` : "Postage not recorded"}</strong>
              <p className="small">Recorded {mailing.recordedAt}</p>
            </div>
          </article>
        ))
      )}
      <p className="small mailing-evidence-note">
        Delivery is tracked here. Record returned signatures and receipt of assets in their separate steps.
      </p>
    </section>
  );
  return bare ? section : <div className="sectionbody">{section}</div>;
}
