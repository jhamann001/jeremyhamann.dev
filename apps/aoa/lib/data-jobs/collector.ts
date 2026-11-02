import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { dataJobCollectionEnabled } from "@/lib/flags";
import { appWritesPaused } from "@/lib/maintenance";
import { DATA_JOB_PROVIDER_CONFIG, getDataJobs } from "./registry";
import { UNKNOWN_SCHEDULE, type JobDefinition, type JobObservation } from "./contracts";
import { claimCollection, finishCollection, jobEnvironment, readCollectionStates, saveObservation } from "./store";
import { collectN8nJob } from "./providers/n8n";
import { collectCloudSchedulerJob } from "./providers/cloud-scheduler";
import type { N8nJobObservation } from "./providers/n8n-coverage";
import { n8nIncrementalConfiguration } from "./provider-configuration";
import { collectApplicationEvidence } from "./application-evidence";
import { applicationSourceForJob } from "./application-evidence-association";
import { observationUnavailable } from "./evaluation";

function unavailable(job: JobDefinition, now: Date, code: string): JobObservation {
  return { jobId: job.id, observedAt: now.toISOString(), enabled: null, schedule: { ...UNKNOWN_SCHEDULE },
    runs: [], coverage: "unavailable", windowStart: new Date(now.getTime() - 86_400_000).toISOString(),
    windowEnd: now.toISOString(), code };
}

/** Runs only from the dedicated authenticated cron, never during a page read. */
export async function collectDataJobs() {
  const environment = jobEnvironment();
  if (!dataJobCollectionEnabled() || appWritesPaused() || !environment) return { skipped: true, busy: false, collected: 0, unavailable: 0 };
  const started = new Date();
  const token = await claimCollection(environment, started);
  if (!token) return { skipped: false, busy: true, collected: 0, unavailable: 0 };
  const config = DATA_JOB_PROVIDER_CONFIG[environment];
  const jobs = getDataJobs(environment);
  const proofJson = process.env.DATA_JOB_N8N_COVERAGE_EVIDENCE;
  const [states, applicationEvidence] = await Promise.all([
    proofJson ? readCollectionStates(environment) : Promise.resolve(new Map<string, unknown>()),
    jobs.some((job) => applicationSourceForJob(job)) ? collectApplicationEvidence(environment, started) : Promise.resolve([]),
  ]);
  let accessToken: string | null = null;
  if (process.env.DATA_JOB_CLOUD_READS === "1" && jobs.some((job) => job.provider === "cloud-scheduler")) {
    try {
      // ADC uses the deployed service account; no copied local/operator token.
      accessToken = await new ServiceAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"] }).getAccessToken() ?? null;
    } catch { /* static unavailable evidence below; never log credentials/errors */ }
  }
  const result = { skipped: false, busy: false, collected: 0, unavailable: 0 };
  let index = 0;
  const deadline = started.getTime() + 240_000;
  async function worker() {
    while (index < jobs.length) {
      const job = jobs[index++];
      if (appWritesPaused()) throw new Error("writes_paused");
      const now = new Date();
      let observation: N8nJobObservation;
      if (now.getTime() > deadline) observation = unavailable(job, now, "collector_budget_exceeded");
      else if (job.provider === "n8n") {
        const incremental = n8nIncrementalConfiguration(job, now, proofJson, states.get(job.id));
        observation = incremental.kind === "invalid" ? unavailable(job, now, "provider_capability_evidence_unverified") : process.env.DATA_JOB_N8N_API_KEY
          ? await collectN8nJob(job, now, { baseUrl: config.n8nOrigin, apiKey: process.env.DATA_JOB_N8N_API_KEY,
            timezone: process.env.DATA_JOB_N8N_TIMEZONE,
            ...(incremental.kind === "enabled" ? { incremental: incremental.config } : {}) })
          : unavailable(job, now, "provider_credentials_unconfigured");
      } else {
        observation = accessToken ? await collectCloudSchedulerJob(job, now, {
          projectId: config.gcpProject, location: config.region, accessToken, logView: process.env.DATA_JOB_SCHEDULER_LOG_VIEW,
        }) : unavailable(job, now, "provider_access_unconfigured");
      }
      const source = applicationSourceForJob(job);
      const application = source ? applicationEvidence.find((item) => item.sourceKey === source) ?? null : null;
      await saveObservation(job, observation, token!, new Date(), {
        ...(observation.n8nCheckpoint ? { checkpoint: observation.n8nCheckpoint } : {}),
        ...(application ? { applicationEvidence: application } : {}),
      });
      result.collected++;
      if (observationUnavailable(observation, new Date()) || (source && (!application || application.coverage === "unavailable"))) result.unavailable++;
    }
  }
  // Small fixed concurrency, bounded provider pages, and a fenced DB lease.
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, worker));
  if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("job_collection_failed");
  await finishCollection(environment, token, new Date());
  return result;
}
