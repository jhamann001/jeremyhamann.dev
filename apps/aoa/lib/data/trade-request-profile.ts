import type { RiskProfile } from "./types";
import type { TradeRequestSummary } from "./trade-requests";

export type TradeProfileRequestStatus =
  | "Pending Review"
  | "Needs Info"
  | "Pending Current Asset Liquidation"
  | "Approved"
  | "Rejected"
  | "Completed";

export type TradeProfileTradeType =
  | "Initial Funding"
  | "Rebalance"
  | "Cash Deposit"
  | "Raise Cash"
  | "Liquidate";

export type TradeProfileInstruction = {
  key: string;
  label: string;
  value: string;
};

export type TradeProfileAccountScope = {
  accountId: string | null;
  accountNumber: string;
  accountType: string | null;
};

/**
 * Future machine-API projection for the Client Portrait profile. The deployed
 * development preview feeds this shape with synthetic fixtures; production
 * must eventually receive the same narrow projection from the Trade Request
 * app rather than the full request, notes, execution plan, or audit log.
 */
export type TradeProfileSourceRecord = {
  requestId: string;
  clientIds: string[];
  status: TradeProfileRequestStatus;
  tradeType: TradeProfileTradeType;
  decidedAt: string;
  riskScore: number | null;
  instructions: TradeProfileInstruction[];
  accounts?: TradeProfileAccountScope[];
  /** Explicit lineage is the only safe way for a changed instruction to win. */
  supersedesRequestId?: string | null;
};

export type TradeProfileSource = {
  requestId: string;
  status: "Approved" | "Completed";
  tradeType: "Initial Funding" | "Rebalance";
  decidedAt: string;
  scope: "client" | "household";
};

export type DerivedTradeInstruction = TradeProfileInstruction & {
  sourceRequestId: string;
  decidedAt: string;
};

export type TradeInstructionConflict = {
  key: string;
  label: string;
  options: Array<{
    value: string;
    sourceRequestId: string;
    decidedAt: string;
  }>;
};

export type DerivedTradeRisk = {
  profile: RiskProfile;
  sourceRequestId: string;
  decidedAt: string;
  previousScore: number | null;
};

export type TradeRequestProfile = {
  state:
    | "ready"
    | "none"
    | "conflict"
    | "household_review"
    | "account_variation"
    | "account_review";
  instructions: DerivedTradeInstruction[];
  instructionConflicts: TradeInstructionConflict[];
  risk: DerivedTradeRisk | null;
  sources: TradeProfileSource[];
  excludedRequestCount: number;
  accountReview?: TradeRequestAccountReview;
};

export type KnownTradeProfileAccount = {
  accountId: string;
  accountNumber: string;
  accountType: string | null;
  status: string | null;
};

export type TradeProfileCandidate = {
  requestId: string;
  status: "Approved" | "Completed";
  tradeType: "Initial Funding" | "Rebalance";
  decidedAt: string;
  riskScore: number | null;
  instructions: TradeProfileInstruction[];
  scope: "client" | "household";
};

export type ConfirmedTradeProfileSource = {
  requestId: string;
  reviewedRequestIds: string[];
};

export type TradeProfileSelectionState = {
  requestId: string;
  state: "confirmed" | "stale" | "unavailable";
};

export type AccountTradeRequestProfile = {
  accountId: string;
  accountNumber: string;
  accountType: string | null;
  status: string | null;
  /** `scope_review`: an unconfirmed household request names this account. */
  state: "ready" | "conflict" | "missing" | "scope_review";
  instructions: DerivedTradeInstruction[];
  instructionConflicts: TradeInstructionConflict[];
  risk: DerivedTradeRisk | null;
  sources: TradeProfileSource[];
  candidates: TradeProfileCandidate[];
  selection: TradeProfileSelectionState | null;
};

export type TradeProfileAccountWarning = {
  kind: "unmatched_request_account" | "inactive_request_account" | "missing_request_scope";
  requestId: string;
  accountNumber: string | null;
};

export type TradeRequestAccountReview = {
  state: "consistent" | "varies" | "review";
  riskVaries: boolean;
  accounts: AccountTradeRequestProfile[];
  warnings: TradeProfileAccountWarning[];
};

const REQUEST_STATUSES: readonly TradeProfileRequestStatus[] = [
  "Pending Review",
  "Needs Info",
  "Pending Current Asset Liquidation",
  "Approved",
  "Rejected",
  "Completed",
];
const REQUEST_TYPES: readonly TradeProfileTradeType[] = [
  "Initial Funding",
  "Rebalance",
  "Cash Deposit",
  "Raise Cash",
  "Liquidate",
];

function isRequestStatus(value: string | null): value is TradeProfileRequestStatus {
  return value != null && REQUEST_STATUSES.includes(value as TradeProfileRequestStatus);
}

function isTradeType(value: string | null): value is TradeProfileTradeType {
  return value != null && REQUEST_TYPES.includes(value as TradeProfileTradeType);
}

/**
 * Adapt the defensive machine-feed shape into the pure profile derivation
 * contract. During a rolling deployment, an approved allocation row without
 * the new `profile` payload is ignored rather than shown as an approved source
 * with blank facts.
 */
export function tradeProfileRecordsFromSummaries(
  requests: TradeRequestSummary[],
): TradeProfileSourceRecord[] {
  return requests.flatMap((request) => {
    if (!request.id || !isRequestStatus(request.status) || !isTradeType(request.tradeType)) {
      return [];
    }
    const eligible =
      (request.status === "Approved" || request.status === "Completed") &&
      (request.tradeType === "Initial Funding" || request.tradeType === "Rebalance");
    if (eligible && !request.profile) return [];

    return [
      {
        requestId: request.id,
        clientIds: request.clientIds,
        status: request.status,
        tradeType: request.tradeType,
        decidedAt:
          request.profile?.decidedAt ?? request.updatedAt ?? request.createdAt ?? "",
        riskScore: request.profile?.riskScore ?? null,
        instructions: request.profile?.instructions ?? [],
        accounts: request.accounts.map((account) => ({
          accountId: account.accountId ?? null,
          accountNumber: account.accountNumber ?? "",
          accountType: account.accountType,
        })),
      },
    ];
  });
}

function isActiveAccount(status: string | null): boolean {
  const normalized = status?.trim().toUpperCase() ?? "";
  return normalized !== "CLOSED" && normalized !== "RESTRICTED";
}

function maskAccountNumber(accountNumber: string): string {
  const value = accountNumber.trim();
  if (!value) return "Account unavailable";
  if (value.startsWith("****")) return value;
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

function accountProfileSignature(profile: AccountTradeRequestProfile): string {
  return JSON.stringify({
    risk: profile.risk?.profile.score ?? null,
    instructions: profile.instructions.map((instruction) => [
      instruction.key,
      normalizedInstruction(instruction.value),
    ]),
  });
}

/**
 * Account-aware production derivation. A request may apply to one or several
 * Apex accounts. Differences across accounts are displayed as intentional
 * variation; contradictions within one account, missing sources, and unmatched
 * account keys require review and never collapse into a client-level answer.
 *
 * A household request (one naming more than one client) never applies on its
 * own. It becomes a candidate on each account it names that this client holds,
 * and that account stays in scope review until a person confirms the request
 * for it. Accounts it names that this client does not hold belong to another
 * household member, so they are left out here rather than reported as
 * unmatched.
 */
export function deriveAccountScopedTradeRequestProfile(
  clientId: string,
  records: TradeProfileSourceRecord[],
  knownAccounts: KnownTradeProfileAccount[],
  confirmedSources: Readonly<Record<string, ConfirmedTradeProfileSource>> = {},
): TradeRequestProfile {
  const related = records.filter((record) => record.clientIds.includes(clientId));
  const approved = related.filter(
    (record) =>
      APPROVED_STATUSES.has(record.status) && PROFILE_TRADE_TYPES.has(record.tradeType),
  );

  const allKnownById = new Map(knownAccounts.map((account) => [account.accountId, account]));
  const activeAccounts = knownAccounts.filter((account) => isActiveAccount(account.status));
  const warnings: TradeProfileAccountWarning[] = [];
  const eligible = approved.filter(
    (record) =>
      !isHouseholdRecord(record) ||
      !record.accounts?.length ||
      record.accounts.some((scope) => scope.accountId != null && allKnownById.has(scope.accountId)),
  );
  const excludedRequestCount = related.length - approved.length;

  if (activeAccounts.length === 0 && eligible.length === 0) {
    return {
      state: "none",
      instructions: [],
      instructionConflicts: [],
      risk: null,
      sources: [],
      excludedRequestCount,
    };
  }

  for (const record of eligible) {
    if (!record.accounts || record.accounts.length === 0) {
      warnings.push({ kind: "missing_request_scope", requestId: record.requestId, accountNumber: null });
      continue;
    }
    for (const scope of record.accounts) {
      const known = scope.accountId ? allKnownById.get(scope.accountId) : undefined;
      if (!known) {
        if (isHouseholdRecord(record)) continue;
        warnings.push({
          kind: "unmatched_request_account",
          requestId: record.requestId,
          accountNumber: scope.accountNumber || null,
        });
      } else if (!isActiveAccount(known.status)) {
        warnings.push({
          kind: "inactive_request_account",
          requestId: record.requestId,
          accountNumber: maskAccountNumber(known.accountNumber),
        });
      }
    }
  }

  const accounts: AccountTradeRequestProfile[] = activeAccounts.map((account) => {
    const scopedRecords = eligible.filter((record) =>
      record.accounts?.some((scope) => scope.accountId === account.accountId),
    );
    const candidates: TradeProfileCandidate[] = scopedRecords
      .map((record) => ({
        requestId: record.requestId,
        status: record.status as TradeProfileCandidate["status"],
        tradeType: record.tradeType as TradeProfileCandidate["tradeType"],
        decidedAt: record.decidedAt,
        riskScore: record.riskScore,
        instructions: record.instructions,
        scope: recordScope(record),
      }))
      .sort((a, b) => decidedAtMillis(b.decidedAt) - decidedAtMillis(a.decidedAt));
    const confirmed = confirmedSources[account.accountId];
    const selectedRecord = confirmed
      ? scopedRecords.find((record) => record.requestId === confirmed.requestId)
      : undefined;
    const unreviewedRecordExists = confirmed
      ? scopedRecords.some(
          (record) => !confirmed.reviewedRequestIds.includes(record.requestId),
        )
      : false;
    const selection: TradeProfileSelectionState | null = confirmed
      ? {
          requestId: confirmed.requestId,
          state: !selectedRecord
            ? "unavailable"
            : unreviewedRecordExists
              ? "stale"
              : "confirmed",
        }
      : null;
    if (scopedRecords.length === 0) {
      return {
        accountId: account.accountId,
        accountNumber: maskAccountNumber(account.accountNumber),
        accountType: account.accountType,
        status: account.status,
        state: "missing" as const,
        instructions: [],
        instructionConflicts: [],
        risk: null,
        sources: [],
        candidates,
        selection,
      };
    }

    const confirmedRecord = selection?.state === "confirmed" ? selectedRecord : undefined;
    if (!confirmedRecord && scopedRecords.some(isHouseholdRecord)) {
      return {
        accountId: account.accountId,
        accountNumber: maskAccountNumber(account.accountNumber),
        accountType: account.accountType,
        status: account.status,
        state: "scope_review" as const,
        instructions: [],
        instructionConflicts: [],
        risk: null,
        sources: scopedRecords.map((record) => sourceFor(record, recordScope(record))),
        candidates,
        selection,
      };
    }

    // A confirmed household request applies to this account as the client's
    // own; its source keeps the household label.
    const profile = deriveTradeRequestProfile(
      clientId,
      confirmedRecord ? [{ ...confirmedRecord, clientIds: [clientId] }] : scopedRecords,
    );
    return {
      accountId: account.accountId,
      accountNumber: maskAccountNumber(account.accountNumber),
      accountType: account.accountType,
      status: account.status,
      state: profile.state === "conflict" ? ("conflict" as const) : ("ready" as const),
      instructions: profile.instructions,
      instructionConflicts: profile.instructionConflicts,
      risk: profile.risk,
      sources: confirmedRecord
        ? profile.sources.map((source) => ({ ...source, scope: recordScope(confirmedRecord) }))
        : profile.sources,
      candidates,
      selection,
    };
  });

  const readyAccounts = accounts.filter((account) => account.state === "ready");
  const signatures = new Set(readyAccounts.map(accountProfileSignature));
  const riskScores = new Set(
    readyAccounts.map((account) => account.risk?.profile.score ?? null),
  );
  const hasReviewIssue =
    warnings.length > 0 ||
    accounts.some(
      (account) =>
        account.state !== "ready" ||
        (account.selection != null && account.selection.state !== "confirmed"),
    );
  const reviewState: TradeRequestAccountReview["state"] = hasReviewIssue
    ? "review"
    : signatures.size > 1
      ? "varies"
      : "consistent";
  const accountReview: TradeRequestAccountReview = {
    state: reviewState,
    riskVaries: riskScores.size > 1,
    accounts,
    warnings,
  };

  if (reviewState === "consistent" && readyAccounts[0]) {
    const first = readyAccounts[0];
    const sources = Array.from(
      new Map(
        accounts.flatMap((account) => account.sources).map((source) => [source.requestId, source]),
      ).values(),
    );
    return {
      state: "ready",
      instructions: first.instructions,
      instructionConflicts: [],
      risk: first.risk,
      sources,
      excludedRequestCount,
      accountReview,
    };
  }

  return {
    state: reviewState === "varies" ? "account_variation" : "account_review",
    instructions: [],
    instructionConflicts: [],
    risk: null,
    sources: Array.from(
      new Map(
        accounts.flatMap((account) => account.sources).map((source) => [source.requestId, source]),
      ).values(),
    ),
    excludedRequestCount,
    accountReview,
  };
}

export function deriveTradeRequestProfileFromSummaries(
  clientId: string,
  requests: TradeRequestSummary[],
): TradeRequestProfile {
  return deriveTradeRequestProfile(
    clientId,
    tradeProfileRecordsFromSummaries(requests),
  );
}

export function deriveAccountScopedTradeRequestProfileFromSummaries(
  clientId: string,
  requests: TradeRequestSummary[],
  knownAccounts: KnownTradeProfileAccount[],
  confirmedSources: Readonly<Record<string, ConfirmedTradeProfileSource>> = {},
): TradeRequestProfile {
  return deriveAccountScopedTradeRequestProfile(
    clientId,
    tradeProfileRecordsFromSummaries(requests),
    knownAccounts,
    confirmedSources,
  );
}

const APPROVED_STATUSES = new Set<TradeProfileRequestStatus>([
  "Approved",
  "Completed",
]);
const PROFILE_TRADE_TYPES = new Set<TradeProfileTradeType>([
  "Initial Funding",
  "Rebalance",
]);

function isRiskScore(score: number | null): score is number {
  return score != null && Number.isInteger(score) && score >= 1 && score <= 25;
}

function toleranceForScore(score: number): string {
  if (score <= 5) return "Conservative";
  if (score <= 10) return "Moderately conservative";
  if (score <= 15) return "Moderate";
  if (score <= 20) return "Growth";
  return "Aggressive";
}

function normalizedInstruction(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function decidedAtMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function isHouseholdRecord(record: TradeProfileSourceRecord): boolean {
  return record.clientIds.length > 1;
}

function recordScope(record: TradeProfileSourceRecord): TradeProfileSource["scope"] {
  return isHouseholdRecord(record) ? "household" : "client";
}

function sourceFor(
  record: TradeProfileSourceRecord,
  scope: TradeProfileSource["scope"],
): TradeProfileSource {
  return {
    requestId: record.requestId,
    status: record.status as TradeProfileSource["status"],
    tradeType: record.tradeType as TradeProfileSource["tradeType"],
    decidedAt: record.decidedAt,
    scope,
  };
}

function explicitlySupersedes(
  newerId: string,
  olderId: string,
  recordsById: Map<string, TradeProfileSourceRecord>,
): boolean {
  const visited = new Set<string>();
  let cursor = recordsById.get(newerId)?.supersedesRequestId ?? null;

  while (cursor && !visited.has(cursor)) {
    if (cursor === olderId) return true;
    visited.add(cursor);
    cursor = recordsById.get(cursor)?.supersedesRequestId ?? null;
  }
  return false;
}

/**
 * Derive a conservative current profile from request history.
 *
 * - Pending/rejected/non-allocation requests never populate the profile.
 * - A household request never silently becomes a client instruction.
 * - The newest client risk score is current, while a prior score is retained as
 *   change context.
 * - Different approved instruction values remain a conflict unless the newer
 *   request explicitly supersedes the older request.
 */
export function deriveTradeRequestProfile(
  clientId: string,
  records: TradeProfileSourceRecord[],
): TradeRequestProfile {
  const related = records.filter((record) => record.clientIds.includes(clientId));
  const eligible = related
    .filter(
      (record) =>
        APPROVED_STATUSES.has(record.status) &&
        PROFILE_TRADE_TYPES.has(record.tradeType),
    )
    .sort((a, b) => decidedAtMillis(b.decidedAt) - decidedAtMillis(a.decidedAt));
  const excludedRequestCount = related.length - eligible.length;
  const clientRecords = eligible.filter(
    (record) => record.clientIds.length === 1 && record.clientIds[0] === clientId,
  );
  const householdRecords = eligible.filter((record) => record.clientIds.length > 1);

  // Any approved multi-client request creates unresolved scope. Even when a
  // separate client-only request exists, the household record may apply to this
  // person; ignoring it would be the same kind of silent inference we are
  // explicitly avoiding. A future source contract can clear this with explicit
  // per-client/household scope or supersession lineage.
  if (householdRecords.length > 0) {
    return {
      state: "household_review",
      instructions: [],
      instructionConflicts: [],
      risk: null,
      sources: [
        ...clientRecords.map((record) => sourceFor(record, "client")),
        ...householdRecords.map((record) => sourceFor(record, "household")),
      ],
      excludedRequestCount,
    };
  }

  if (clientRecords.length === 0) {
    return {
      state: "none",
      instructions: [],
      instructionConflicts: [],
      risk: null,
      sources: [],
      excludedRequestCount,
    };
  }

  const recordsById = new Map(clientRecords.map((record) => [record.requestId, record]));
  const observations = new Map<
    string,
    Array<TradeProfileInstruction & { sourceRequestId: string; decidedAt: string }>
  >();

  for (const record of clientRecords) {
    for (const instruction of record.instructions) {
      const key = instruction.key.trim();
      const value = instruction.value.trim();
      if (!key || !value) continue;
      const current = observations.get(key) ?? [];
      current.push({
        ...instruction,
        key,
        value,
        sourceRequestId: record.requestId,
        decidedAt: record.decidedAt,
      });
      observations.set(key, current);
    }
  }

  const instructions: DerivedTradeInstruction[] = [];
  const instructionConflicts: TradeInstructionConflict[] = [];

  for (const rows of observations.values()) {
    rows.sort((a, b) => decidedAtMillis(b.decidedAt) - decidedAtMillis(a.decidedAt));
    const latest = rows[0];
    const unresolved = rows.filter(
      (row) =>
        normalizedInstruction(row.value) !== normalizedInstruction(latest.value) &&
        (row.sourceRequestId === latest.sourceRequestId ||
          !explicitlySupersedes(
            latest.sourceRequestId,
            row.sourceRequestId,
            recordsById,
          )),
    );

    if (unresolved.length > 0) {
      const unique = [latest, ...unresolved].filter(
        (row, index, all) =>
          all.findIndex(
            (candidate) =>
              normalizedInstruction(candidate.value) ===
              normalizedInstruction(row.value),
          ) === index,
      );
      instructionConflicts.push({
        key: latest.key,
        label: latest.label,
        options: unique.map((row) => ({
          value: row.value,
          sourceRequestId: row.sourceRequestId,
          decidedAt: row.decidedAt,
        })),
      });
      continue;
    }

    instructions.push(latest);
  }

  instructions.sort((a, b) => a.label.localeCompare(b.label));
  instructionConflicts.sort((a, b) => a.label.localeCompare(b.label));

  const riskRecords = clientRecords.filter((record) => isRiskScore(record.riskScore));
  const latestRisk = riskRecords[0];
  const priorRisk = latestRisk
    ? riskRecords.find((record) => record.riskScore !== latestRisk.riskScore)
    : undefined;
  const risk = latestRisk
    ? {
        profile: {
          score: latestRisk.riskScore as number,
          tolerance: toleranceForScore(latestRisk.riskScore as number),
          capacity: "Not provided by Trade Request",
          change: priorRisk
            ? `${(latestRisk.riskScore as number) - (priorRisk.riskScore as number) > 0 ? "+" : ""}${(latestRisk.riskScore as number) - (priorRisk.riskScore as number)} vs prior approved score`
            : "Initial approved score",
        },
        sourceRequestId: latestRisk.requestId,
        decidedAt: latestRisk.decidedAt,
        previousScore: priorRisk?.riskScore ?? null,
      }
    : null;

  return {
    state: instructionConflicts.length > 0 ? "conflict" : "ready",
    instructions,
    instructionConflicts,
    risk,
    sources: clientRecords.map((record) => sourceFor(record, "client")),
    excludedRequestCount,
  };
}
