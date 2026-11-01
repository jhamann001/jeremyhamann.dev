"use client";

import { cn } from "@/lib/utils";

/**
 * Clicks on these never activate the card: the element has its own action. Lifted from ticket-table.tsx
 * (S5 re-imports it) with `[data-card-action]` added for the MobileCardActions strip.
 */
export const INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[role=combobox],[role=option],[role=menuitem],[data-slot=select-trigger],[data-card-action]";

const TONE_CLASSES = {
  default: "",
  /** mirrors the table row tint; the destructive ring, never amber (INTERNAL_NOTE_CLASSES owns amber) */
  alarm: "ring-destructive/40 bg-destructive/[0.03]",
  muted: "text-muted-foreground",
} as const;

type DataAttrs = { [key: `data-${string}`]: string | undefined };

/**
 * Phone list card (decision D20). The body is a `role="button"` region that
 * activates on tap / Enter / Space; interactive controls (AssigneeSelect, Open link) live in `actions`,
 * OUTSIDE that region — that is what makes the card valid for screen readers and keeps a Select tap
 * from opening the preview.
 */
export function MobileCard({
  as = "li",
  label,
  onActivate,
  tone = "default",
  actions,
  className,
  children,
  ...dataAttrs
}: {
  as?: "li" | "div";
  /** accessible name of the tappable region, e.g. "Ticket HD-1042: Wire not received" */
  label: string;
  /** tap / Enter / Space on the body, outside INTERACTIVE_SELECTOR */
  onActivate: () => void;
  tone?: "default" | "alarm" | "muted";
  /** rendered OUTSIDE the tappable region, inside <MobileCardActions> */
  actions?: React.ReactNode;
  className?: string;
  /** the tappable body */
  children: React.ReactNode;
} & DataAttrs): React.JSX.Element {
  const Comp = as;

  function handleClick(e: React.MouseEvent<HTMLDivElement>): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest(INTERACTIVE_SELECTOR)) return;
    onActivate();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  }

  return (
    <Comp
      {...dataAttrs}
      className={cn("rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10", TONE_CLASSES[tone], className)}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex min-h-11 flex-col gap-2 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-muted/40",
          actions ? "rounded-t-xl" : "rounded-xl",
        )}
      >
        {children}
      </div>
      {actions ? <MobileCardActions>{actions}</MobileCardActions> : null}
    </Comp>
  );
}

/** A sibling of the body, never its child. */
export function MobileCardActions({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-card-action className={cn("flex items-center gap-2 border-t px-3 py-2", className)}>
      {children}
    </div>
  );
}
