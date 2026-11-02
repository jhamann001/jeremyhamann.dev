"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/components/ui";
import { useSessionMessages } from "@/components/trade-requests/bell/session-messages";
import { runTradeRequestExport } from "@/components/trade-requests/export/run-export";
import { EXPORT_COPY, type ExportFormat } from "@/lib/trade-requests/export-model";
import type { TradeRequestExporter } from "@/lib/trade-requests/request-types";
import styles from "./ExportAction.module.css";

const ITEMS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: "pdf", label: EXPORT_COPY.pdf, hint: EXPORT_COPY.pdfHint },
  { format: "csv", label: EXPORT_COPY.csv, hint: EXPORT_COPY.csvHint },
];

/** "Export Compliance Log": the whole firm's requests as a PDF report or a CSV, whatever the queue shows. */
export function QueueExportAction({ exporter }: { exporter: TradeRequestExporter }) {
  const { add } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const closeToButton = useCallback(() => {
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeToButton();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closeToButton]);

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === "ArrowDown" ? (current + 1) % list.length
      : event.key === "ArrowUp" ? (current - 1 + list.length) % list.length
        : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : null;
    if (target !== null) {
      event.preventDefault();
      list[target]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const exportAs = useCallback(async (format: ExportFormat) => {
    setOpen(false);
    setRunning(true);
    try {
      await runTradeRequestExport(format, exporter, add);
    } finally {
      setRunning(false);
    }
  }, [add, exporter]);

  return (
    <div className={styles.export} ref={ref}>
      <Button
        variant="ghost"
        onClick={() => setOpen((current) => !current)}
        disabled={running}
        aria-haspopup="menu"
        aria-expanded={open && !running}
        aria-controls={open && !running ? menuId : undefined}
      >
        {running ? EXPORT_COPY.preparing : EXPORT_COPY.button}
        {running ? null : <span aria-hidden="true" className={open ? styles.chevronOpen : styles.chevron}>▾</span>}
      </Button>
      {open && !running ? (
        <div role="menu" id={menuId} ref={menuRef} className={styles.menu} onKeyDown={onMenuKey}>
          {ITEMS.map((item) => (
            <button key={item.format} type="button" role="menuitem" tabIndex={-1} className={styles.item} onClick={() => void exportAs(item.format)}>
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
