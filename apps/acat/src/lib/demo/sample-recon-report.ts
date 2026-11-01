// Apex's ACAT Output for a demo transfer: what arrived, in the columns parse-apex-csv.ts
// reads. Everything arrives in full, except that a mutual fund's fractional share is paid as cash in
// lieu, as clearing firms do, which gives the reconciliation one real difference to catch.

import { csvCell } from "@/lib/csv-cell";

export interface SampleAsset {
  symbol: string;
  description: string;
  cusip: string | null;
  expectedQty: number;
  amount: number | null;
  assetClass: string | null;
}

const HEADERS = ["CUSIP", "Symbol", "Description", "Asset Class", "Qty", "Amount", "Settling Location", "Settling Location Reason"];

// Descriptions can be typed by visitors (positions added during a reconciliation), so a cell keeps no
// line break, which would start a new row for the line-based parser, and no live formula.
function cell(value: string | number): string {
  return csvCell(typeof value === "string" ? value.replace(/[\r\n]+/g, " ") : value);
}

function assetClassLabel(raw: string | null): string {
  const value = (raw ?? "").toLowerCase();
  if (value === "cash") return "Cash";
  if (value.includes("bond") || value.includes("fixed")) return "Fixed Income";
  return "Equity";
}

export function sampleReconReportCsv(assets: SampleAsset[]): string {
  const delivered = assets.filter((a) => a.expectedQty > 0);
  const fractional = delivered.find((a) => a.symbol !== "CASH" && !Number.isInteger(a.expectedQty));
  const rows = delivered.map((a) => {
    const isCash = a.symbol === "CASH";
    const qty = a === fractional ? Math.floor(a.expectedQty) : a.expectedQty;
    const price = a.amount != null && a.expectedQty ? a.amount / a.expectedQty : 0;
    const amount = isCash ? a.expectedQty : Math.round(qty * price * 100) / 100;
    return [
      a.cusip ?? "",
      a.symbol,
      a.description,
      assetClassLabel(isCash ? "cash" : a.assetClass),
      qty,
      amount.toFixed(2),
      isCash ? "Cash" : "DTC",
      a === fractional ? "Fractional share paid as cash in lieu" : "",
    ];
  });
  return [HEADERS, ...rows].map((row) => row.map(cell).join(",")).join("\n") + "\n";
}
