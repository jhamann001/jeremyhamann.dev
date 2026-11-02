"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { reviewQueueEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { canManageReviewQueue } from "@/lib/data/review-queue";
import { snoozeUntilForBusinessDate } from "@/lib/data/review-queue-snooze";
import { compareAndSaveReviewQueueWorkflow } from "@/lib/data/review-queue-workflow";
import type { ReviewQueueStatus } from "@prisma/client";

const STATUSES = new Set<ReviewQueueStatus>(["NEW", "IN_REVIEW", "RESOLVED", "SNOOZED"]);

async function sessionIdentity(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

function text(form: FormData, key: string, max: number): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeReturnPath(form: FormData): string {
  const candidate = text(form, "returnTo", 1000);
  try {
    const parsed = new URL(candidate, "https://ops-portal.local");
    if (parsed.origin !== "https://ops-portal.local" || parsed.pathname !== "/review-queue") {
      return "/review-queue";
    }
    parsed.searchParams.delete("queueMessage");
    const search = parsed.searchParams.toString();
    return search ? `/review-queue?${search}` : "/review-queue";
  } catch {
    return "/review-queue";
  }
}

function conflictHref(returnTo: string): string {
  const separator = returnTo.includes("?") ? "&" : "?";
  return `${returnTo}${separator}queueMessage=conflict`;
}

export async function updateReviewQueueItem(form: FormData): Promise<void> {
  const identity = await sessionIdentity();
  if (!reviewQueueEnabled() || !canManageReviewQueue(identity.role)) return;

  const id = text(form, "itemId", 128);
  const expectedUpdatedAtInput = text(form, "expectedUpdatedAt", 40);
  const expectedUpdatedAt = new Date(expectedUpdatedAtInput);
  const status = text(form, "status", 32) as ReviewQueueStatus;
  const ownerInput = text(form, "assignedTo", 320).toLowerCase();
  const note = text(form, "resolutionNote", 1000);
  const snoozeInput = text(form, "snoozedUntil", 32);
  const returnTo = safeReturnPath(form);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    !STATUSES.has(status) ||
    Number.isNaN(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== expectedUpdatedAtInput
  ) return;
  const assignedTo = ownerInput || null;
  if (assignedTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignedTo)) return;

  let snoozedUntil: Date | null = null;
  if (status === "SNOOZED") {
    snoozedUntil = snoozeUntilForBusinessDate(snoozeInput);
    const max = Date.now() + 366 * 86_400_000;
    if (!snoozedUntil || snoozedUntil.getTime() <= Date.now() || snoozedUntil.getTime() > max) return;
  }

  const outcome = await withUserScope(identity, async (tx) => {
    let validatedOwner = assignedTo;
    if (assignedTo) {
      const assignee = await tx.user.findFirst({
        where: {
          email: { equals: assignedTo, mode: "insensitive" },
          role: { in: ["ADMIN", "OPERATIONS"] },
        },
        select: { email: true },
      });
      if (!assignee?.email) return "invalid" as const;
      validatedOwner = assignee.email.toLowerCase();
    }
    return compareAndSaveReviewQueueWorkflow(tx, identity, {
      id,
      expectedUpdatedAt,
      status,
      assignedTo: validatedOwner,
      note,
      snoozedUntil,
    });
  });

  revalidatePath("/review-queue");
  if (outcome === "conflict") redirect(conflictHref(returnTo));
}
