"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { btnClass, cx, type BtnStyle } from "./ui";

/**
 * The mockup's modal: a native <dialog> opened from a trigger button. Content
 * mounts only while open, so required fields in a closed dialog never block
 * the browser from validating another form on the page.
 */
export function WorkspaceDialog({ title, trigger, triggerStyle, triggerDisabled, triggerTitle, className, context, children, openOnMount = false }: {
  title: string;
  trigger: ReactNode;
  triggerStyle?: BtnStyle;
  triggerDisabled?: boolean;
  triggerTitle?: string;
  className?: string;
  context?: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  openOnMount?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => ref.current?.close();
  useEffect(() => {
    if (openOnMount && !ref.current?.open) { ref.current?.showModal(); setOpen(true); }
  }, [openOnMount]);
  return (
    <>
      <button type="button" className={btnClass(triggerStyle)} disabled={triggerDisabled} title={triggerTitle}
        onClick={() => { ref.current?.showModal(); setOpen(true); }}>{trigger}</button>
      <dialog ref={ref} className={cx(className)} onClose={() => setOpen(false)} aria-label={title}>
        <div className="row between"><h2>{title}</h2><button type="button" className="btn quiet" aria-label="Close dialog" onClick={close}>✕</button></div>
        {context}
        {open || openOnMount ? (typeof children === "function" ? children(close) : children) : null}
      </dialog>
    </>
  );
}

/** The mockup's "client · value / source → destination" strip at the top of a form dialog. */
export function FormTransferContext({ title, detail }: { title: ReactNode; detail: ReactNode }) {
  return <div className="form-transfer-context" aria-label="Current transfer"><strong>{title}</strong><span>{detail}</span></div>;
}
