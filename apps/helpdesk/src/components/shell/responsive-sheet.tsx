"use client";

import { useRef } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";
import { MD_UP, useMediaQuery } from "@/hooks/use-media-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * One sheet, two presentations (decision D1): a bottom sheet on phones and
 * shadcn's right/left sheet from `md`. The Radix `side` is a prop, not CSS, because it drives `data-side`,
 * the enter/exit animation and the positioning recipe. This module and `ResponsivePopover` below are the
 * ONLY permitted consumers of `useMediaQuery`. No sheet is ever open at first paint, so the SSR
 * default (phone) causes no flash.
 */
export type ResponsiveSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Rendered as <SheetTitle> inside a ResponsiveSheetHeader. OMIT only when the consumer renders its own
   * <SheetTitle> in children (sr-only allowed) — a title is mandatory for a11y either way.
   */
  title?: React.ReactNode;
  /** default false → SheetTitle gets "sr-only" */
  titleHidden?: boolean;
  /** <SheetDescription>; when omitted, aria-describedby={undefined} is passed to SheetContent */
  description?: React.ReactNode;
  /** md+ side; phones are ALWAYS side="bottom". Default "right". */
  side?: "right" | "left";
  /** md+ width: "md" = shadcn default (data-[side=right]:sm:max-w-sm); "lg" = 560px. Default "md". */
  size?: "md" | "lg";
  /** phone: "auto" = content height capped at 90svh; "full" = exactly 90svh (scrolling bodies). Default "auto". */
  height?: "auto" | "full";
  /** default true (the X is data-slot="sheet-close" → 44×44 on phones via the globals.css phone rule) */
  showCloseButton?: boolean;
  /** extra classes for SheetContent */
  className?: string;
  /** e.g. onInteractOutside */
  contentProps?: Omit<
    React.ComponentProps<typeof SheetContent>,
    "side" | "className" | "children" | "showCloseButton"
  >;
  /** compose ResponsiveSheetBody / ResponsiveSheetFooter */
  children: React.ReactNode;
};

export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  titleHidden = false,
  description,
  side = "right",
  size = "md",
  height = "auto",
  showCloseButton = true,
  className,
  contentProps,
  children,
}: ResponsiveSheetProps): React.JSX.Element {
  const desktop = useMediaQuery(MD_UP);

  // R10 focus return. A controlled Sheet has no Radix trigger, so on close Radix focuses a null triggerRef and
  // focus falls to <body>. Capture whatever was focused when the sheet opened (card body, dock item, tab,
  // popover trigger) and hand focus back to it; a consumer's own onCloseAutoFocus that preventDefault()s wins.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const { onOpenAutoFocus, onCloseAutoFocus, ...restContentProps }: NonNullable<ResponsiveSheetProps["contentProps"]> =
    contentProps ?? {};

  let header: React.ReactNode = null;
  if (title !== undefined) {
    header =
      titleHidden && description === undefined ? (
        // No visible header at all: the sr-only title costs no layout space.
        <SheetTitle className="sr-only">{title}</SheetTitle>
      ) : (
        <ResponsiveSheetHeader>
          <SheetTitle className={titleHidden ? "sr-only" : undefined}>{title}</SheetTitle>
          {description !== undefined ? <SheetDescription>{description}</SheetDescription> : null}
        </ResponsiveSheetHeader>
      );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={desktop ? side : "bottom"}
        showCloseButton={showCloseButton}
        data-responsive-sheet
        data-height={height}
        className={cn(
          "flex flex-col gap-0 p-0",
          // phone
          "data-[side=bottom]:max-h-[90svh] data-[side=bottom]:rounded-t-2xl",
          // twMerge collapses the base h-auto (same variant)
          height === "full" && "data-[side=bottom]:h-[90svh]",
          // collapses the base sm:max-w-sm
          size === "lg" && "data-[side=right]:sm:max-w-[560px] data-[side=left]:sm:max-w-[560px]",
          className,
        )}
        // the shadcn way to silence Radix's missing-description warning
        {...(description === undefined ? { "aria-describedby": undefined } : {})}
        onOpenAutoFocus={(e) => {
          const active = document.activeElement;
          returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
          onOpenAutoFocus?.(e);
        }}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (e.defaultPrevented) return;
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          if (el && el.isConnected) {
            e.preventDefault();
            el.focus();
          }
        }}
        {...restContentProps}
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-(--wm-sheet-handle) md:hidden"
        />
        {header}
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** pr-14 clears the 44px close button. */
export function ResponsiveSheetHeader({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <SheetHeader className={cn("flex flex-col gap-1 px-4 pt-3 pb-3 pr-14", className)}>{children}</SheetHeader>;
}

/** The scrolling region: everything between header and footer. */
export function ResponsiveSheetBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4", className)}>{children}</div>;
}

/** Safe-area padded footer; keeps data-slot="sheet-footer" for the QA probes. */
export function ResponsiveSheetFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SheetFooter
      className={cn(
        "mt-auto flex flex-row items-center gap-2 border-t bg-muted/30 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] md:pb-3",
        className,
      )}
    >
      {children}
    </SheetFooter>
  );
}

/**
 * Popover at md+, bottom sheet on phones; the same `children` in both modes. The trigger is a <Button>:
 * it receives onClick / aria-expanded / aria-haspopup through Slot.Root (phone) or PopoverTrigger asChild
 * (md+). A `disabled` trigger button never fires the Slot's onClick.
 */
export function ResponsivePopover({
  open,
  onOpenChange,
  trigger,
  title,
  align = "start",
  sideOffset = 4,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** a <Button>; receives onClick/aria-expanded/aria-haspopup via Slot.Root (phone) or PopoverTrigger asChild (md+) */
  trigger: React.ReactElement;
  /** visible SheetTitle on phone; not rendered in the desktop popover */
  title: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** PopoverContent classes at md+ (e.g. "w-80 p-0") */
  className?: string;
  /** the same content in both modes */
  children: React.ReactNode;
}): React.JSX.Element {
  const desktop = useMediaQuery(MD_UP);

  if (!desktop) {
    return (
      <>
        <Slot.Root onClick={() => onOpenChange(true)} aria-haspopup="dialog" aria-expanded={open}>
          {trigger}
        </Slot.Root>
        <ResponsiveSheet open={open} onOpenChange={onOpenChange} title={title} height="auto">
          <ResponsiveSheetBody className="px-0 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">{children}</ResponsiveSheetBody>
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} sideOffset={sideOffset} className={className}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
