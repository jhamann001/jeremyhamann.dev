/**
 * The single report-query → URLSearchParams serializer (shared convention 12; guardrail G11).
 *
 * The filter bar, the preset buttons and the "Download CSV" link all encode through this function, so
 * the page the operator is looking at and the file they download can never describe different sets.
 * Multi-value keys travel as REPEATED BARE KEYS (`?queueKey=OPERATIONS&queueKey=ADVICE`) — never
 * `queueKey[]`, never comma-joined — which is exactly the shape `parseReportQuery` accepts.
 *
 * Pure and browser-safe on purpose: it imports NOTHING. The report key is typed as a plain `string`
 * rather than `ReportKey` so this module stays on the client side of the G1 line (the key list lives in
 * `@/server/reports-query`, which no component may import); the server parser is the tolerant reader
 * that decides whether a key is real, which is where that decision belongs anyway.
 */

export type ReportQueryLike = {
  key: string;
  /** Firm-local calendar date, "YYYY-MM-DD". */
  from: string;
  to: string;
  granularity: string;
  queueKey?: readonly string[];
  priority?: readonly string[];
  category?: readonly string[];
};

export function reportQueryToParams(q: ReportQueryLike): URLSearchParams {
  const params = new URLSearchParams();
  params.set("report", q.key);
  params.set("from", q.from);
  params.set("to", q.to);
  params.set("granularity", q.granularity);
  for (const v of q.queueKey ?? []) params.append("queueKey", v);
  for (const v of q.priority ?? []) params.append("priority", v);
  for (const v of q.category ?? []) params.append("category", v);
  return params;
}

/** `/reports?report=volume&from=…` — the href a filter change navigates to. */
export function reportHref(pathname: string, q: ReportQueryLike): string {
  const qs = reportQueryToParams(q).toString();
  return qs === "" ? pathname : `${pathname}?${qs}`;
}

/** `/api/reports/export?report=…` — the same filters, pointed at the CSV route. */
export function reportExportHref(q: ReportQueryLike): string {
  return `/api/reports/export?${reportQueryToParams(q).toString()}`;
}
