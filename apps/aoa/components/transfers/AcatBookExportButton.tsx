"use client";

import { useState } from "react";
import { acatBookCsvFilename, buildAcatBookCsv } from "@/lib/data/acat-book-export";
import { ACAT_EXPORT_FAILURE } from "@/lib/data/acat-drawer-contract";
import type { AcatBookRow } from "@/lib/data/acat-book";
import styles from "./AcatBookView.module.css";

export function AcatBookExportButton({ rows, columns, tracker, linkedFor }: {
  rows: readonly AcatBookRow[];
  columns: ReadonlyArray<{ id: string; label: string }>;
  tracker: boolean;
  linkedFor: (row: AcatBookRow) => boolean;
}) {
  const [failed, setFailed] = useState(false);

  function download() {
    try {
      const csv = buildAcatBookCsv({ rows, columns, tracker, linkedFor });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = acatBookCsvFilename(new Date());
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <button type="button" className={styles.action} title="Export current view as CSV" onClick={download}>
        Export CSV
      </button>
      {failed && (
        <p role="alert" className={styles.empty}>
          {ACAT_EXPORT_FAILURE}{" "}
          <button type="button" className={styles.action} onClick={download}>Retry</button>
        </p>
      )}
    </>
  );
}
