"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import styles from "@/app/(authenticated)/operations/fee-requests/page.module.css";

export function FeeRequestIntakePanel({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const panelId = useId();
  return <section className={styles.intakeDisclosure} aria-label="New request intake">
    <button type="button" className={styles.newRequestButton} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
      {open ? "Close new request form" : "+ New request"}
    </button>
    {/* Keep the form mounted so a temporary collapse retains its fields and submission key. */}
    <div id={panelId} hidden={!open}>{children}</div>
  </section>;
}
