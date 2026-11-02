// "Export PDF" for a meeting-prep brief — BROWSER PRINT, not a generated file.
//
// Deliberately no PDF library. package.json carries none today, and adding one
// (pdfkit / puppeteer / react-pdf) would put either a heavyweight dependency or a
// headless Chromium into a Cloud Run container sized for a Next server. The
// browser already has a perfectly good PDF renderer behind the print dialog's
// "Save as PDF", so Export opens that dialog with a stylesheet that scopes the
// page to the brief. The button says "Export PDF" and opening the print dialog is
// the documented behaviour; swapping in a server-rendered PDF later replaces
// exactly this file plus the @media print block in app/globals.css.
//
// Mechanism. The brief lives deep inside a fixed-position slide-over, so simply
// hiding "everything else" is not enough: a fixed or absolutely-positioned
// ancestor does not paginate, and a multi-page brief would be clipped to page 1.
// So before printing we walk from [data-print-root] up to <body> stamping each
// ancestor with data-print-ancestor. The print rules then
//   • display:none every child of a stamped ancestor that is neither the print
//     root nor itself stamped — removing app chrome from LAYOUT, not just from
//     view, so nothing pushes the brief down the page; and
//   • flatten the stamped chain to plain static blocks, so the brief flows in
//     normal document order and paginates like ordinary content.
// The <body> stamp (data-printing) is what switches the whole block on, so a
// plain Cmd-P still prints the page normally.

/** Switched on for the duration of one Export. */
export const PRINT_BODY_ATTR = "data-printing";
export const PRINT_BODY_VALUE = "brief";
/** Stamped on each ancestor of the print root while printing. */
export const PRINT_ANCESTOR_ATTR = "data-print-ancestor";

/** The element surface this needs — injectable so it is testable in node. */
export type PrintElement = {
  parentElement: PrintElement | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export type PrintHost = {
  body: PrintElement;
  /** The [data-print-root] subtree, or null when the panel is not mounted. */
  printRoot(): PrintElement | null;
  print(): void;
  addEventListener(type: "afterprint", listener: () => void): void;
  removeEventListener(type: "afterprint", listener: () => void): void;
  setTimeout(handler: () => void, ms: number): unknown;
};

/**
 * PURE: stamp every ancestor of `root`, stopping after `stopAt` (the body).
 * Returns what was stamped so the caller can undo exactly that set — never a
 * blanket querySelectorAll sweep, which could strip a stamp another surface put
 * there. Tolerates a missing root (nothing to print) and a root outside `stopAt`
 * (the walk simply terminates at the top of the tree).
 */
export function markPrintAncestors(
  root: PrintElement | null,
  stopAt: PrintElement,
): PrintElement[] {
  const marked: PrintElement[] = [];
  let el = root?.parentElement ?? null;
  while (el) {
    el.setAttribute(PRINT_ANCESTOR_ATTR, "");
    marked.push(el);
    if (el === stopAt) break;
    el = el.parentElement;
  }
  return marked;
}

/**
 * Open the browser's print dialog with only the brief on the page.
 *
 * Cleanup runs on `afterprint` AND behind a timeout: `print()` blocks until the
 * dialog is dismissed in Chrome, but `afterprint` is not universally reliable,
 * and a body left stamped would make the NEXT plain Cmd-P print only the brief.
 * Both paths are idempotent.
 */
export function printBrief(host: PrintHost): void {
  const marked = markPrintAncestors(host.printRoot(), host.body);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    for (const el of marked) el.removeAttribute(PRINT_ANCESTOR_ATTR);
    host.body.removeAttribute(PRINT_BODY_ATTR);
    host.removeEventListener("afterprint", cleanup);
  };
  host.body.setAttribute(PRINT_BODY_ATTR, PRINT_BODY_VALUE);
  host.addEventListener("afterprint", cleanup);
  try {
    host.print();
  } finally {
    host.setTimeout(cleanup, 1000);
  }
}

/** The real browser host. Returns null in SSR / test envs with no window. */
export function browserPrintHost(): PrintHost | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    body: document.body,
    printRoot: () => document.querySelector("[data-print-root]"),
    print: () => window.print(),
    addEventListener: (t, l) => window.addEventListener(t, l),
    removeEventListener: (t, l) => window.removeEventListener(t, l),
    setTimeout: (h, ms) => window.setTimeout(h, ms),
  };
}

/** What the Export button calls. No-ops where there is no browser. */
export function exportBriefToPdf(): void {
  const host = browserPrintHost();
  if (host) printBrief(host);
}
