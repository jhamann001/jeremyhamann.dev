import type { CustodianContactMethod } from "@/lib/types";

interface ContactUpdate {
  contactMethod?: CustodianContactMethod | null;
  contactDetails?: string | null;
  contactEmail?: string | null;
}

/** Apply only after validating the paired contact fields. */
export function normalizeCustodianContactUpdate<T extends ContactUpdate>(
  update: T,
  existing: { contactMethod: CustodianContactMethod | null }
): T {
  const normalized = { ...update };
  if (update.contactMethod === "EMAIL" || update.contactMethod === null) {
    // Email remains available to older consumers; clearing Contact must not
    // resurrect the legacy address through the editor's fallback.
    normalized.contactEmail = update.contactDetails ?? null;
  } else if (
    update.contactMethod === undefined &&
    update.contactEmail !== undefined &&
    existing.contactMethod === "EMAIL"
  ) {
    // Older API clients may still update just contactEmail.
    normalized.contactDetails = update.contactEmail;
  }
  // Switching to Phone/Portal/Other preserves the legacy secondary email.
  return normalized;
}
