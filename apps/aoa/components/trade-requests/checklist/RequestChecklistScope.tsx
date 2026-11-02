"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { checklistTabLabel } from "@/lib/trade-requests/checklist-view";
import type { TradeRequest } from "@/lib/trade-requests/request-types";
import { ChecklistTab } from "./ChecklistTab";
import { useRequestChecklist } from "./use-request-checklist";

/** The frame's `checklist` slot (RequestDetailDialog / RequestDetailRoute). */
export type RequestChecklistSlot = { label: string; content: ReactNode };

export type RequestChecklistSummary = {
  /** The load has settled; until then, and after a failed load, every item counts as unchecked. */
  loaded: boolean;
  checkedCount: number;
  uncheckedCount: number;
  total: number;
};

const SummaryContext = createContext<RequestChecklistSummary | null>(null);

/**
 * The open request's checklist state for content rendered inside a
 * RequestChecklistScope, such as the frame's `actions` slot (the approve
 * warning counts `uncheckedCount`). Null outside a scope.
 */
export function useRequestChecklistSummary(): RequestChecklistSummary | null {
  return useContext(SummaryContext);
}

/**
 * Owns one request's checklist while it is open and hands the frame its slot:
 *
 *   <RequestChecklistScope request={request} role={role}>
 *     {(checklist) => <RequestDetailDialog … checklist={checklist} actions={…} />}
 *   </RequestChecklistScope>
 *
 * `role` is the viewer's AOA role: ADMIN and OPERATIONS edit an undecided
 * request, ADVISOR reads, and Approved, Rejected or Completed locks it.
 * Unmounting (closing the request) discards unsaved state; reopening reloads.
 */
export function RequestChecklistScope({ request, role, children }: {
  request: Pick<TradeRequest, "id" | "status">;
  role: string;
  children: (checklist: RequestChecklistSlot) => ReactNode;
}) {
  const checklist = useRequestChecklist(request, role);
  const { loaded, checkedCount, uncheckedCount, total } = checklist;
  const summary = useMemo(
    () => ({ loaded, checkedCount, uncheckedCount, total }),
    [loaded, checkedCount, uncheckedCount, total],
  );
  return (
    <SummaryContext.Provider value={summary}>
      {children({ label: checklistTabLabel(uncheckedCount), content: <ChecklistTab checklist={checklist} /> })}
    </SummaryContext.Provider>
  );
}
