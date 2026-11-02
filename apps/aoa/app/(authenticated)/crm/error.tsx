"use client";

import { useEffect } from "react";
import { Card, CardBody, CardHeader, Pill, SectionLabel } from "@/components/ui";
import styles from "./page.module.css";

export default function CrmExplorerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep database error details and source identifiers out of the browser
    // console. The opaque Next.js digest is enough to correlate server logs.
    console.error("CRM Explorer request unavailable", { digest: error.digest ?? "none" });
  }, [error.digest]);

  return (
    <>
      <SectionLabel>Admin · CRM relationship layer</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1>CRM Explorer</h1>
          <p className={styles.intro}>
            The CRM registry did not respond in time. No data was changed.
          </p>
        </div>
        <Pill tone="amber" dot>Temporarily unavailable</Pill>
      </div>
      <Card className={styles.explorerCard}>
        <CardHeader>
          <h2>Try the registry again</h2>
        </CardHeader>
        <CardBody>
          <p className={styles.emptyText}>
            A background CRM refresh may be finishing. Retry now; if it remains unavailable,
            Operations can check the sanitized CRM timing log.
          </p>
          <button type="button" className="btn" onClick={reset}>
            Retry CRM Explorer
          </button>
        </CardBody>
      </Card>
    </>
  );
}
