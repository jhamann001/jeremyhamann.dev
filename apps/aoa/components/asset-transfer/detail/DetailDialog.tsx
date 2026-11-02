"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** A controlled mockup modal for dialogs opened from non-button triggers (task rows). */
export function DetailDialog({ title, open, onClose, className, children }: {
  title: string; open: boolean; onClose: () => void; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className={className} onClose={onClose} aria-label={title}>
      <div className="row between"><h2>{title}</h2><button type="button" className="btn quiet" aria-label="Close dialog" onClick={onClose}>✕</button></div>
      {open ? children : null}
    </dialog>
  );
}
