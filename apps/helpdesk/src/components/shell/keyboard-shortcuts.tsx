"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
} from "@/components/shell/responsive-sheet";

/**
 * Keyboard shortcuts.
 *
 * Rendered ONCE by the `(app)` layout, so a shortcut works on every authenticated page without each
 * page wiring its own listener.
 *
 * Two rules, both behaviour rather than ergonomics:
 *
 *  - **A shortcut never mutates anything on its own.** It may focus a field, open a sheet or navigate.
 *    That is why the action keys do not call server actions: they ACTIVATE THE EXISTING CONTROL, found
 *    by its `data-shortcut` attribute, so every confirmation, every version token and every audited
 *    path stays exactly where it was. "a" presses Assign to me; it does not assign.
 *  - **Nothing fires while focus is in an input, a textarea or a contenteditable**, so typing "n" into
 *    a ticket body cannot navigate away and lose the draft. A modifier key (⌘/Ctrl/Alt) also releases
 *    every binding, so the browser's own shortcuts are untouched.
 *
 * It is effectively DESKTOP-ONLY without a media query: a `keydown` only arrives where there is a
 * keyboard, and `useMediaQuery` has exactly two permitted consumers (MOBILE_FIRST R6). The help sheet
 * itself is responsive, so a tablet with a keyboard gets a usable one.
 *
 * Every action announces itself in a polite live region — including "not available here", because a
 * key that silently does nothing is a key people press twice. Fix round 1 makes that literal: the
 * announcement now states what the DOM did, never what the handler intended. `r` and `n` resolve to
 * Radix `TabsTrigger`s, which change selection on focus and on pointer events and ignore a synthetic
 * `HTMLElement.click()` entirely — so the old code moved nothing and read "The internal note composer
 * opened." to a screen reader while the composer was still on the client-visible PUBLIC channel. That
 * is the one surface whose whole design (the amber frame, "never sent to client", the disclaimer gate)
 * exists to keep the two channels apart, and an assistive-technology user acts on the announcement.
 */

export type ShortcutAction =
  | "next"
  | "previous"
  | "open"
  | "assign-to-me"
  | "reply"
  | "internal-note"
  | "edit-ticket"
  | "search"
  | "help"
  | "dismiss";

/** True when focus is somewhere typing must win. Pure; exported for the test. */
export function isTypingTarget(el: Element | null): boolean {
  if (el === null) return false;
  // Duck-typed rather than `instanceof HTMLElement`: this function is pure and is tested in a node
  // project with no DOM, and an `instanceof` against an undefined global throws rather than failing.
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as Partial<HTMLElement>).isContentEditable === true) return true;
  return typeof el.closest === "function" && el.closest("[contenteditable=true]") !== null;
}

export type ShortcutEventLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: Element | null;
};

/**
 * The whole binding table, as a pure function. Returns null when the event is not ours — a modifier is
 * held, focus is in a field, or the key is unbound.
 *
 * `?` is deliberately matched on the KEY rather than on shift+/ so a keyboard layout where `?` is
 * unshifted still opens the help sheet.
 */
export function matchShortcut(e: ShortcutEventLike): ShortcutAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Escape") return "dismiss";
  if (isTypingTarget(e.target)) return null;
  switch (e.key) {
    case "j":
      return "next";
    case "k":
      return "previous";
    case "o":
      return "open";
    case "a":
      return "assign-to-me";
    case "r":
      return "reply";
    case "n":
      return "internal-note";
    case "e":
      return "edit-ticket";
    case "/":
      return "search";
    case "?":
      return "help";
    default:
      return null;
  }
}

/** What each control-activating action looks for, in order. Pure data; exported for the test. */
export const SHORTCUT_TARGETS: Readonly<Record<"assign-to-me" | "reply" | "internal-note" | "edit-ticket" | "search", readonly string[]>> = {
  "assign-to-me": ['[data-shortcut="assign-to-me"]'],
  reply: ['[data-shortcut="reply"]'],
  "internal-note": ['[data-shortcut="internal-note"]'],
  "edit-ticket": ['[data-shortcut="edit-ticket"]'],
  // The topbar search input needs no co-operation from its owner: a search box is already a search box.
  search: ['[data-shortcut="search"]', 'input[type="search"]', 'input[role="searchbox"]', '[role="searchbox"]'],
};

const KEY_HELP: ReadonlyArray<{ keys: string; what: string }> = [
  { keys: "j / k", what: "Move down and up the list" },
  { keys: "o", what: "Open the highlighted ticket" },
  { keys: "Enter", what: "Activate what is focused — on the board, the preview" },
  { keys: "a", what: "Assign to me (presses the button; it still confirms)" },
  { keys: "r", what: "Open the reply composer — it does not send" },
  { keys: "n", what: "Open the internal note composer" },
  { keys: "e", what: "Edit the ticket's fields" },
  { keys: "/", what: "Jump to search" },
  { keys: "?", what: "This list" },
  { keys: "Esc", what: "Close what is open" },
];

/**
 * Rows a j/k cursor walks, in document order.
 *
 * The shortcut layer has its OWN attribute namespace (`data-shortcut-*`, the same one
 * `SHORTCUT_TARGETS` uses) rather than reusing the shared ticket-id attribute. Two reasons, and both
 * are design rather than convenience: that attribute is emitted by several components for three
 * different purposes (the QA probe in `ticket-list-probe.test.ts` exists precisely because it is
 * ambiguous), and a page should opt INTO keyboard navigation by marking the rows it wants walked,
 * rather than every element that happens to know a ticket id becoming a cursor stop. The value here is
 * the ticket id, so "o" needs no second lookup.
 */
export const SHORTCUT_ROW_ATTR = "data-shortcut-row" as const;
const ROW_SELECTOR = `[${SHORTCUT_ROW_ATTR}]`;

/**
 * The smallest slice of an element this layer touches. Declared structurally so the activation rules
 * below are testable in a node project with no DOM — `vitest.config.mts` runs `environment: "node"`.
 */
export type ShortcutTargetLike = {
  getAttribute(name: string): string | null;
  focus(): void;
  click(): void;
};

/**
 * A tab is not a button. Radix's `Tabs` selects on focus (automatic activation) and on pointer events;
 * `HTMLElement.click()` dispatches a click nothing is listening for, so a tab target must be FOCUSED,
 * and the result must then be read rather than assumed.
 */
export function isTabTarget(el: Pick<ShortcutTargetLike, "getAttribute">): boolean {
  return el.getAttribute("role") === "tab";
}

/** Did the tab actually move? The only outcome this layer can observe. */
export function isTabSelected(el: Pick<ShortcutTargetLike, "getAttribute">): boolean {
  return el.getAttribute("aria-selected") === "true";
}

export type ShortcutOutcome = "opened" | "no-change" | "absent";

/** The live-region sentence per outcome. "opened" is reserved for an outcome that was OBSERVED. */
export function shortcutAnnouncement(label: string, outcome: ShortcutOutcome): string {
  switch (outcome) {
    case "opened":
      return `${label} opened.`;
    case "no-change":
      // Names the control rather than the key, because the key is what just failed.
      return `${label} did not open. Use the channel tabs above the message box.`;
    case "absent":
      return `${label} is not available here.`;
  }
}

/**
 * Activate ONE resolved control and announce what happened.
 *
 * `defer` exists so the verification runs after the framework has re-rendered — a React state change
 * is not visible in the DOM on the same tick — and so the whole path is exercisable synchronously by
 * a test that passes `(fn) => fn()`.
 */
export function activateResolvedTarget(
  el: ShortcutTargetLike,
  label: string,
  announce: (message: string) => void,
  defer: (fn: () => void) => void,
): void {
  if (!isTabTarget(el)) {
    el.click();
    announce(shortcutAnnouncement(label, "opened"));
    return;
  }
  // Focus is the real mechanism, not a trick to fool the library: the shortcut moves keyboard focus to
  // the channel tab, and automatic activation selects it. The click stays for a non-Radix tab.
  el.focus();
  el.click();
  defer(() => announce(shortcutAnnouncement(label, isTabSelected(el) ? "opened" : "no-change")));
}

export function KeyboardShortcuts(): React.JSX.Element | null {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const cursor = useRef<string | null>(null);

  const announce = useCallback((message: string) => {
    // Re-announce an identical message by clearing first: a live region ignores an unchanged value.
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 10);
  }, []);

  const move = useCallback(
    (delta: 1 | -1) => {
      const rows = [...document.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
      if (rows.length === 0) {
        announce("No list on this page.");
        return;
      }
      const currentIndex =
        cursor.current === null ? -1 : rows.findIndex((r) => r.getAttribute(SHORTCUT_ROW_ATTR) === cursor.current);
      const nextIndex = currentIndex < 0 ? (delta === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
      const row = rows[nextIndex];
      if (row === undefined) return;
      cursor.current = row.getAttribute(SHORTCUT_ROW_ATTR);
      const focusable = row.matches("[tabindex],a,button") ? row : row.querySelector<HTMLElement>("[tabindex],a,button");
      (focusable ?? row).focus({ preventScroll: false });
      row.scrollIntoView({ block: "nearest" });
      announce(row.getAttribute("aria-label") ?? `Ticket ${cursor.current ?? ""}`);
    },
    [announce],
  );

  const activate = useCallback(
    (action: keyof typeof SHORTCUT_TARGETS, label: string) => {
      for (const selector of SHORTCUT_TARGETS[action]) {
        const el = document.querySelector<HTMLElement>(selector);
        if (el === null || el.hasAttribute("disabled")) continue;
        if (action === "search") {
          el.focus();
          announce("Search focused.");
          return;
        }
        activateResolvedTarget(el, label, announce, (fn) => window.setTimeout(fn, 0));
        return;
      }
      announce(shortcutAnnouncement(label, "absent"));
    },
    [announce],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target instanceof Element ? event.target : null;
      const action = matchShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        target,
      });
      if (action === null) return;

      switch (action) {
        case "dismiss":
          if (helpOpen) {
            event.preventDefault();
            setHelpOpen(false);
          }
          return;
        case "help":
          event.preventDefault();
          setHelpOpen(true);
          return;
        case "next":
          event.preventDefault();
          move(1);
          return;
        case "previous":
          event.preventDefault();
          move(-1);
          return;
        case "open": {
          event.preventDefault();
          const id = cursor.current ?? target?.closest(ROW_SELECTOR)?.getAttribute(SHORTCUT_ROW_ATTR) ?? null;
          if (id === null) {
            announce("Highlight a ticket first, with j or k.");
            return;
          }
          // An ordinary navigation, so the ticket page writes its own audited TICKET_VIEWED, and
          // never a prefetch.
          router.push(`/tickets/${encodeURIComponent(id)}`);
          return;
        }
        case "search":
        case "assign-to-me":
        case "reply":
        case "internal-note":
        case "edit-ticket":
          event.preventDefault();
          activate(
            action,
            action === "assign-to-me"
              ? "Assign to me"
              : action === "reply"
                ? "The reply composer"
                : action === "internal-note"
                  ? "The internal note composer"
                  : action === "edit-ticket"
                    ? "Edit ticket"
                    : "Search",
          );
          return;
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [move, activate, router, helpOpen, announce]);

  return (
    <>
      <span aria-live="polite" role="status" className="sr-only">
        {announcement}
      </span>
      <ResponsiveSheet
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="Keyboard shortcuts"
        description="Nothing here sends, saves or deletes — a shortcut opens a control, it never presses through one."
        size="lg"
      >
        <ResponsiveSheetBody>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {KEY_HELP.map((row) => (
              <div key={row.keys} className="contents">
                <dt className="font-mono text-xs text-muted-foreground">{row.keys}</dt>
                <dd>{row.what}</dd>
              </div>
            ))}
          </dl>
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}
