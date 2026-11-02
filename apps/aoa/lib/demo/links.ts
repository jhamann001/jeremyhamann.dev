// Where a record in this demo lives in the other public demos (plan D3: one shared world, with links across demos).
// Every demo seeds the same records from the shared synthetic universe under the same ids, and keeps them through
// its nightly reset: the Transfer Tracker's records (tr-…), the Trade Request demo's requests (REQ-…), and the
// Statement Analyzer's runs (the id each derives from the run's folder and number; see its demo_reset.demo_run_id).
// Each demo brings a signed-out visitor back to the record after they pick a persona. Safe to import from client code.

import { EXTERNAL_APPS } from "@/lib/external-apps";

export type OtherDemo = "Transfer Tracker" | "Statement Analyzer" | "Trade Request";

const origin = (url: string) => new URL(url).origin;
const TRANSFERS = origin(EXTERNAL_APPS.acatTracking);
const STATEMENTS = origin(EXTERNAL_APPS.assetMapping);
const TRADE = origin(EXTERNAL_APPS.tradeRequests);

export const otherDemoLinks = {
  /** A Transfer Tracker record (an ACAT book entry), opened in its records drawer. */
  trackerRecord: (recordId: string) => `${TRANSFERS}/records?open=${encodeURIComponent(recordId)}`,
  /** A Statement Analyzer run: the asset map's household. */
  statementRun: (runId: string) => `${STATEMENTS}/run/${encodeURIComponent(runId)}`,
  /** A trade request, opened in the Trade Request demo's queue. */
  tradeRequest: (requestId: string) => `${TRADE}/queue/${encodeURIComponent(requestId)}`,
} as const;

/** Requests only this demo holds (REQ-00000901 onward, below the shared plan's ids): no other demo has them to link to. */
export function tradeRequestOnlyHere(requestId: string): boolean {
  const n = Number(requestId.replace(/\D/g, ""));
  return n > 0 && n < 1000;
}

/** The link with the visitor's current theme, which the other demo starts in (apps/demo-edge/theme-handoff.js). */
export function withTheme(href: string, dark: boolean): string {
  const url = new URL(href);
  url.searchParams.set("theme", dark ? "dark" : "light");
  return url.toString();
}
