"use client";

import { useCallback, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { AcatRecord } from "@/lib/types";
import AcatDetail from "./AcatDetail";

interface AcatDetailDrawerProps {
  record: AcatRecord | null;
  orderedIds: string[];
  open: boolean;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onMutate?: () => void;
}

export default function AcatDetailDrawer({
  record,
  orderedIds,
  open,
  onClose,
  onNavigate,
  onMutate,
}: AcatDetailDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Freeze body scroll while open
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  // Move focus into the panel when it opens, restore when it closes
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const el = panelRef.current;
    if (el) {
      const focusTarget = el.querySelector<HTMLElement>(
        "[data-autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
      );
      (focusTarget ?? el).focus();
    }
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const navigate = useCallback(
    (offset: -1 | 1) => {
      if (!record) return;
      const idx = orderedIds.indexOf(record.id);
      if (idx === -1) return;
      const nextIdx = idx + offset;
      if (nextIdx < 0 || nextIdx >= orderedIds.length) return;
      onNavigate(orderedIds[nextIdx]);
    },
    [record, orderedIds, onNavigate]
  );

  // Keyboard: Esc closes, ←/→ navigates
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // The nested client dialog owns Escape and its own focus cycle.
      // Check the event target even if React has already unmounted the dialog.
      if (target?.closest?.("[data-client-identity-dialog]")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isTyping) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigate(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigate(-1);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, navigate]);

  if (!open) return null;

  const idx = record ? orderedIds.indexOf(record.id) : -1;
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < orderedIds.length - 1;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div
        data-testid="drawer-backdrop"
        className="absolute inset-0 bg-[var(--panel-backdrop)] backdrop-blur-[1px] animate-fade-in"
        onPointerDown={onClose}
      />
      <div
        ref={panelRef}
        role="document"
        tabIndex={-1}
        className="absolute right-0 top-0 h-full w-[min(100vw,max(52vw,860px))] bg-[var(--bg-card)] shadow-2xl outline-none animate-drawer-in flex flex-col"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-card-border bg-[var(--bg-card)] px-3 py-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            disabled={!canPrev}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous record (←)"
            aria-label="Previous record"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => navigate(1)}
            disabled={!canNext}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next record (→)"
            aria-label="Next record"
          >
            <ChevronRight size={15} />
          </button>
          {record && orderedIds.length > 0 && idx !== -1 && (
            <span className="text-[11px] text-muted">
              {idx + 1} of {orderedIds.length}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            data-autofocus
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {record ? (
            <AcatDetail
              acat={record}
              onMutate={onMutate}
              onDeleted={() => {
                onMutate?.();
                onClose();
              }}
              layout="drawer"
              key={record.id}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Record not found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
