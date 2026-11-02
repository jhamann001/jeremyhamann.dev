// Asset-mapping "matching brain" — Phase 2 slice P2.1. PURE, no DB, no I/O, no
// "server-only" import — every function here is a total function of its inputs
// so it is fully unit-testable with plain values. The reconcile route (P2.2,
// app/api/cron/asset-map-match) is the ONLY consumer; it reads the live mapping
// households + candidate clients from the DB, calls matchHousehold() per
// household, and persists the verdict through the P2.0 link-store seam
// (lib/data/asset-map-link). See docs/planning/asset-mapping/
// phase2-person-link-design.md (§3 candidate strategies, §3.4 score, §4.2 tiers).
//
// THE VERDICT THIS SLICE IMPLEMENTS (design §1): there is NO deterministic join.
// The mapping household carries a free-text `client_name` (often two people:
// "Alfreda + Reynold Hayes") and the AOA side has real mirror.client rows. So this
// is fuzzy name-matching → a confidence score → a CONSERVATIVE tier, feeding a
// human review queue (P2.3). Names are the primary signal; custodian/DTCC are
// tie-breaker corroboration only.
//
// PII: this module only transforms names in memory. It NEVER logs. The route
// that calls it logs counts + a sanitized run id ONLY, never a name.

import type { MatchStatus } from "@/lib/data/asset-map-link";

// ---------------------------------------------------------------------------
// Tunable policy constants (design §3.4 / §4.2). the owner dials these against real
// match rates once the Phase-1 pull is live (design D-c). They are the whole
// policy surface — the arithmetic below is deliberately simple so tuning these
// is the lever, not a rewrite.
// ---------------------------------------------------------------------------

/** AUTO_LINKED floor: a candidate must clear this near-exact bar to be linked
 *  WITHOUT a human. High on purpose — a mis-auto-link silently binds a stranger's
 *  assets to a client, so the machine only acts on a near-certain name match. */
export const AUTO_LINK_MIN = 0.95;

/** AUTO_LINKED also requires at least this many SHARED name tokens between the
 *  winning household person and the client (surname AND a given name — not a lone
 *  surname/given). A single-token overlap can score Jaccard 1.0 against a
 *  degenerate one-token client row (or an entity residual like "Smith Family
 *  Trust" → {smith}) and would otherwise auto-link the WRONG client; capping such
 *  a match at NEEDS_REVIEW kills that false positive (QC Fix 1). */
export const AUTO_LINK_MIN_SHARED_TOKENS = 2;

/** NEEDS_REVIEW floor: below AUTO_LINK_MIN but at/above this → queue for a human
 *  with the candidate pre-filled. Below this → UNMATCHED (no suggestion). */
export const REVIEW_MIN = 0.6;

/** Ambiguity guard: to AUTO_LINK, the best candidate must beat the best candidate
 *  from ANY OTHER household by at least this margin. Two plausible-but-different
 *  households → NEVER auto-link (design §4.2 "never downgraded"/human wins) — send
 *  to review. (Two clients in the SAME household — spouses — are NOT ambiguity;
 *  they reinforce via cohesion below.) */
export const AMBIGUITY_MARGIN = 0.05;

/** Cohesion bonus: when ≥2 people in a mapping household independently resolve to
 *  clients in the SAME AOA household, that co-resolution is the strongest fuzzy
 *  signal available (design §3.2 / §3.4) — nudge the winning score up (capped at
 *  1.0). A single-person mapping household can never earn this. */
export const COHESION_BONUS = 0.15;

/** Corroboration nudge weight: custodian/DTCC agreement is a tie-breaker only
 *  (design §3.3), never a primary signal — so it can only add a sliver. The
 *  caller passes a 0..1 corroboration strength; this scales it. */
export const CORROBORATION_BONUS = 0.05;

/** How many ranked candidates to carry for the review queue (design §5). */
export const MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Normalization (design §3.2)
// ---------------------------------------------------------------------------

/** One resolved person parsed out of a (possibly multi-person) client_name. */
export type NormalizedPerson = {
  /** First name token (lowercased, punctuation-free), or null if unknown. */
  first: string | null;
  /** Last name token, or null when the source gave only one token. */
  last: string | null;
  /** Every name token for this person — the set scored by Jaccard. */
  tokens: string[];
};

/** The structured result of normalizing a free-text client_name. */
export type NormalizedName = {
  /** The individual people parsed out (design: split "A + B" / "A & B" /
   *  "A and B" / "A, B"; shared surname carried forward). */
  people: NormalizedPerson[];
  /** True when trust/entity boilerplate ("Trust", "LLC", "TTEE"…) was present —
   *  a weaker person signal; surfaced for the reviewer, does not block matching. */
  isEntity: boolean;
};

// Person delimiters: "+", "&", " and " (word-bounded), and ",". Applied after
// entity-token stripping so "Smith Family Trust" is not split on nothing.
//
// KNOWN LIMITATION ("Last, First"): the comma delimiter treats "Smith, John" as
// TWO people ["smith"] + ["john"] rather than one "Norene Pruitt". Each becomes a
// lone single-token person, so the shared-token AUTO_LINK gate (≥2, QC Fix 1)
// caps it at NEEDS_REVIEW/UNMATCHED — a false NEGATIVE (a human resolves it),
// NEVER a wrong binding. Accepted for P2.1; revisit if "Last, First" proves
// common in real client_name data (design D-c calibration).
const PERSON_SPLIT = /\s*(?:\+|&|,|\band\b)\s*/i;

// Suffixes/honorifics dropped from a person's tokens. Plain "v" is intentionally
// NOT here (it collides with a middle initial); "ii".."iv" cover the common set.
const DROP_TOKENS = new Set([
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
]);

// Entity/trust boilerplate. Presence flips isEntity=true; the tokens are removed
// so the residual person name(s) can still be scored.
const ENTITY_TOKENS = new Set([
  "trust",
  "trustee",
  "ttee",
  "tr",
  "revocable",
  "irrevocable",
  "living",
  "family",
  "estate",
  "foundation",
  "llc",
  "inc",
  "ltd",
  "llp",
  "lp",
  "utma",
  "ugma",
  "custodian",
  "fbo",
  "ira",
  "roth",
  "dtd",
  "uad",
  "uta",
  "the",
]);

/** Lowercase, strip punctuation, collapse whitespace, split to tokens. Shared by
 *  client_name parsing and candidate (client / household name) tokenization so
 *  both sides normalize identically. Apostrophes are removed (O'Brien → obrien);
 *  hyphens become spaces (Smith-Jones → smith jones). */
function cleanTokens(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  return String(raw)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Normalize a free-text mapping `client_name` into structured people.
 *
 * Steps (design §3.2): detect + strip entity/trust boilerplate and
 * suffixes/honorifics; split on multi-person delimiters; carry a shared surname
 * forward onto single-token people ("Alfreda + Reynold Hayes" → "Alfreda Bernier" +
 * "Reynold Hayes"); drop punctuation/case/whitespace. People that reduce to
 * nothing (pure boilerplate) are dropped; the result can legitimately be empty
 * (→ UNMATCHED downstream).
 */
export function normalizeName(raw: string | null | undefined): NormalizedName {
  if (raw == null || String(raw).trim() === "") return { people: [], isEntity: false };

  let isEntity = false;

  // Split into raw person segments FIRST (on the delimiters), then clean each —
  // splitting on the cleaned single string would lose the "&"/"+"/"," markers
  // that punctuation-stripping erases.
  const segments = String(raw).split(PERSON_SPLIT);

  const perSegmentTokens: string[][] = [];
  for (const seg of segments) {
    const tokens = cleanTokens(seg).filter((t) => {
      if (ENTITY_TOKENS.has(t)) {
        isEntity = true;
        return false;
      }
      return !DROP_TOKENS.has(t);
    });
    if (tokens.length > 0) perSegmentTokens.push(tokens);
  }

  // Shared-surname carry: the reference surname is the last token of the LAST
  // multi-token segment ("Reynold Hayes" → "hayes"). Append it to any
  // single-token segment ("Alfreda" → "adam bernier").
  const refSurname =
    [...perSegmentTokens].reverse().find((t) => t.length >= 2)?.at(-1) ?? null;

  const people: NormalizedPerson[] = perSegmentTokens.map((tokens) => {
    const withSurname =
      tokens.length === 1 && refSurname && refSurname !== tokens[0]
        ? [tokens[0], refSurname]
        : tokens;
    return {
      first: withSurname[0] ?? null,
      last: withSurname.length >= 2 ? withSurname[withSurname.length - 1] : null,
      tokens: withSurname,
    };
  });

  return { people, isEntity };
}

// ---------------------------------------------------------------------------
// Scoring (design §3.4). Metric: token-set Jaccard similarity —
// |A ∩ B| / |A ∪ B| over the two token sets. Chosen (over trigram) because names
// are short and word-order-independent ("Norene Pruitt" ⇄ "Smith John"), and the
// set form makes a full name-token match cleanly 1.0 and a surname-only overlap
// a predictable fraction. Duplicate tokens collapse (a Set).
// ---------------------------------------------------------------------------

/** A candidate AOA client to score a mapping household against. Shaped as the
 *  reconcile route reads it from mirror.client. */
export type ClientCandidate = {
  clientSfId: string;
  householdSfId: string | null;
  cedarRidgeUserId: string | null;
  firstName: string | null;
  lastName: string | null;
};

/** The per-candidate score breakdown (surfaced in the review queue's "why"). */
export type ScoreResult = {
  /** Final 0..1 confidence for this (mapping household → client) pairing. */
  score: number;
  /** The name-only Jaccard component (the primary signal). */
  nameSimilarity: number;
  /** The corroboration strength actually applied (0..1), tie-breaker only. */
  corroboration: number;
  /** SHARED name-token count of the BEST-matching person (the one that produced
   *  nameSimilarity). Gates AUTO_LINK (≥ AUTO_LINK_MIN_SHARED_TOKENS) so a lone
   *  single-token overlap can never auto-link (QC Fix 1). */
  sharedTokens: number;
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Intersection count + Jaccard of two token sets in one pass. */
function overlap(a: Set<string>, b: Set<string>): { sim: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { sim: 0, shared: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return { sim: union === 0 ? 0 : inter / union, shared: inter };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  return overlap(a, b).sim;
}

/** Token set for an AOA client — first + last name tokens, normalized the same
 *  way as the mapping side. */
function clientTokenSet(client: ClientCandidate): Set<string> {
  return new Set([
    ...cleanTokens(client.firstName),
    ...cleanTokens(client.lastName),
  ]);
}

/** Per-person {Jaccard, shared-token count} of a normalized mapping household
 *  against one client token set — one entry per mapping person, in people order. */
function personOverlaps(
  name: NormalizedName,
  clientTokens: Set<string>,
): { sim: number; shared: number }[] {
  return name.people.map((p) => overlap(new Set(p.tokens), clientTokens));
}

/** The best person overlap (highest Jaccard; ties keep the higher shared count). */
function bestOverlap(
  overlaps: { sim: number; shared: number }[],
): { sim: number; shared: number } {
  return overlaps.reduce(
    (best, o) => (o.sim > best.sim || (o.sim === best.sim && o.shared > best.shared) ? o : best),
    { sim: 0, shared: 0 },
  );
}

/**
 * Score one mapping household (already normalized) against one AOA client.
 * `nameSimilarity` = the BEST per-person Jaccard (the household's closest person
 * to this client); `sharedTokens` = that person's shared-token count.
 * `corroboration` (0..1, default 0) is a custodian/DTCC-style tie-breaker the
 * caller supplies; it can only NUDGE (CORROBORATION_BONUS), never carry a match
 * on its own (design §3.3). Names are primary.
 */
export function scoreCandidate(
  name: NormalizedName,
  client: ClientCandidate,
  opts: { corroboration?: number } = {},
): ScoreResult {
  const best = bestOverlap(personOverlaps(name, clientTokenSet(client)));
  const corroboration = clamp01(opts.corroboration ?? 0);
  const score = clamp01(best.sim + CORROBORATION_BONUS * corroboration);
  return { score, nameSimilarity: best.sim, corroboration, sharedTokens: best.shared };
}

/**
 * Score a mapping household against an AOA `household.name` free-text string
 * (design §3.2 "and against mirror.household.name"). Coarser than the per-client
 * score — a household name may be just a surname ("Hayes") or both spouses —
 * so it is a corroborator for the queue, not the primary path (the route matches
 * on clients, which carry the household id). Jaccard of ALL mapping-people tokens
 * against the household-name token set.
 */
export function scoreHouseholdName(name: NormalizedName, householdName: string | null): number {
  const peopleTokens = new Set(name.people.flatMap((p) => p.tokens));
  return jaccard(peopleTokens, new Set(cleanTokens(householdName)));
}

// ---------------------------------------------------------------------------
// Tiering (design §4.2) — the CONSERVATIVE auto-link policy.
// ---------------------------------------------------------------------------

/** Input to the tier decision. The AUTO_LINK conjunction reads all five:
 *  - `rawBest`      — winner's RAW name score (NO cohesion); drives the ambiguity
 *                     comparison so cohesion can never widen the margin (QC Fix 3).
 *  - `confidence`   — cohesion-lifted confidence; drives the ≥ AUTO_LINK_MIN /
 *                     ≥ REVIEW_MIN band gates.
 *  - `runnerUpOtherHousehold` — best RAW score from a DIFFERENT household (null if
 *                     none); the ambiguity yardstick.
 *  - `sharedTokens` — shared name-token count of the winning match (≥2 to auto).
 *  - `isEntity`     — a trust/LLC/etc. household never auto-links (QC Fix 2). */
export type TierInput = {
  rawBest: number;
  confidence: number;
  runnerUpOtherHousehold: number | null;
  sharedTokens: number;
  isEntity: boolean;
};

/**
 * Map a score picture to a MatchStatus. CONSERVATIVE by design.
 *
 * AUTO_LINKED requires the FULL conjunction (all must hold):
 *   1. raw-unambiguous — no OTHER household within AMBIGUITY_MARGIN of the
 *      winner's RAW name score (cohesion excluded from this comparison, QC Fix 3);
 *   2. confidence ≥ AUTO_LINK_MIN — the cohesion-lifted score clears the bar;
 *   3. sharedTokens ≥ AUTO_LINK_MIN_SHARED_TOKENS — surname AND given overlap,
 *      not a lone single-token match (QC Fix 1);
 *   4. NOT an entity — a trust/LLC isn't a person (QC Fix 2).
 * Anything plausible (confidence ≥ REVIEW_MIN) that fails the conjunction →
 * NEEDS_REVIEW. Below REVIEW_MIN → UNMATCHED. NEVER auto-links on ambiguity, a
 * single-token overlap, or an entity.
 */
export function tier(input: TierInput): MatchStatus {
  const { rawBest, confidence, runnerUpOtherHousehold, sharedTokens, isEntity } = input;
  const rawUnambiguous =
    runnerUpOtherHousehold == null || rawBest - runnerUpOtherHousehold >= AMBIGUITY_MARGIN;
  const autoLinkable =
    confidence >= AUTO_LINK_MIN &&
    rawUnambiguous &&
    sharedTokens >= AUTO_LINK_MIN_SHARED_TOKENS &&
    !isEntity;
  if (autoLinkable) return "AUTO_LINKED";
  if (confidence >= REVIEW_MIN) return "NEEDS_REVIEW";
  return "UNMATCHED";
}

// ---------------------------------------------------------------------------
// Orchestration — normalize is done by the caller; this composes score → cohesion
// → tier over a candidate set and returns the persist-ready verdict.
// ---------------------------------------------------------------------------

/** One ranked candidate for the review queue. */
export type CandidateScore = {
  client: ClientCandidate;
  score: ScoreResult;
};

/** The full verdict for a mapping household — exactly what the route persists via
 *  setLink (ids only when AUTO_LINKED) plus the ranked candidates for the queue. */
export type MatchResult = {
  status: MatchStatus;
  /** Best final confidence; null when there was nothing to score. */
  confidence: number | null;
  /** Resolved link ids — populated ONLY when status is AUTO_LINKED (design §4.2:
   *  NEEDS_REVIEW/UNMATCHED leave ids NULL for the human to fill). */
  clientSfId: string | null;
  householdSfId: string | null;
  cedarRidgeUserId: string | null;
  /** Top MAX_CANDIDATES, ranked desc — the review-queue suggestions. */
  candidates: CandidateScore[];
};

const UNMATCHED_EMPTY: MatchResult = {
  status: "UNMATCHED",
  confidence: null,
  clientSfId: null,
  householdSfId: null,
  cedarRidgeUserId: null,
  candidates: [],
};

/** Group key for ambiguity: the AOA household, or the client itself when it has
 *  no household id (a lone client is its own "household" for ambiguity purposes). */
function groupKey(c: ClientCandidate): string {
  return c.householdSfId ?? `client:${c.clientSfId}`;
}

/**
 * Match ONE normalized mapping household against the full candidate client set.
 * Pure: same inputs → same verdict (candidate order does not matter — ranking is
 * stable by score then clientSfId).
 *
 * Pipeline (design §4.2 step 2–3):
 *  1. Score every client (best-person name Jaccard + shared-token count +
 *     optional per-client corroboration).
 *  2. Rank; the winner is the top-scoring client.
 *  3. Cohesion: if the mapping household has ≥2 people and ≥2 DISTINCT of them
 *     resolve (≥ REVIEW_MIN) to clients in the WINNER's AOA household, add
 *     COHESION_BONUS to the winner's CONFIDENCE (capped 1.0). Spouses reinforce.
 *     Cohesion lifts ONLY the band gate (≥ AUTO_LINK_MIN), NOT the ambiguity
 *     comparison (QC Fix 3).
 *  4. Ambiguity: the runner-up is the best RAW score from a DIFFERENT household.
 *  5. tier() → status: AUTO_LINK needs raw-unambiguous AND confidence ≥ bar AND
 *     ≥2 shared tokens (QC Fix 1) AND not an entity (QC Fix 2). Resolved ids are
 *     attached ONLY on AUTO_LINKED.
 *
 * P2.3 NOTE (not built here): the ranked `candidates` are computed but the P2.0
 * link store has no candidates column, so the reconcile route (P2.2) discards
 * them and persists only the winning verdict. The P2.3 review queue will either
 * recompute matchHousehold live on read OR extend the store then — a P2.3
 * decision, deliberately deferred.
 */
export function matchHousehold(
  name: NormalizedName,
  clients: ClientCandidate[],
  opts: { corroboration?: (client: ClientCandidate) => number } = {},
): MatchResult {
  if (name.people.length === 0 || clients.length === 0) return UNMATCHED_EMPTY;

  // 1. Score + retain per-person overlaps (needed for cohesion) per client.
  const scored = clients.map((client) => {
    const clientTokens = clientTokenSet(client);
    const perPerson = personOverlaps(name, clientTokens);
    const best = bestOverlap(perPerson);
    const corroboration = clamp01(opts.corroboration?.(client) ?? 0);
    const score = clamp01(best.sim + CORROBORATION_BONUS * corroboration);
    return {
      client,
      perPerson,
      result: {
        score,
        nameSimilarity: best.sim,
        corroboration,
        sharedTokens: best.shared,
      } as ScoreResult,
    };
  });

  // 2. Rank desc by score; break ties by clientSfId so the verdict is stable.
  scored.sort(
    (a, b) =>
      b.result.score - a.result.score || a.client.clientSfId.localeCompare(b.client.clientSfId),
  );

  const top = scored[0];
  const winnerKey = groupKey(top.client);

  // 3. Cohesion — distinct mapping-person indices that clear REVIEW_MIN against
  //    ANY client in the winner's household. Lifts CONFIDENCE only (not the raw
  //    ambiguity comparison, QC Fix 3).
  let cohesionApplies = false;
  if (name.people.length >= 2) {
    const matchedPeople = new Set<number>();
    for (const s of scored) {
      if (groupKey(s.client) !== winnerKey) continue;
      s.perPerson.forEach((o, personIdx) => {
        if (o.sim >= REVIEW_MIN) matchedPeople.add(personIdx);
      });
    }
    cohesionApplies = matchedPeople.size >= 2;
  }
  const rawBest = top.result.score;
  const finalConfidence = clamp01(rawBest + (cohesionApplies ? COHESION_BONUS : 0));

  // 4. Runner-up = best RAW score from a DIFFERENT household (spouses don't count).
  const runnerUpOtherHousehold =
    scored.find((s) => groupKey(s.client) !== winnerKey)?.result.score ?? null;

  // 5. Tier — the full AUTO_LINK conjunction (raw-unambiguous ∧ confidence bar ∧
  //    ≥2 shared tokens ∧ not entity).
  const status = tier({
    rawBest,
    confidence: finalConfidence,
    runnerUpOtherHousehold,
    sharedTokens: top.result.sharedTokens,
    isEntity: name.isEntity,
  });

  const candidates: CandidateScore[] = scored
    .slice(0, MAX_CANDIDATES)
    .map((s) => ({ client: s.client, score: s.result }));

  const link = status === "AUTO_LINKED";
  return {
    status,
    confidence: finalConfidence,
    clientSfId: link ? top.client.clientSfId : null,
    householdSfId: link ? top.client.householdSfId : null,
    cedarRidgeUserId: link ? top.client.cedarRidgeUserId : null,
    candidates,
  };
}
