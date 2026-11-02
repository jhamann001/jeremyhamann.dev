"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  createOperationsFeeRequest,
  searchOperationsFeeClientOptions,
  transitionOperationsFeeRequest,
  type OperationsFeeClientOption,
} from "@/lib/data/operations-fee-requests";
import { operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { parseFeeSubmissionKey } from "@/lib/operations/fee-submission";
import {
  FeeRequestValidationError,
  parseFeeRequestWorkflowForm,
  parseOperationsFeeRequestForm,
} from "@/lib/operations/fee-request";

export async function searchOperationsFeeClients(query: string): Promise<OperationsFeeClientOption[]> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "VIEWER";
  if (
    !session?.user?.email
    || !operationsFeeRequestsPreviewEnabled()
    || !canAccessOperationsTools(role)
  ) return [];
  try {
    return await searchOperationsFeeClientOptions(
      { role, email: session.user.email },
      query,
    );
  } catch {
    console.error("[operations-fee-request] client_search_failed");
    return [];
  }
}

export async function submitOperationsFeeRequest(form: FormData): Promise<void> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "VIEWER";
  if (!session?.user?.email || !operationsFeeRequestsPreviewEnabled() || !canAccessOperationsTools(role)) {
    redirect("/");
  }

  let requestId: string;
  try {
    const input = parseOperationsFeeRequestForm(form);
    const submissionKey = parseFeeSubmissionKey(form.get("submissionKey"));
    requestId = await createOperationsFeeRequest({ role, email: session.user.email }, input, submissionKey);
  } catch (error) {
    if (!(error instanceof FeeRequestValidationError)) {
      console.error("[operations-fee-request] submission_failed");
    }
    redirect("/operations/fee-requests?message=submission-failed");
  }

  revalidatePath("/operations/fee-requests");
  redirect(`/operations/fee-requests?message=submitted&request=${encodeURIComponent(requestId)}#request-${encodeURIComponent(requestId)}`);
}

export async function updateOperationsFeeRequest(form: FormData): Promise<void> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "VIEWER";
  if (!session?.user?.email || !operationsFeeRequestsPreviewEnabled() || !canAccessOperationsTools(role)) {
    redirect("/");
  }

  let message = "workflow-failed";
  let selectedRequestId: string | null = null;
  try {
    const input = parseFeeRequestWorkflowForm(form);
    selectedRequestId = input.requestId;
    const result = await transitionOperationsFeeRequest({ role, email: session.user.email }, input);
    message = result === "updated" ? "workflow-updated" : result === "conflict" ? "workflow-conflict" : "workflow-invalid";
  } catch (error) {
    if (!(error instanceof FeeRequestValidationError)) {
      console.error("[operations-fee-request] workflow_failed");
    }
  }

  revalidatePath("/operations/fee-requests");
  // Preserve an older linked request after review without reflecting unparsed
  // form values. The destination performs its normal authentication/RLS check.
  const selected = selectedRequestId
    ? `&request=${encodeURIComponent(selectedRequestId)}#request-${encodeURIComponent(selectedRequestId)}`
    : "";
  redirect(`/operations/fee-requests?message=${message}${selected}`);
}
