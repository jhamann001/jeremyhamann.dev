import type { TradeRequestProfile } from "./trade-request-profile";

export const TRADE_REVIEW_TYPES = [
  "TRADE_PROFILE_MULTIPLE_UNCONFIRMED",
  "TRADE_PROFILE_CONFLICT",
  "TRADE_PROFILE_SELECTION_STALE",
  "TRADE_PROFILE_SELECTION_UNAVAILABLE",
  "TRADE_PROFILE_UNMATCHED_ACCOUNT",
  "TRADE_PROFILE_INACTIVE_ACCOUNT",
  "TRADE_PROFILE_MISSING_ACCOUNT_SCOPE",
  "TRADE_PROFILE_HOUSEHOLD_SCOPE",
  "TRADE_PROFILE_ACCOUNT_VARIATION",
] as const;

export type TradeReviewType = (typeof TRADE_REVIEW_TYPES)[number];

export type DetectedTradeReview = {
  type: TradeReviewType;
  discriminator: string;
  summary: string;
  snapshot: {
    accountLast4?: string;
    candidateCount?: number;
    requestCount?: number;
    accountCount?: number;
  };
};

function last4(masked: string | null | undefined): string | undefined {
  const value = masked?.trim() ?? "";
  const match = value.match(/([A-Za-z0-9]{4})$/);
  return match?.[1];
}

/**
 * Convert the already-redacted, account-aware profile result into stable queue
 * signals. No client id, account ULID, full account number, instructions, risk
 * score or free text enters the returned snapshot.
 */
export function detectTradeProfileReviews(
  profile: TradeRequestProfile,
): DetectedTradeReview[] {
  const detected: DetectedTradeReview[] = [];

  if (profile.state === "household_review") {
    detected.push({
      type: "TRADE_PROFILE_HOUSEHOLD_SCOPE",
      discriminator: "household",
      summary: "Approved household instructions need client-level scope review",
      snapshot: { requestCount: profile.sources.length },
    });
  }

  if (
    profile.state === "account_variation" ||
    profile.accountReview?.state === "varies"
  ) {
    detected.push({
      type: "TRADE_PROFILE_ACCOUNT_VARIATION",
      discriminator: "account-variation",
      summary: "Approved risk profiles or instructions differ across this client's accounts",
      snapshot: { accountCount: profile.accountReview?.accounts.length ?? 0 },
    });
  }

  for (const warning of profile.accountReview?.warnings ?? []) {
    const warningType = {
      unmatched_request_account: "TRADE_PROFILE_UNMATCHED_ACCOUNT",
      inactive_request_account: "TRADE_PROFILE_INACTIVE_ACCOUNT",
      missing_request_scope: "TRADE_PROFILE_MISSING_ACCOUNT_SCOPE",
    }[warning.kind] as TradeReviewType;
    const summary = {
      unmatched_request_account: "An approved request account does not match Apex",
      inactive_request_account: "An approved request points to a closed or restricted account",
      missing_request_scope: "An approved request is missing account scope",
    }[warning.kind];
    detected.push({
      type: warningType,
      discriminator: `${warning.kind}:${warning.requestId}:${warning.accountNumber ?? "none"}`,
      summary,
      snapshot: { accountLast4: last4(warning.accountNumber), requestCount: 1 },
    });
  }

  for (const account of profile.accountReview?.accounts ?? []) {
    const accountDiscriminator = account.accountId;
    // An account waiting on a household request's confirmation gets only the household-scope item below: confirming
    // that request is the same decision as picking among the candidates, so a second item would ask it twice.
    if (!account.selection && account.candidates.length > 1 && account.state !== "scope_review") {
      detected.push({
        type: "TRADE_PROFILE_MULTIPLE_UNCONFIRMED",
        discriminator: accountDiscriminator,
        summary: "Multiple approved requests need a confirmed instruction source",
        snapshot: {
          accountLast4: last4(account.accountNumber),
          candidateCount: account.candidates.length,
        },
      });
    }
    if (account.state === "scope_review" && !account.selection) {
      detected.push({
        type: "TRADE_PROFILE_HOUSEHOLD_SCOPE",
        discriminator: accountDiscriminator,
        summary: "An approved household request needs confirmation for this account",
        snapshot: {
          accountLast4: last4(account.accountNumber),
          candidateCount: account.candidates.length,
        },
      });
    }
    if (account.state === "conflict" && !account.selection) {
      detected.push({
        type: "TRADE_PROFILE_CONFLICT",
        discriminator: accountDiscriminator,
        summary: "Approved instructions conflict for this account",
        snapshot: {
          accountLast4: last4(account.accountNumber),
          candidateCount: account.candidates.length,
        },
      });
    }
    if (account.selection?.state === "stale") {
      detected.push({
        type: "TRADE_PROFILE_SELECTION_STALE",
        discriminator: accountDiscriminator,
        summary: "A newer approved request needs human review",
        snapshot: {
          accountLast4: last4(account.accountNumber),
          candidateCount: account.candidates.length,
        },
      });
    }
    if (account.selection?.state === "unavailable") {
      detected.push({
        type: "TRADE_PROFILE_SELECTION_UNAVAILABLE",
        discriminator: accountDiscriminator,
        summary: "The confirmed request is no longer available",
        snapshot: {
          accountLast4: last4(account.accountNumber),
          candidateCount: account.candidates.length,
        },
      });
    }
  }

  return detected;
}
