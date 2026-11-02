type ReviewSelection = {
  state: "confirmed" | "stale" | "unavailable";
} | null;

export function tradeProfileReviewStartsOpen(
  accounts: readonly { selection: ReviewSelection }[],
): boolean {
  return accounts.some((account) => account.selection?.state !== "confirmed");
}
