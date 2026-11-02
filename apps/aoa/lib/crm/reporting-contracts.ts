export type CrmReportValue = string | number | null;

export type CrmReportFormat = "money" | "number" | "date";
export type CrmReportDatasetId =
  | "household_aum"
  | "deal_pipeline"
  | "client_engagement"
  | "transfers_funding";
export type CrmReportDirection = "asc" | "desc";

export type CrmReportColumn = {
  key: string;
  label: string;
  format?: CrmReportFormat;
  sortable?: boolean;
};

export type CrmReportMetric = {
  label: string;
  value: CrmReportValue;
  format?: CrmReportFormat;
  definition?: string;
};

export type CrmReportFilter = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select";
  value: string;
  placeholder?: string;
  helpText?: string;
  unit?: string;
  inputMode?: "decimal" | "text";
  options?: Array<{ value: string; label: string }>;
};

export type CrmReportQuery = {
  dataset: CrmReportDatasetId;
  page: number;
  pageSize: 25 | 50 | 100;
  sort: string;
  direction: CrmReportDirection;
  columns: string[];
  columnsExplicit: boolean;
  filters: Record<string, string>;
  rangeError?: string;
};

export type CrmReportDataset = {
  id: CrmReportDatasetId;
  label: string;
  description: string;
  columns: CrmReportColumn[];
  defaultColumns: string[];
  rows: Array<Record<string, CrmReportValue>>;
  rowLinks: Array<Record<string, string>>;
  /** Stable navigation identities, separate from displayed/exportable values. */
  rowIds?: string[];
  /** Scoped version of the filtered report projection, read with the page. */
  snapshot?: string;
  metrics: CrmReportMetric[];
  filters: CrmReportFilter[];
  totalRows: number;
  page: number;
  pageSize: 25 | 50 | 100;
  pageCount: number;
  sort: string;
  direction: CrmReportDirection;
  available: boolean;
  source: string;
  sourceAsOf: string | null;
  sourceAsOfLabel: string;
  retrievedAt: string;
  definitions: string[];
  exclusions: string[];
  drilldownHref?: string;
  drilldownLabel?: string;
};

export type CrmReportPageRow = {
  id: string;
  values: Record<string, CrmReportValue>;
  links: Record<string, string>;
};

export type CrmReportPageMeta = Pick<CrmReportDataset,
  "metrics" | "filters" | "sourceAsOf" | "retrievedAt" | "available"
>;
