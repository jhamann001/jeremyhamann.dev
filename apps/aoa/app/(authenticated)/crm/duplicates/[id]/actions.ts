"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  CRM_DUPLICATE_CONFIRM_REASONS,
  CRM_DUPLICATE_REJECT_REASONS,
  updateCrmDuplicateReview,
  type CrmDuplicateDecision,
  type CrmDuplicateDecisionReason,
} from "@/lib/data/crm-duplicate-review";
import { invalidateCrmExplorerStatsCache } from "@/lib/data/crm-explorer";

function text(form: FormData, key: string, max = 128): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function saveCrmDuplicateDecision(form: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const candidateId = text(form, "candidateId");
  const rawDecision = text(form, "decision") as CrmDuplicateDecision;
  const decision = ["NEW", "NOT_DUPLICATE", "SNOOZED", "READY_FOR_FOLLOW_UP"].includes(rawDecision)
    ? rawDecision
    : null;
  const expectedReviewVersion = Number(text(form, "expectedReviewVersion", 12));
  const snoozeDate = text(form, "snoozedUntil", 10);
  const snoozedUntil = decision === "SNOOZED" && /^\d{4}-\d{2}-\d{2}$/.test(snoozeDate)
    ? new Date(`${snoozeDate}T23:59:59.999Z`)
    : null;
  const rawReason = text(form, "decisionReason", 48) as CrmDuplicateDecisionReason;
  const allowedReasons = decision === "READY_FOR_FOLLOW_UP"
    ? CRM_DUPLICATE_CONFIRM_REASONS
    : decision === "NOT_DUPLICATE"
      ? CRM_DUPLICATE_REJECT_REASONS
      : [];
  const decisionReason = allowedReasons.includes(rawReason as never) ? rawReason : null;
  const rawCanonicalIdentityId = text(form, "canonicalIdentityId", 128);
  const canonicalIdentityId = decision === "READY_FOR_FOLLOW_UP"
    && /^[A-Za-z0-9_-]{1,128}$/.test(rawCanonicalIdentityId)
    ? rawCanonicalIdentityId
    : null;
  const acceptContactIdentityConflict = decision === "READY_FOR_FOLLOW_UP"
    && form.get("acceptContactIdentityConflict") === "confirmed";
  const result = decision
    ? await updateCrmDuplicateReview({
        role: (session.user as { role?: string }).role ?? "VIEWER",
        email: session.user.email ?? null,
      }, {
        candidateId,
        expectedReviewVersion,
        decision,
        snoozedUntil,
        decisionReason,
        canonicalIdentityId,
        acceptContactIdentityConflict,
      })
    : "invalid";

  if (result === "updated") invalidateCrmExplorerStatsCache();
  revalidatePath("/crm");
  revalidatePath("/households");
  revalidatePath("/client-portrait");
  revalidatePath("/", "layout");
  revalidatePath(`/crm/duplicates/${encodeURIComponent(candidateId)}`);
  const message = result === "updated"
    ? decision === "NEW" ? "reopened" : "saved"
    : result;
  redirect(`/crm/duplicates/${encodeURIComponent(candidateId)}?reviewMessage=${message}#review-decision`);
}
