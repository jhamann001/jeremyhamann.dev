"use client";

import { RequestDetailRoute, type RequestDetailRouteProps } from "@/components/trade-requests/detail/RequestDetailRoute";
import { RequestChecklistScope } from "./RequestChecklistScope";

/** The direct-link request detail with its Pre-approval Checklist tab. */
export function RequestDetailRouteWithChecklist({ role, ...props }: Omit<RequestDetailRouteProps, "checklist"> & { role: string }) {
  return (
    <RequestChecklistScope request={props.request} role={role}>
      {(checklist) => <RequestDetailRoute {...props} checklist={checklist} />}
    </RequestChecklistScope>
  );
}
