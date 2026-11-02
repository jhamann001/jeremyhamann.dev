// Client-safe: statement upload limits, review values and the mockup's panel
// and dialog copy (ticket). Server validation of the bytes lives in
// lib/data/transfer-statement-documents.ts.

export const STATEMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Next clones a request body through middleware up to 10 MB; the multipart envelope must fit too. */
export const STATEMENT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const STATEMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png";

export const STATEMENT_REVIEW_STATUSES = ["pending", "accepted", "replacement_needed"] as const;
export type StatementReviewStatus = (typeof STATEMENT_REVIEW_STATUSES)[number];

/** The dialog's select values, as in the mockup. */
export const STATEMENT_REVIEW_OPTIONS = [
  { value: "pending", label: "Awaiting review" },
  { value: "yes", label: "Accepted — current and usable" },
  { value: "no", label: "Needs replacement" },
] as const;
export type StatementReviewOption = (typeof STATEMENT_REVIEW_OPTIONS)[number]["value"];

export const STATEMENT_MESSAGES = {
  badFile: "Choose a non-empty PDF, JPG or PNG statement.",
  tooLarge: "Statements must be 8 MB or smaller.",
  signature: "The file contents do not match its PDF, JPG or PNG type.",
  noFile: "Choose a statement first.",
  badDate: "Enter a valid statement date.",
  futureDate: "The statement date cannot be in the future.",
  badReview: "Choose the statement review status.",
  submitted: "A submitted movement cannot replace its source statement.",
  paused: "Resume this transfer before changing its source statement.",
  stale: "This transfer changed. Reopen statement review for its current source account.",
  role: "Your role cannot record statement or account-type checks.",
  unavailable: "The statement could not be saved. Try again.",
  demoUploadsOff: "Uploading files is off in the public demo. Use the sample statement instead.",
} as const;

/** The file the public demo offers in place of an upload (lib/demo/sample-statement.ts builds it). */
export const DEMO_SAMPLE_STATEMENT_FILENAME = "sample-statement.pdf";

export function reviewStatusFromOption(value: unknown): StatementReviewStatus | null {
  switch (value) {
    case "pending":
      return "pending";
    case "yes":
      return "accepted";
    case "no":
      return "replacement_needed";
    default:
      return null;
  }
}

const EXTENSION = /^.+\.(pdf|jpe?g|png)$/i;

/** The mockup's client-side file check, plus the stored size limit. */
export function statementFileProblem(name: string | undefined, size: number | undefined): string | null {
  if (!name || !EXTENSION.test(name) || size == null || !Number.isFinite(size) || size <= 0) {
    return STATEMENT_MESSAGES.badFile;
  }
  if (size > STATEMENT_MAX_BYTES) return STATEMENT_MESSAGES.tooLarge;
  return null;
}

export function statementSizeLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The latest statement as the panel and dialog read it. */
export type StatementView = {
  /** A statement row exists. Rows from before file storage have no file or date. */
  provided: boolean;
  accepted: boolean;
  reviewStatus: StatementReviewStatus | null;
  filename: string | null;
  /** YYYY-MM-DD, or null when no date was recorded. */
  statementDate: string | null;
};

export const NO_STATEMENT: StatementView = {
  provided: false, accepted: false, reviewStatus: null, filename: null, statementDate: null,
};

function effectiveReview(view: StatementView): StatementReviewStatus {
  if (view.reviewStatus) return view.reviewStatus;
  return view.accepted ? "accepted" : "replacement_needed";
}

/** "September 30, 2026", or the mockup's "not recorded". */
export function statementLongDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(Date.parse(iso))) return iso || "not recorded";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(iso));
}

/** The blocker label, or null when the latest statement is accepted. */
export function statementIssueLabel(view: StatementView): string | null {
  if (view.provided && view.accepted) return null;
  if (view.provided && effectiveReview(view) === "pending") return "Statement awaiting review";
  return "Current statement needed";
}

export function statementCheckTitle(view: StatementView): string {
  return statementIssueLabel(view) ?? "Current statement accepted";
}

export function statementCheckHelp(view: StatementView): string {
  const dated = `Dated ${statementLongDate(view.statementDate)}.`;
  if (statementIssueLabel(view) == null) return `${dated} Ready for mapping and review.`;
  if (view.provided && effectiveReview(view) === "pending") {
    return `${dated} Review this statement to unblock transfer preparation.`;
  }
  return view.provided
    ? `${dated} Replace this statement to unblock transfer preparation.`
    : `${dated} Add and review a statement to begin transfer preparation.`;
}

export function statementButtonLabel(view: StatementView): string {
  if (view.provided && effectiveReview(view) === "pending") return "Review statement";
  return view.provided ? "Add updated statement" : "Add statement";
}

export function statementDialogTitle(view: StatementView): string {
  return view.provided ? "Add an updated statement" : "Add a statement";
}

const REVIEW_LABEL: Record<StatementReviewStatus, string> = {
  pending: "Awaiting review",
  accepted: "Accepted",
  replacement_needed: "Needs replacement",
};

/** The dialog's "Current statement" box. */
export function currentStatementSummary(view: StatementView): { name: string; detail: string } {
  if (!view.provided) {
    return {
      name: "No statement provided yet",
      detail: "Add this source account’s statement and review it before preparing the transfer.",
    };
  }
  return {
    name: view.filename ?? "Statement file not stored",
    detail: `Dated ${statementLongDate(view.statementDate)} · ${REVIEW_LABEL[effectiveReview(view)]}`,
  };
}

/** The delivering-account card's statement line. */
export function deliveringStatementLine(view: StatementView): string {
  return view.provided ? `Statement: ${view.statementDate ?? "date pending"}` : "No statement provided yet";
}

/** The success message the mockup shows after saving. */
export function statementSavedMessage(status: StatementReviewStatus): string {
  switch (status) {
    case "accepted":
      return "Statement accepted. Run mapping on the updated statement.";
    case "pending":
      return "Statement added. Preparation waits for statement review.";
    case "replacement_needed":
      return "Statement recorded. A replacement is still needed.";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}
