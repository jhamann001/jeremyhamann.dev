"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./DealModal.module.css";
import { safeListHref } from "@/lib/navigation/list-routes";

// Dialog shell for the deal detail/create modal. Search-param driven
// (/deals?deal=<id> or /deals?new=1) — rendered conditionally by the /deals
// page itself. This REPLACED the @modal/(.)[id] intercepting route
// (2026-07-02): the interceptor's chunk path (@, parens, brackets) was
// un-servable on the Cloud Run front-end (404 on its own build's chunk —
// while [id] and (authenticated) chunk paths serve fine, and the identical
// standalone build serves the @modal chunk locally). Same-route search-param
// navigation ships NO extra route chunk, so there is nothing left to 404.
// Native <dialog> + showModal() supplies focus containment and Esc.
//
// The searchParams guard renders null once the URL no longer carries the
// modal param (e.g. after a server action's redirect("/deals")) — the modal
// is self-dismissing on any nav away.

export function DealModal({ children, fallbackHref = "/deals" }: { children: ReactNode; fallbackHref?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ref = useRef<HTMLDialogElement>(null);

  // push (not back): safe even when /deals?deal=x was opened directly in a
  // fresh tab, where back() would leave the app.
  const close = useCallback(() => router.push(safeListHref(fallbackHref) ?? "/deals", { scroll: false }), [router, fallbackHref]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Post-save redirect("/deals") (or any nav away) → dismiss.
  const wantsModal =
    searchParams.get("deal") != null || searchParams.get("new") != null;
  if (!wantsModal) return null;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label="Deal details"
      onCancel={(e) => {
        // Esc: route back instead of just hiding the dialog.
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        // Backdrop click: the dialog element itself is the target only when
        // the click lands outside the panel content.
        if (e.target === ref.current) close();
      }}
    >
      <div className={styles.panel}>
        <button
          type="button"
          className={styles.close}
          onClick={close}
          aria-label="Close deal details"
        >
          ×
        </button>
        {children}
      </div>
    </dialog>
  );
}
