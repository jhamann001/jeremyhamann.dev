import type { JobDefinition } from "./contracts";
import type { ApplicationSourceKey } from "./application-evidence-types";

/**
 * Explicit reviewed source associations, not execution joins. Dev Scheduler
 * discovery is still blocked, so no unverified dev definition is invented.
 */
export function applicationSourceForJob(
  job: Pick<JobDefinition, "id" | "environment" | "provider">,
): ApplicationSourceKey | null {
  if (job.environment !== "prod" || job.provider !== "cloud-scheduler") return null;
  if (["prod-account-aum", "prod-account-aum-stale-only", "prod-account-aum-health"].includes(job.id)) {
    return "ACCOUNT_AUM";
  }
  return job.id === "prod-review-queue" ? "REVIEW_QUEUE" : null;
}
