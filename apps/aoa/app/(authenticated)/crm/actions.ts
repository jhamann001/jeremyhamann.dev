"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  flagCrmContactDuplicateCandidate,
  flagCrmDuplicateCandidate,
} from "@/lib/data/crm-duplicate-review";
import { invalidateCrmExplorerStatsCache } from "@/lib/data/crm-explorer";

function value(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim().slice(0, 64) : "";
}

export async function flagPossibleHouseholdDuplicate(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const result = await flagCrmDuplicateCandidate({
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  }, {
    leftCrmId: value(formData, "leftCrmId"),
    rightCrmId: value(formData, "rightCrmId"),
  });

  if ("candidateId" in result) {
    invalidateCrmExplorerStatsCache();
    revalidatePath("/crm");
    redirect(`/crm/duplicates/${encodeURIComponent(result.candidateId)}?reviewMessage=flagged`);
  }
  redirect(`/crm?flagMessage=${encodeURIComponent(result.status)}#flag-duplicate`);
}

export async function flagPossibleContactDuplicate(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const result = await flagCrmContactDuplicateCandidate({
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  }, {
    leftCrmId: value(formData, "leftCrmId"),
    rightCrmId: value(formData, "rightCrmId"),
  });

  if ("candidateId" in result) {
    invalidateCrmExplorerStatsCache();
    revalidatePath("/crm");
    redirect(`/crm/duplicates/${encodeURIComponent(result.candidateId)}?reviewMessage=flagged`);
  }
  redirect(`/crm?contactFlagMessage=${encodeURIComponent(result.status)}#flag-contact-duplicate`);
}
