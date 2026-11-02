"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import {
  SUBMIT_COPY, canCloneToNewRequest, canEditAndResubmit, cloneRequestRoute, editRequestRoute,
} from "@/lib/trade-requests/new-request-submit";
import { useRequestDetailFrame } from "./RequestDetailDialog";

/**
 * The advisor's actions in the request's footer: Edit & Resubmit on a Needs
 * Info request (AC-46), Clone to New Request on a Rejected one (AC-47).
 * Reviewers never see them; their status actions are a separate slot entry.
 */
export function ResubmitCloneActions({ role }: { role: string }) {
  const router = useRouter();
  const { request } = useRequestDetailFrame();
  if (canEditAndResubmit(role, request.status)) {
    return (
      <Button variant="primary" title={SUBMIT_COPY.editAndResubmitTitle} onClick={() => router.push(editRequestRoute(request.id))}>
        {SUBMIT_COPY.editAndResubmit}
      </Button>
    );
  }
  if (canCloneToNewRequest(role, request.status)) {
    return (
      <Button variant="primary" title={SUBMIT_COPY.cloneToNewTitle} onClick={() => router.push(cloneRequestRoute(request.id))}>
        {SUBMIT_COPY.cloneToNew}
      </Button>
    );
  }
  return null;
}
