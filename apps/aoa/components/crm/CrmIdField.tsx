"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { CrmExplorerLink } from "./CrmExplorerLink";
import styles from "./CrmIdField.module.css";

export const CRM_ID_MASK = "••••••••";

export function CrmIdField({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.row}>
      <span className={styles.label}>
        CRM ID:{" "}
        <code className={styles.value}>{shown ? value : CRM_ID_MASK}</code>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShown((current) => !current)}
        aria-label={shown ? "Hide CRM ID" : "Show CRM ID"}
      >
        {shown ? "Hide" : "Show"}
      </Button>
      <Button variant="ghost" size="sm" onClick={copyId} aria-label="Copy CRM ID">
        {copied ? "Copied" : "Copy"}
      </Button>
      <CrmExplorerLink className={styles.link} href={`/crm/${encodeURIComponent(value)}`}>
        Open in Explorer →
      </CrmExplorerLink>
    </div>
  );
}
