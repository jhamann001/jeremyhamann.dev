import type { DealRow, DealStage } from "@/lib/data/deal-types";
import { stageLabel, MASKED_CEDAR_RIDGE_ID } from "@/lib/data/deal-types";
import { FieldList, Pill, SectionLabel, type Field } from "@/components/ui";
import { usd } from "@/lib/format";
import { stageTone } from "./stage-tone";
import { dealToFormValues, type DealSuggestions } from "./deal-form";
import { DealForm } from "./DealForm";
import { DealArchiveButton } from "./DealArchiveButton";
import { CrmIdField } from "@/components/crm/CrmIdField";
import styles from "./DealDetail.module.css";

// Deal detail body, shared by the intercepted modal and the /deals/[id]
// full-page fallback (scope change, the owner 2026-07-01): header, the read-only
// provenance/meta strip (import-only fields are shown, never edited), then
// edit-in-place via the shared DealForm for write roles. VIEWER gets a
// read-only field list instead — no write affordance (and the DB write
// policies would reject a viewer write regardless, ADR-4).
// Plaid is deliberately absent everywhere (scope change #2). D6 (WO ticket):
// sf_deal_id, owner, and secondary owner are stored in the DB but hidden from
// ALL /deals UI — no meta row, no read-only field, no form input.
// D7 (WO ticket): write roles additionally get the Delete (soft-archive)
// affordance under the form; an ARCHIVED deal (deep link / Removed-view click)
// renders a labeled read-only "Removed" state for EVERYONE — no edit form, no
// delete button; restore lives on the gated Removed view only.

const EM_DASH = "—";

const day = (d: Date | null) =>
  d == null
    ? EM_DASH
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });

// Stage-history timestamps are real instants (ISO strings from the actions),
// so local-time rendering is correct here — unlike the UTC-midnight `date`
// columns above.
const at = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

// stage_history entries carry enum stages; render the label (tolerate unknown
// strings from hand-edited data rather than crashing the modal).
const label = (s: string) =>
  (["POTENTIAL", "COMMITTED", "FUNDING", "WON", "LOST"] as const).includes(
    s as DealStage,
  )
    ? stageLabel(s as DealStage)
    : s;

export function DealDetail({
  deal,
  canWrite,
  canViewCedarRidge,
  crmId,
  suggestions,
}: {
  deal: DealRow;
  canWrite: boolean;
  /** ADMIN/OPERATIONS see the real cedar_ridge_user_id; others get the mask. */
  canViewCedarRidge: boolean;
  crmId?: string | null;
  /** D8 typeahead datalists for the edit form (from the page's fetched rows). */
  suggestions?: DealSuggestions;
}) {
  const archived = deal.archived_at != null;
  const meta: Field[] = [
    { label: "Source", value: deal.source === "APP" ? "Entered in AOA" : "Imported" },
    { label: "Created", value: `${day(deal.created_date)} · ${deal.created_by ?? "import"}` },
    { label: "Last updated", value: `${day(deal.updated_at)} · ${deal.updated_by ?? "import"}` },
  ];
  if (deal.stage_raw != null)
    meta.push({ label: "CRM stage (raw)", value: deal.stage_raw });
  if (deal.person_aum != null)
    meta.push({ label: "Person AUM", value: usd(deal.person_aum) });
  if (deal.potential_aum != null)
    meta.push({ label: "Potential AUM", value: usd(deal.potential_aum) });
  if (deal.last_activity_date != null)
    meta.push({ label: "Last activity", value: day(deal.last_activity_date) });

  const readonlyFields: Field[] = [
    { label: "Client", value: `${deal.client_first_name} ${deal.client_last_name}` },
    { label: "Household", value: deal.household_name ?? EM_DASH },
    { label: "Amount", value: usd(deal.amount) },
    { label: "Expected close", value: day(deal.close_date) },
    {
      label: "Cedar Ridge user id",
      value: canViewCedarRidge
        ? (deal.cedar_ridge_user_id ?? EM_DASH)
        : deal.cedar_ridge_user_id_masked
          ? MASKED_CEDAR_RIDGE_ID
          : EM_DASH,
    },
    { label: "Account type", value: deal.account_type ?? EM_DASH },
    { label: "Account last 4", value: deal.account_last4 ?? EM_DASH },
    { label: "Transferring firm", value: deal.transferring_firm ?? EM_DASH },
    { label: "Statements on file", value: deal.statements ? "Yes" : "No" },
  ];
  // 401(k)-Rollover companions (D8) — shown only when present.
  if (deal.employer != null)
    readonlyFields.splice(7, 0, { label: "Employer", value: deal.employer });
  if (deal.rolling_into != null)
    readonlyFields.splice(deal.employer != null ? 8 : 7, 0, {
      label: "Rolling into",
      value: deal.rolling_into,
    });

  // D8: stage timeline, newest first.
  const history = [...deal.stage_history].reverse();

  return (
    <div className={styles.detail}>
      <div>
        <SectionLabel>Deal</SectionLabel>
        <div className={styles.head}>
          <h2 className={styles.name}>{deal.name}</h2>
          <Pill tone={stageTone(deal.stage)} dot>
            {stageLabel(deal.stage)}
          </Pill>
          {archived && <Pill tone="gray">Removed</Pill>}
          <span className={styles.amount}>{usd(deal.amount)}</span>
        </div>
        {crmId ? <CrmIdField value={crmId} /> : null}
      </div>

      {archived && (
        <p className={styles.archivedNote}>
          Removed from the pipeline {day(deal.archived_at)}
          {deal.archived_by ? ` by ${deal.archived_by}` : ""}
          {deal.archived_reason ? ` — ${deal.archived_reason}` : ""} — kept in
          the audit history. An admin can restore it from the Removed view.
        </p>
      )}

      <div className={styles.meta}>
        <FieldList items={meta} />
      </div>

      {canWrite && !archived ? (
        <>
          <DealForm
            mode="edit"
            dealId={deal.id}
            initialValues={dealToFormValues(deal)}
            suggestions={suggestions}
            canViewCedarRidge={canViewCedarRidge}
            cedarRidgeMasked={deal.cedar_ridge_user_id_masked}
          />
          {/* D7: Delete = soft archive (confirm inside; write roles only —
              and the RLS write policy enforces regardless). */}
          <DealArchiveButton dealId={deal.id} />
        </>
      ) : (
        <FieldList items={readonlyFields} />
      )}

      {/* D8 (WO ticket): stage timeline, newest first — written by the
          server actions in the same transaction as every stage change. */}
      <div>
        <SectionLabel>Stage history</SectionLabel>
        {deal.lost_from != null && (
          <p className={styles.lostCallout}>
            Marked <b>Lost</b> from the <b>{label(deal.lost_from)}</b> stage —
            captured for win/loss reporting.
          </p>
        )}
        {history.length === 0 ? (
          <p className={styles.histEmpty}>No stage changes recorded yet.</p>
        ) : (
          <ol className={styles.hist}>
            {history.map((h, i) => (
              <li key={`${h.at}:${i}`} className={styles.histRow}>
                <div className={styles.histLeft}>
                  <span className={styles.histStage}>
                    {label(h.stage)}
                    <span className={styles.histFrom}>
                      {h.from ? ` · from ${label(h.from)}` : " · created"}
                    </span>
                  </span>
                  <span className={styles.histBy}>by {h.by ?? EM_DASH}</span>
                </div>
                <span className={styles.histAt}>{at(h.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
