"use server";

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { reviewSchwabMappings, type SchwabMappingResult } from "@/lib/data/schwab-mappings";
import { canReviewSchwabMappings, parseSchwabMappingCsv } from "@/lib/schwab/review";

export async function reviewSchwabMappingAction(
  _previous: SchwabMappingResult | null, form: FormData,
): Promise<SchwabMappingResult> {
  const session = await auth();
  const identity = { role: (session?.user as { role?: string } | undefined)?.role, email: session?.user?.email };
  if (!canReviewSchwabMappings(identity.role) || !identity.email) return { status: "forbidden" };
  const save = form.get("intent") === "save";
  if (save && form.get("confirmed") !== "yes") return { status: "invalid" };
  let rows: unknown;
  if (save) {
    const raw = String(form.get("rows") ?? "");
    if (raw.length > 65_536) return { status: "invalid" };
    try { rows = JSON.parse(raw); } catch { return { status: "invalid" }; }
  } else {
    rows = parseSchwabMappingCsv(String(form.get("csv") ?? ""));
  }
  // Never log the form, database error, or account numbers.
  try {
    const result = await reviewSchwabMappings(identity, rows, save);
    if (result.status === "saved") revalidatePath("/crm/schwab");
    return result;
  } catch {
    return { status: "invalid" };
  }
}
