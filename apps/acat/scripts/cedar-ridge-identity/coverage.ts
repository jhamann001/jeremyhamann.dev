import { directoryFreshnessPolicy } from "../../src/lib/client-identity-policy";
import { ownerCoverageAssumptionSchema, type Evidence } from "./contracts";
import { validateEvidence } from "./match";

export function sourceCoverage(evidence: Evidence) {
  return { upstreamFreshness: evidence.upstreamFreshness,
    ...(evidence.ownerCoverageAssumption ? { ownerCoverageAssumption: evidence.ownerCoverageAssumption } : {}) };
}

/** Accepting coverage records an assumption; it never manufactures ingestion proof. */
export function acceptCoverage(input: unknown, assumption: unknown): Evidence {
  const evidence = validateEvidence(input);
  if (evidence.upstreamFreshness !== "unknown") throw new Error("COVERAGE_ASSUMPTION_REQUIRES_UNKNOWN_SOURCE");
  if (evidence.ownerCoverageAssumption) throw new Error("COVERAGE_ASSUMPTION_ALREADY_RECORDED");
  return validateEvidence({ ...evidence, ownerCoverageAssumption: ownerCoverageAssumptionSchema.parse(assumption) });
}

export function assertSourcePolicy(evidence: Evidence): void {
  if (evidence.upstreamFreshness === "stale") throw new Error("SOURCE_FRESHNESS_STALE");
  if (evidence.upstreamFreshness === "verified") return;
  if (directoryFreshnessPolicy() !== "FETCH_SUCCESS") throw new Error("SOURCE_FRESHNESS_NOT_VERIFIED");
  if (!ownerCoverageAssumptionSchema.safeParse(evidence.ownerCoverageAssumption).success) throw new Error("OWNER_COVERAGE_ASSUMPTION_REQUIRED");
}

export function coverageSummary(coverage: ReturnType<typeof sourceCoverage> | undefined) {
  return { upstreamFreshness: coverage?.upstreamFreshness ?? "not-recorded",
    coverageBasis: coverage?.upstreamFreshness === "verified" ? "upstream-verified"
      : coverage?.upstreamFreshness === "stale" ? "stale-rejected"
      : coverage?.ownerCoverageAssumption ? "owner-assumed-not-upstream-verified" : "unverified-no-accepted-assumption",
    ownerCoverageAssumption: coverage?.ownerCoverageAssumption ?? null,
    rowApprovalGranted: false };
}
