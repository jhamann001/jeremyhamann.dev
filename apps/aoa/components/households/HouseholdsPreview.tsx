import Link from "next/link";
import type { HouseholdDirectoryPreviewRow } from "@/lib/data/households";
import { Card, CardHeader, SummaryGrid, StatTile, Table, THead, TBody, TR, TH, TD, Pill } from "@/components/ui";
import styles from "./HouseholdsTable.module.css";

/** An RLS-scoped first page while exact balances, counts and filters load. */
export function HouseholdsPreview({
  rows,
  unavailable = false,
}: {
  rows: HouseholdDirectoryPreviewRow[];
  unavailable?: boolean;
}) {
  return (
    <div data-households-preview="true">
      <SummaryGrid>
        {(["Clients", "Prospects", "Lost", "Total AUM"] as const).map((label) => (
          <StatTile key={label} label={label} value={unavailable ? "Unavailable" : "Loading…"} />
        ))}
      </SummaryGrid>
      <div style={{ marginTop: 24 }}>
        <Card>
          <CardHeader className={styles.toolbar}>
            <input className={styles.search} type="search" disabled
              placeholder="Search households or advisor…"
              aria-label="Search households (available when directory details load)" />
            <span role="status" style={{ color: "var(--muted)", fontSize: 13 }}>
              {unavailable ? "Directory details unavailable" : "Loading filters and balances…"}
            </span>
          </CardHeader>
          {rows.length === 0 ? (
            <p style={{ padding: 18, margin: 0 }}>
              {unavailable ? "No client households were returned; directory details are unavailable." : "Loading households…"}
            </p>
          ) : (
            <Table>
              <THead><TR><TH>Household</TH><TH>Members</TH><TH>Stage</TH><TH>Advisor</TH><TH style={{ textAlign: "right" }}>AUM</TH></TR></THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.sf_id}>
                    <TD><Link className={styles.rowLink} href={`/households/${row.sf_id}`} prefetch={false}>{row.name} <span aria-hidden="true">›</span></Link></TD>
                    <TD style={{ color: "var(--muted)" }}>—</TD>
                    <TD><Pill tone="green" dot>{row.stage ?? "—"}</Pill></TD>
                    <TD style={{ color: "var(--muted)" }}>{row.advisor_name ?? row.lead_advisor_email}</TD>
                    <TD style={{ textAlign: "right", color: "var(--muted)" }}>{unavailable ? "Unavailable" : "Loading…"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p style={{ padding: "0 18px 18px", margin: 0, color: "var(--muted)", fontSize: 13 }} role="status">
            {unavailable ? "Current totals and balances are unavailable."
              : `Showing the first ${rows.length} households; exact total loading…`}
          </p>
          {unavailable ? <form action="/households" method="get" style={{ padding: "0 18px 18px" }}>
            <button type="submit">Reload to retry</button>
          </form> : null}
        </Card>
      </div>
      {rows.length > 0 ? <script dangerouslySetInnerHTML={{ __html: `(() => {
        const preview = document.currentScript?.parentElement;
        if (!preview || preview.dataset.householdsPreview !== "true") return;
        const firstLink = preview.querySelector("tbody a");
        if (!firstLink) return;
        // Animation frames can run while React keeps a streamed segment hidden.
        // Stop measuring abandoned or persistently hidden previews.
        const deadline = performance.now() + 10000;
        let visibleLastFrame = false;
        const measure = () => {
          if (!preview.isConnected || !firstLink.isConnected || performance.now() >= deadline) return;
          const bounds = firstLink.getBoundingClientRect();
          const visible = document.visibilityState === "visible" && bounds.width > 0 && bounds.height > 0
            && getComputedStyle(firstLink).visibility === "visible";
          if (visible && visibleLastFrame) {
            preview.dataset.firstRowsRenderedMs = String(Math.round(performance.now()));
            return;
          }
          visibleLastFrame = visible;
          requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      })();` }} /> : null}
    </div>
  );
}
