import { parseCrmNavigationRequest } from "@/components/crm/crm-navigation-query";
import { parseWindowPageParams } from "./window-page";

export function parseCrmWindowRequest(params: URLSearchParams, duplicates: boolean) {
  const window = parseWindowPageParams(params);
  const filters = new URLSearchParams(params);
  for (const key of ["page", "pageSize", "loaded", "snapshot", "restoreRows"]) filters.delete(key);
  return { window, filters: parseCrmNavigationRequest(filters, duplicates).filters };
}
