"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { confirmCrmParentOverride } from "@/lib/data/crm-parent-resolution";

function text(form: FormData, key: string, max = 128): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function confirmCrmParentMapping(form: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
  const childCrmId = text(form, "childCrmId");
  const exceptionId = text(form, "exceptionId");
  const outcome = await confirmCrmParentOverride(identity, {
    exceptionId,
    childCrmId,
    parentCrmId: text(form, "parentCrmId"),
  });

  revalidatePath(`/crm/${encodeURIComponent(childCrmId)}`);
  revalidatePath("/crm");
  revalidatePath("/review-queue");
  revalidatePath("/", "layout");
  const message = outcome === "saved" ? "saved" : "failed";
  redirect(`/crm/${encodeURIComponent(childCrmId)}?resolutionException=${encodeURIComponent(exceptionId)}&resolutionMessage=${message}#resolve-parent-mapping`);
}
