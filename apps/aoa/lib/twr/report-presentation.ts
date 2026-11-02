// Pure presentation rules shared by both client-facing performance reports.
// Keep these separate from the React components so sign/masking behavior is
// directly testable without duplicating policy in multiple report layouts.

/** Green for positive, red for negative, neutral for zero. */
export function signedMetricTone(n: number): "pos" | "neg" | undefined {
  return n > 0 ? "pos" : n < 0 ? "neg" : undefined;
}

/** Fixed-length last-four mask for a custodian account number. */
export function maskedAccountNumber(accountNumber: string | null | undefined): string {
  const normalized = accountNumber?.trim();
  return normalized ? `••••${normalized.slice(-4)}` : "••••";
}

export const PRESENTATION_ROUNDING_DISCLOSURE =
  "Displayed figures are rounded and may not sum exactly.";
