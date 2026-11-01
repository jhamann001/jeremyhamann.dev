import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Bottom-fixed action bar for phone routes that own the bottom edge (/tickets/new, /tickets/[id], the
 * sign-in Okta CTA) — docs/MOBILE_FIRST.md §2 route rule and §3.7. No "use client": the sign-in RSC
 * renders it around a plain <form>. Shares `--wm-bottom-bar-h` with BottomNav, so <main> reserves one bar
 * height on every phone route. Children are Buttons (forms; give each "flex-1") or StickyActionItems (dock).
 * May be rendered INSIDE a <form>: position:fixed does not break form association, so a type="submit"
 * child submits.
 */
export function StickyActionBar({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-sticky-action-bar
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t bg-background/95 supports-backdrop-filter:backdrop-blur",
        "px-safe pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] min-h-[calc(var(--wm-bottom-bar-h)+env(safe-area-inset-bottom,0px))] md:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

const ITEM_CLASSES =
  "flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 aria-expanded:text-foreground [&_svg]:size-5";

type StickyActionItemBase = {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  /**
   * Why the item is unavailable. Rendered as an `sr-only` element the control points at with
   * `aria-describedby`, plus a `title` for a desktop pointer.
   *
   * It is deliberately NOT painted into the bar. The bar is `position: fixed` at exactly
   * one `--wm-bottom-bar-h`, which is the height `<main>` reserves with `pb-bar-safe`; a text line above
   * the item row would make the bar taller than the reservation and cover the last line of page content
   * at full scroll — probe G10 — and a line rendered as a bar CHILD would also break §7's
   * `[data-sticky-action-bar] > *` length `=== 5`. The visible explanation lives where the item leads:
   * the composer sheet prints the disabled channel's reason as a `<p>` under its `TabsList`, and with
   * `anyComment` true at least one dock item always opens it. See
   * the build record and
   * the build record round 3.
   */
  disabledReason?: string;
  className?: string;
};

type StickyActionItemProps = StickyActionItemBase &
  ({ href: string } | { onClick: () => void; "aria-expanded"?: boolean; "aria-haspopup"?: "dialog" });

/** Stable within one bar: `label` is what distinguishes the items from each other (R10 names them). */
function reasonId(label: string): string {
  return `sticky-action-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-reason`;
}

/**
 * Icon-over-label item, same look as a BottomNav tab. Renders <Link prefetch={false}> when `href` is given,
 * else <button type="button">. disabled → `disabled` + aria-disabled="true" + opacity-50, the reason as an
 * `sr-only` node referenced by `aria-describedby`, and `title` for a pointer.
 *
 * No `useId`: this module has no "use client" (the sign-in RSC renders the bar around a plain <form>), so
 * it may not call hooks. Item labels are unique inside a bar, which is what makes `reasonId` collision-free
 * — and G11 (no duplicate ids) covers it if that ever stops being true.
 */
export function StickyActionItem(props: StickyActionItemProps): React.JSX.Element {
  const { icon: Icon, label, active = false, disabled = false, disabledReason, className } = props;
  const classes = cn(ITEM_CLASSES, active && "text-foreground", disabled && "opacity-50", className);
  const reason = disabled ? disabledReason?.trim() : undefined;
  const hasReason = reason !== undefined && reason.length > 0;
  const describedBy = hasReason ? reasonId(label) : undefined;
  const title = hasReason ? reason : undefined;
  const content = (
    <>
      <Icon aria-hidden />
      <span className="max-w-full truncate">{label}</span>
      {/* `disabled` drops a button out of the accessibility tree in some engines and `title` on it is
          announced inconsistently, so the reason is a real node the control points at. It costs no
          layout, which is the constraint the bar is under — see `disabledReason` above. */}
      {hasReason ? (
        <span id={describedBy} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  );

  if ("href" in props) {
    if (disabled) {
      return (
        <span role="link" aria-disabled="true" aria-describedby={describedBy} title={title} className={classes}>
          {content}
        </span>
      );
    }
    return (
      <Link
        href={props.href}
        prefetch={false}
        aria-current={active ? "page" : undefined}
        title={title}
        className={classes}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      aria-describedby={describedBy}
      aria-expanded={props["aria-expanded"]}
      aria-haspopup={props["aria-haspopup"]}
      title={title}
      className={classes}
    >
      {content}
    </button>
  );
}
