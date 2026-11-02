import Link from "next/link";
import { Card, CardBody, Pill } from "@/components/ui";
import type { ApexAccount } from "@/lib/data/types";
import { getEligibleFormDefinitions } from "@/lib/forms/registry";
import styles from "./FormLibraryCard.module.css";

export function FormLibraryCard({ clientId, accounts }: { clientId: string; accounts: ApexAccount[] }) {
  const eligibleForms = getEligibleFormDefinitions(
    accounts
      .filter((account) => account.id?.trim() && account.apexAccountNumber?.trim())
      .map((account) => account.type),
  );

  return (
    <Card role="region" aria-labelledby="form-library-heading">
      <details key={clientId} className={styles.disclosure}>
        <summary className={styles.summary}>
          <h2 id="form-library-heading">Form Library</h2>
          <Pill tone="gold" dot>
            Internal Pilot
          </Pill>
          <span className={styles.headerMeta}>
            <span className={styles.count}>
              {eligibleForms.length > 0
                ? `${eligibleForms.length} ${eligibleForms.length === 1 ? "Form" : "Forms"} Available`
                : "No Eligible Forms"}
            </span>
            <span className={styles.chevron} aria-hidden="true">›</span>
          </span>
        </summary>
        <CardBody>
          <p className={styles.intro}>Choose a form and enter the details you know. Leave the rest for completion.</p>
          {eligibleForms.length === 0 ? (
            <p className={styles.empty}>
              No accounts with a confirmed Apex account number available. Select or link an account before preparing a form.
            </p>
          ) : null}
          <div className={styles.grid} data-testid="form-library-grid">
            {eligibleForms.map((definition) => (
              <article className={styles.entry} key={definition.id} aria-labelledby={`form-title-${definition.id}`}>
                <h3 className={styles.title} id={`form-title-${definition.id}`}>{definition.name}</h3>
                <p className={styles.copy}>{definition.summary}</p>
                <Link
                  className={styles.action}
                  aria-label={`Prepare Form: ${definition.name}`}
                  href={`/client-portrait/${encodeURIComponent(clientId)}/forms/${definition.entryPathSegment}`}
                >
                  {definition.callToAction}
                  <span aria-hidden="true">→</span>
                </Link>
              </article>
            ))}
          </div>
          <p className={styles.meta}>
            Review and complete all required information before sending. Forms are not signed or submitted automatically.
          </p>
        </CardBody>
      </details>
    </Card>
  );
}
