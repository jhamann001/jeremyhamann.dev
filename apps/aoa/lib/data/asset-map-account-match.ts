// Asset-mapping ACCOUNT-grain matcher — Phase 2 slice P2.5. PURE: no DB, no I/O,
// no "server-only", no `next/*`, no @prisma/client VALUE import — every function is
// a total function of its inputs, unit-testable with plain values. The reconcile
// route (P2.2/P2.5, app/api/cron/asset-map-match) and the review read seam
// (lib/data/asset-map-review) call matchAccountOwners() per account; the seam
// persists the verdict through the P2.5 store (lib/data/asset-map-account-link).
// See docs/planning/asset-mapping/phase2-person-link-design.md §8 (§8.5 pipeline).
//
// THE VERDICT (design §8.2): there is NO deterministic account-number join
// pre-funding, so this is fuzzy name-matching — but on a CLEANER, NARROWER string
// (account_holder, usually one registration) against a TINY pool (the folder's
// resolved household members, 2–4 people), so precision is HIGHER than the folder
// pass. It REUSES the P2.1 brain wholesale — the same normalizer (multi-person
// split, suffix/entity strip), the same Jaccard scoring, the same conservative
// tiering constants — scoped to household members only.
//
// PII: this module only transforms names in memory. It NEVER logs.

import {
  normalizeName,
  scoreCandidate,
  tier,
  REVIEW_MIN,
  MAX_CANDIDATES,
  type ClientCandidate,
  type ScoreResult,
  type NormalizedName,
} from "@/lib/data/asset-map-match";
import type { MatchStatus } from "@/lib/data/asset-map-link";
import type { AccountOwnerRole } from "@/lib/data/asset-map-account-link";

/** One owner option for an account, binding a parsed holder-person to a household
 *  member with its score. `preSelected` = the matcher pre-checked it (a one-click
 *  confirm of the common case); `notInHousehold` = a D-j flag (§8.7) that the
 *  candidate is not a member of the resolved household — always false in P2.5
 *  because `members` is pre-scoped to the household (kept for forward-compat + the
 *  UI contract; the account-level D-j signal is AccountMatchResult.notInHousehold). */
export type AccountOwnerCandidate = {
  client: ClientCandidate;
  role: AccountOwnerRole;
  score: ScoreResult;
  /** Index of the parsed holder-person this candidate best matches. */
  personIndex: number;
  preSelected: boolean;
  notInHousehold: boolean;
};

/** The full per-account verdict — the account analog of MatchResult. */
export type AccountMatchResult = {
  status: MatchStatus;
  isEntity: boolean;
  /** Account-level confidence for display (0..1); null when nothing was scored. */
  confidence: number | null;
  /** The pre-selected owners — one per resolved holder-person (empty for an
   *  entity account, which pre-selects the "entity — no person" option). */
  owners: AccountOwnerCandidate[];
  /** Top-N ranked owner options (the multi-select checkboxes). */
  candidates: AccountOwnerCandidate[];
  /** D-j (§8.7): true when a parsed holder-person resolves to NO household member
   *  (a name present on the account that isn't in the resolved household). Forces
   *  the account off AUTO_LINKED — a human re-opens the folder match. */
  notInHousehold: boolean;
};

/** Per-parsed-person best member + the within-pool ambiguity yardstick. */
type PersonResolution = {
  personIndex: number;
  best: { client: ClientCandidate; score: ScoreResult } | null;
  /** Second-best member score for THIS person — the ambiguity margin input. */
  runnerUp: number;
};

/**
 * Resolve one account's `account_holder` → owning person(s), scoped to the folder's
 * resolved household members (design §8.5). Pure/deterministic (candidate order does
 * not matter — stable sort by score then clientSfId, the matchHousehold idiom).
 *
 *  1. normalizeName(accountHolder) — the P2.1 multi-person split + entity strip.
 *  2. Entity short-circuit (§8.5 step 2): an entity registration (trust/LLC/estate)
 *     is at most NEEDS_REVIEW (never AUTO — the P2.1 tier() entity rule, QC Fix 2),
 *     isEntity=true, pre-selects the "entity — no person" option (owners:[]). Any
 *     residual person parsed from the name is still LISTED as a candidate.
 *  3. Per-person resolution: scoreCandidate each parsed person against every member;
 *     keep the best DISTINCT member per person (a person ≥ REVIEW_MIN → an owner).
 *  4. Role (§1.3 subset): entity → ENTITY; ≥2 resolved distinct persons → JOINT each;
 *     exactly one → PRIMARY. CUSTODIAN/BENEFICIARY are never derived.
 *  5. Tier (reuse tier() over the small pool): AUTO_LINKED only when EVERY parsed
 *     person resolves unambiguously to a distinct member clearing AUTO_LINK_MIN with
 *     ≥ AUTO_LINK_MIN_SHARED_TOKENS shared tokens; otherwise NEEDS_REVIEW if any owner
 *     clears REVIEW_MIN; else UNMATCHED.
 *  6. D-j: a parsed person that resolves to no member sets result.notInHousehold and
 *     forces the account off AUTO_LINKED (→ NEEDS_REVIEW when something else resolved).
 */
export function matchAccountOwners(
  accountHolder: string | null,
  members: ClientCandidate[],
  opts: { corroboration?: (client: ClientCandidate) => number } = {},
): AccountMatchResult {
  const n: NormalizedName = normalizeName(accountHolder);
  const isEntity = n.isEntity;

  const scoreOne = (person: NormalizedName["people"][number], client: ClientCandidate): ScoreResult =>
    scoreCandidate({ people: [person], isEntity: false }, client, {
      corroboration: opts.corroboration?.(client),
    });

  // Per parsed person: best member (stable) + the second-best member score.
  const perPerson: PersonResolution[] = n.people.map((person, personIndex) => {
    const scored = members
      .map((client) => ({ client, score: scoreOne(person, client) }))
      .sort(
        (a, b) =>
          b.score.score - a.score.score ||
          a.client.clientSfId.localeCompare(b.client.clientSfId),
      );
    return {
      personIndex,
      best: scored[0] ?? null,
      runnerUp: scored[1]?.score.score ?? 0,
    };
  });

  // Resolve owners greedily, strongest first, one DISTINCT member per person.
  const resolvedByScore = perPerson
    .filter((p): p is PersonResolution & { best: NonNullable<PersonResolution["best"]> } =>
      p.best != null && p.best.score.score >= REVIEW_MIN,
    )
    .sort((a, b) => b.best.score.score - a.best.score.score);

  const takenClients = new Set<string>();
  const resolvedPersons = new Set<number>();
  const ownerBuild: { client: ClientCandidate; score: ScoreResult; personIndex: number; runnerUp: number }[] = [];
  for (const p of resolvedByScore) {
    if (takenClients.has(p.best.client.clientSfId)) continue;
    takenClients.add(p.best.client.clientSfId);
    resolvedPersons.add(p.personIndex);
    ownerBuild.push({
      client: p.best.client,
      score: p.best.score,
      personIndex: p.personIndex,
      runnerUp: p.runnerUp,
    });
  }

  const resolvedCount = ownerBuild.length;
  // A parsed holder-person that resolved to no member (D-j).
  const anyUnresolvedName =
    !isEntity && n.people.length > 0 && resolvedPersons.size < n.people.length;

  // Role — P2.5 subset (§1.3): entity → ENTITY; ≥2 → JOINT; 1 → PRIMARY.
  const personRole: AccountOwnerRole = resolvedCount >= 2 ? "JOINT" : "PRIMARY";

  // Tier.
  let status: MatchStatus;
  if (isEntity) {
    status = "NEEDS_REVIEW"; // entity is never AUTO (QC Fix 2); at most NEEDS_REVIEW
  } else if (resolvedCount === 0) {
    status = "UNMATCHED";
  } else {
    const allPersonsResolved = resolvedPersons.size === n.people.length;
    const everyOwnerAuto = ownerBuild.every(
      (o) =>
        tier({
          rawBest: o.score.score,
          confidence: o.score.score,
          runnerUpOtherHousehold: o.runnerUp,
          sharedTokens: o.score.sharedTokens,
          isEntity: false,
        }) === "AUTO_LINKED",
    );
    status =
      allPersonsResolved && everyOwnerAuto && !anyUnresolvedName
        ? "AUTO_LINKED"
        : "NEEDS_REVIEW";
  }

  // Account-level confidence for display: the weakest resolved owner (the account's
  // certainty is its weakest link), else the best member score seen, else null.
  const bestMemberScore = perPerson.reduce(
    (m, p) => (p.best && p.best.score.score > m ? p.best.score.score : m),
    0,
  );
  const confidence =
    resolvedCount > 0
      ? Math.min(...ownerBuild.map((o) => o.score.score))
      : bestMemberScore > 0
        ? bestMemberScore
        : null;

  // Pre-selected owners.
  const owners: AccountOwnerCandidate[] = isEntity
    ? [] // entity pre-selects the "entity — no person" option (no person rows)
    : ownerBuild.map((o) => ({
        client: o.client,
        role: personRole,
        score: o.score,
        personIndex: o.personIndex,
        preSelected: true,
        notInHousehold: false,
      }));

  // Ranked candidate options (the multi-select checkboxes): every member by its best
  // score against any parsed person, desc, top MAX_CANDIDATES. Residual candidates
  // are listed for an entity too (a trust with a clear grantor lets ops pick a person).
  const ownerClientIds = new Set(owners.map((o) => o.client.clientSfId));
  const bestPerMember = members.map((client) => {
    // Best score of this member against any parsed person (empty people → 0-score).
    let best: ScoreResult = { score: 0, nameSimilarity: 0, corroboration: 0, sharedTokens: 0 };
    let personIndex = -1;
    n.people.forEach((person, pi) => {
      const s = scoreOne(person, client);
      if (s.score > best.score) {
        best = s;
        personIndex = pi;
      }
    });
    return { client, score: best, personIndex };
  });
  const candidates: AccountOwnerCandidate[] = bestPerMember
    .filter((c) => c.score.score > 0)
    .sort(
      (a, b) =>
        b.score.score - a.score.score ||
        a.client.clientSfId.localeCompare(b.client.clientSfId),
    )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({
      client: c.client,
      role: (isEntity ? "PRIMARY" : personRole) as AccountOwnerRole,
      score: c.score,
      personIndex: c.personIndex,
      preSelected: ownerClientIds.has(c.client.clientSfId),
      notInHousehold: false,
    }));

  return {
    status,
    isEntity,
    confidence,
    owners,
    candidates,
    notInHousehold: anyUnresolvedName,
  };
}
