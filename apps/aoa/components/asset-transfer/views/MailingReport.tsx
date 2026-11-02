import { mailingFilterDay, type MailingReportRow } from "@/lib/transfers/mailing";
import {
  MAILING_CARRIER_FILTERS, MAILING_STATUS_FILTERS, type MailingCarrierFilter, type MailingStatusFilter,
} from "@/lib/navigation/transfer-query";
import type { WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { MailingReportTable } from "@/components/asset-transfer/mailing/MailingReportRows";
import { FilterForm, SubmitOnChangeInput, SubmitOnChangeSelect } from "./FilterForm";
import { viewHref } from "./view-helpers";

export type MailingFilters = {
  query: string; from: string; through: string; status?: MailingStatusFilter | null; carrier?: MailingCarrierFilter | null;
};

const STATUS_LABEL: Record<MailingStatusFilter, string> = {
  "in-transit": "In transit",
  received: "Received",
  "not-mailed": "Not yet mailed",
};

function matchesStatus(row: MailingReportRow, status: MailingStatusFilter): boolean {
  switch (status) {
    case "in-transit": return row.status.startsWith("In transit");
    case "received": return row.status.startsWith("Received") || row.status.startsWith("Returned");
    case "not-mailed": return row.status === "Not yet mailed";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/**
 * Search (including carrier and tracking), journey status, carrier, then the
 * date range (inclusive) on the mailed date, or the received date when the
 * mailed date is unknown. ISO days compare as text.
 */
export function filterMailings(rows: readonly MailingReportRow[], filters: MailingFilters): MailingReportRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter(row => {
    const text = [row.client, row.sourceAccount, row.receivingAccount, row.reason, row.contents, row.journey,
      ...row.legs.flatMap(leg => [leg.carrier ?? "", leg.trackingNumber ?? ""])].join(" ").toLowerCase();
    const day = mailingFilterDay(row);
    return (!needle || text.includes(needle)) &&
      (!filters.status || matchesStatus(row, filters.status)) &&
      (!filters.carrier || row.legs.some(leg => leg.carrier === filters.carrier)) &&
      (!filters.from || day >= filters.from) && (!filters.through || day <= filters.through);
  });
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function postageCents(postage: string): number | null {
  const amount = Number(postage.replace(/^\$/, ""));
  return postage && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** FedEx and manual mailers across transfers: ATW-05's saved mailings. */
export function MailingReport({ rows, transfers, filters, scope, listHref }: {
  rows: MailingReportRow[]; transfers: WorkspaceTransfer[]; filters: MailingFilters; scope?: string; listHref?: string;
}) {
  const shown = filterMailings(rows, filters);
  const cents = shown.reduce((sum, row) => sum + (postageCents(row.postage) ?? 0), 0);
  const withoutCost = shown.filter(row => postageCents(row.postage) === null).length;
  const context = new Map(transfers.map(transfer => [transfer.id, { dealRef: transfer.dealRef }]));
  return (
    <div className="mailing-report">
      <header className="workspace-page-heading">
        <div><span className="kicker">All transfer mailings</span><h1>FedEx &amp; manual mailers</h1><p>Contents, tracking and postage across client transfers.</p></div>
      </header>
      <p className="small">This report uses the mailing records saved on each transfer.</p>
      <FilterForm className="mailing-report-filters" params={{ view: "mailing" }}>
        <label className="field"><span>Find a mailing</span>
          <input name="q" type="search" defaultValue={filters.query} placeholder="Client, account, reason, carrier or tracking…" />
        </label>
        <label className="field"><span>Journey status</span>
          <SubmitOnChangeSelect name="mailingStatus" defaultValue={filters.status ?? ""}>
            <option value="">All statuses</option>
            {MAILING_STATUS_FILTERS.map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
          </SubmitOnChangeSelect>
        </label>
        <label className="field"><span>Carrier</span>
          <SubmitOnChangeSelect name="carrier" defaultValue={filters.carrier ?? ""}>
            <option value="">All carriers</option>
            {MAILING_CARRIER_FILTERS.map(carrier => <option key={carrier} value={carrier}>{carrier}</option>)}
          </SubmitOnChangeSelect>
        </label>
        <label className="field"><span>Mailing date from</span><SubmitOnChangeInput name="mailedFrom" type="date" defaultValue={filters.from} /></label>
        <label className="field"><span>Mailing date through</span><SubmitOnChangeInput name="mailedThrough" type="date" defaultValue={filters.through} /></label>
      </FilterForm>
      <p className="small">Date filters use the mailed date, or the received date when mailing date is unknown.</p>
      <div className="mailing-report-summary">
        <div><span>Mailings</span><strong>{shown.length}</strong></div>
        <div><span>In transit</span><strong>{shown.filter(row => row.status.startsWith("In transit")).length}</strong></div>
        <div><span>Known postage</span><strong>{USD.format(cents / 100)}</strong><small>{withoutCost} mailing{withoutCost === 1 ? "" : "s"} without cost</small></div>
      </div>
      <MailingReportTable rows={shown} transfers={context} clearHref={viewHref({ view: "mailing" })} scope={scope} listHref={listHref} />
      <p className="small">A blank postage cost is unknown. Delivery does not establish a returned signature or receipt of assets.</p>
    </div>
  );
}
