export type SavedReportShortcut = {
  id: string;
  label: string;
  description: string;
  href: string;
};

/** Built-in report shortcuts are separate from an operator's browser-saved CRM views. */
export const MAILING_REPORT_SHORTCUT: SavedReportShortcut = {
  id: "transfer-mailing",
  label: "Mailing report",
  description: "FedEx and manual mailers, tracking, and postage across client transfers.",
  href: "/reporting/mailing",
};
