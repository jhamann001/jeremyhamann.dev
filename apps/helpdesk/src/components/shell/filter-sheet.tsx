"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SheetTitle } from "@/components/ui/sheet";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
} from "@/components/shell/responsive-sheet";

/**
 * Phone filter surface shared by the dashboard and the audit log — docs/MOBILE_FIRST.md §3.9.
 * ResponsiveSheet height="full". Header: title + count Badge; "Clear all" ghost Button when
 * onClearAll && activeCount > 0. children → ResponsiveSheetBody (FilterSections); footer →
 * ResponsiveSheetFooter. Content mounts only while open (Radix).
 */
export function FilterSheet({
  open,
  onOpenChange,
  title = "Filters",
  activeCount,
  onClearAll,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  activeCount: number;
  onClearAll?: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}): React.JSX.Element {
  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange} height="full">
      <ResponsiveSheetHeader className="flex-row items-center gap-2">
        <SheetTitle>{title}</SheetTitle>
        <Badge variant={activeCount > 0 ? "default" : "secondary"} className="tabular-nums">
          {activeCount}
          <span className="sr-only"> active</span>
        </Badge>
        {onClearAll && activeCount > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClearAll}>
            Clear all
          </Button>
        ) : null}
      </ResponsiveSheetHeader>
      <ResponsiveSheetBody>{children}</ResponsiveSheetBody>
      <ResponsiveSheetFooter>{footer}</ResponsiveSheetFooter>
    </ResponsiveSheet>
  );
}

/** The phone-only "Filters (n)" button that opens the sheet; 44px via the globals.css phone rule. */
export function FilterSheetTrigger({
  activeCount,
  onClick,
  expanded,
  label = "Filters",
  className,
}: {
  activeCount: number;
  onClick: () => void;
  expanded?: boolean;
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`${label}, ${activeCount} active`}
      className={cn("shrink-0 md:hidden", className)}
      onClick={onClick}
    >
      <SlidersHorizontal aria-hidden />
      {label}
      {activeCount > 0 ? (
        <Badge variant="secondary" className="tabular-nums">
          {activeCount}
        </Badge>
      ) : null}
    </Button>
  );
}

/** One labelled group of controls inside the sheet body (Status / Priority / SLA …). */
export function FilterSection({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <fieldset className={cn("flex flex-col gap-2 py-3 not-last:border-b", className)}>
      <legend className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Wave A filter controls. Additive: nothing above changes, and both the md+ filter bar and the
// phone FilterSheet render these same two components, so a long option list and a date range look and
// behave identically in the two layouts.
// ---------------------------------------------------------------------------

export type FilterCheckboxOption = { value: string; label: string };

/**
 * Checkbox list for an option set too long to be a chip row — `TicketCategory` is 22 values after
 * Decision #61. Scrolls inside itself (`max-h`), so it never lengthens the page or the sheet body;
 * each row is a full-width label, which gives the 44 px target on phones without a wrapper class
 * (the checkbox's own ::after hit area is widened globally, and the row is `min-h-11` besides).
 *
 * Deliberately NOT `overscroll-contain`. Inside the phone FilterSheet this list is a
 * scroller nested in `ResponsiveSheetBody`, which is itself `overflow-y-auto overscroll-contain`.
 * Containment on the INNER list stops scroll chaining, so a finger that lands on Category — 22 options,
 * a 16rem box, with Source right below it and Created/Sort below that — scrolls the list to its end and
 * then nothing at all, hiding every section underneath. Chaining back to the sheet body is the correct
 * behaviour here; the body's own containment still stops the page behind the sheet from moving.
 */
export function FilterCheckboxList({
  options,
  selected,
  onToggle,
  label,
  className,
  columns = 1,
}: {
  options: readonly FilterCheckboxOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** Accessible name of the list (the visible legend is the FilterSection's or the popover's). */
  label: string;
  className?: string;
  /** 1 on phones / inside a narrow popover; 2 where there is room. */
  columns?: 1 | 2;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "grid max-h-64 w-full gap-0.5 overflow-y-auto pr-1",
        columns === 2 ? "grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {options.map((o) => {
        const checked = selected.includes(o.value);
        return (
          <label
            key={o.value}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-muted/60 md:min-h-8"
          >
            <Checkbox checked={checked} onCheckedChange={() => onToggle(o.value)} aria-label={o.label} />
            <span className="min-w-0 truncate">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Inclusive-from / inclusive-to calendar range on native `<input type="date">` — deliberately native:
 * the platform picker is the best touch date control there is, it needs no dependency, and the
 * global phone rule already gives it 16 px text and a 44 px height. The caller owns the conversion
 * between these calendar days and the ISO instants in the URL.
 */
export function FilterDateRange({
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  fromLabel = "From",
  toLabel = "To",
  disabled,
  max,
  className,
}: {
  fromValue: string;
  toValue: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  fromLabel?: string;
  toLabel?: string;
  disabled?: boolean;
  /** Usually today: a created-date range can never be in the future. */
  max?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("grid w-full grid-cols-2 gap-2", className)}>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {fromLabel}
        <Input
          type="date"
          value={fromValue}
          max={toValue.length > 0 ? toValue : max}
          onChange={(e) => onFromChange(e.target.value)}
          disabled={disabled}
          aria-label={fromLabel}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {toLabel}
        <Input
          type="date"
          value={toValue}
          min={fromValue.length > 0 ? fromValue : undefined}
          max={max}
          onChange={(e) => onToChange(e.target.value)}
          disabled={disabled}
          aria-label={toLabel}
        />
      </label>
    </div>
  );
}

export type ActiveFilterChip = { key: string; label: string; onRemove: () => void };

/**
 * Element-level horizontal snap scroller (counter carousel, active-filter chips). Children add
 * "snap-start shrink-0"; consumers also set data-snap-row (QA allowlist + hidden scrollbar). The
 * -mx-4/px-4 bleed assumes the 1rem phone gutter (`px-safe`); the row scrolls inside itself, the page never
 * scrolls sideways.
 */
export const SNAP_ROW_CLASSES =
  "flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain scroll-px-4 -mx-4 px-4";

/** Removable chips for the applied filters; null when empty. Phone only (md+ keeps its inline chip groups). */
export function ActiveFilterChips({
  chips,
  onClearAll,
  className,
}: {
  chips: readonly ActiveFilterChip[];
  onClearAll?: () => void;
  className?: string;
}): React.JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Active filters" data-snap-row className={cn(SNAP_ROW_CLASSES, "md:hidden", className)}>
      {chips.map((chip) => (
        <li key={chip.key} className="snap-start shrink-0">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-w-11 max-w-[70vw] font-normal"
            aria-label={`Remove filter: ${chip.label}`}
            onClick={chip.onRemove}
          >
            <span className="truncate">{chip.label}</span>
            <X aria-hidden />
          </Button>
        </li>
      ))}
      {onClearAll && chips.length > 1 ? (
        <li className="snap-start shrink-0">
          <Button type="button" size="sm" variant="ghost" onClick={onClearAll}>
            Clear all
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
