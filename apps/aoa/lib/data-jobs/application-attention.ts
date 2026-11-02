import type { JobSummary } from "./contracts";
import { isApplicationEvidenceStale } from "./application-evidence-validation";

/** Separate source-attention signal: never rewrites provider results or denominators. */
export function applicationAttention(job: Pick<JobSummary, "applicationEvidence" | "applicationEvidenceStale">, now: Date):
  { label: string; tone: "amber" | "red" } | null {
  const evidence = job.applicationEvidence;
  if (job.applicationEvidenceStale || (evidence && (evidence.coverage === "unavailable" || isApplicationEvidenceStale(evidence, now)))) {
    return { label: "Source unverified", tone: "amber" };
  }
  if (!evidence) return null;
  if (evidence.status === "FAILED") return { label: "Application failed", tone: "red" };
  if (evidence.status === "PARTIAL") return { label: "Partial source result", tone: "amber" };
  if (evidence.freshness.status === "STALE") return { label: "Source data stale", tone: "amber" };
  if (evidence.code === "sweep_progress_stale") return { label: "Sweep delayed", tone: "amber" };
  if (evidence.status === "UNKNOWN") return { label: "Source unverified", tone: "amber" };
  return null;
}
