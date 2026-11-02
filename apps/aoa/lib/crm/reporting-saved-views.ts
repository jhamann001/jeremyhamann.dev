import type { CrmReportDatasetId } from "@/lib/crm/reporting-contracts";
import { CRM_REPORT_DATASETS } from "@/lib/crm/reporting-query";

export const MAX_SAVED_REPORT_VIEWS = 20;
export const MAX_SAVED_REPORT_VIEW_NAME = 60;
export const MAX_SAVED_REPORT_VIEW_HREF = 2_000;

export type SavedCrmReportView = {
  id: string;
  name: string;
  href: string;
  dataset: CrmReportDatasetId;
  createdAt: string;
};

const validDataset = (value: unknown): value is CrmReportDatasetId =>
  typeof value === "string"
  && CRM_REPORT_DATASETS.includes(value as CrmReportDatasetId);

export function normalizeSavedReportViewName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_SAVED_REPORT_VIEW_NAME);
}
export function normalizeSavedReportViewHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SAVED_REPORT_VIEW_HREF) {
    return null;
  }
  try {
    const base = new URL("https://ops-portal.local/reporting");
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.pathname !== "/reporting") return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function parseSavedReportViews(raw: string | null): SavedCrmReportView[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const views: SavedCrmReportView[] = [];
    const ids = new Set<string>();
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.slice(0, 80) : "";
      const name = typeof row.name === "string" ? normalizeSavedReportViewName(row.name) : "";
      const href = normalizeSavedReportViewHref(row.href);
      const createdAt = typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt))
        ? row.createdAt
        : "";
      if (!id || ids.has(id) || !name || !href || !validDataset(row.dataset) || !createdAt) continue;
      ids.add(id);
      views.push({ id, name, href, dataset: row.dataset, createdAt });
      if (views.length === MAX_SAVED_REPORT_VIEWS) break;
    }
    return views;
  } catch {
    return [];
  }
}
