import "server-only";
import type { JobDefinition, JobObservation, JobRun } from "@/lib/data-jobs/contracts";
import { instant, ProviderReadError, providerErrorCode, readProviderJson, record, safeId } from "./http";

/** Reviewed per-instance/per-workflow evidence, not an API-support guess or an activation flag. */
export type N8nCoverageEvidence = {
  schemaVersion: 1;
  proofId: string;
  environment: "dev" | "prod";
  providerId: string;
  deployedVersion: string;
  verifiedAt: string;
  expiresAt: string;
  startFiltersVerified: true;
  pendingStatusFiltersVerified: true;
  metadataOnlyDetailVerified: true;
  /** Verified success/error metadata retention, including count-based pruning. */
  retentionHours: number;
  /** A reviewed complete pending set at this boundary; an empty list alone is not proof. */
  seed: { observedAt: string; pendingExecutionIds: string[]; complete: true };
};

/** Persist atomically with observed runs, fenced by the same collector lease. */
export type N8nCollectionState = {
  schemaVersion: 1;
  proofId: string;
  startedCoverageFrom: string;
  startedCoverageThrough: string;
  pendingExecutionIds: string[];
  /** A contradicted retention proof cannot silently become valid again. */
  invalidatedAt?: string | null;
};
export type N8nIncrementalConfig = { evidence: N8nCoverageEvidence; state: N8nCollectionState | null };
export type N8nJobObservation = JobObservation & { n8nCheckpoint?: N8nCollectionState };

const DAY_MS = 86_400_000;
const OVERLAP_MS = 60_000;
// 150 IDs of at most 128 characters keep the complete checkpoint below 24 KB.
export const N8N_MAX_PENDING_EXECUTIONS = 150;
export const N8N_MAX_EVIDENCE_BYTES = 64_000;
export const N8N_MAX_CHECKPOINT_BYTES = 24_000;
const MAX_REQUESTS = 32;
const MAX_COLLECTION_MS = 40_000;
const PAGE_SIZE = 200;
const PENDING_STATUSES = ["running", "waiting", "new", "unknown"] as const;

function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= N8N_MAX_PENDING_EXECUTIONS && value.every((id) => safeId(id))
    && new Set(value).size === value.length ? [...value] as string[] : null;
}

/** Revalidate JSON-loaded checkpoints and evidence before constructing a provider URL. */
export function parseN8nCoverageEvidence(value: unknown, def: JobDefinition, now: Date): N8nCoverageEvidence {
  const proof = record(value);
  const seed = record(proof?.seed);
  const verifiedAt = instant(proof?.verifiedAt);
  const expiresAt = instant(proof?.expiresAt);
  const seedAt = instant(seed?.observedAt);
  const seedIds = ids(seed?.pendingExecutionIds);
  if (!proof || def.provider !== "n8n" || proof.schemaVersion !== 1 || !safeId(proof.proofId)
    || proof.environment !== def.environment || proof.providerId !== def.providerId
    || typeof proof.deployedVersion !== "string" || proof.deployedVersion.length > 80 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(proof.deployedVersion)
    || proof.startFiltersVerified !== true || proof.pendingStatusFiltersVerified !== true || proof.metadataOnlyDetailVerified !== true
    || !Number.isInteger(proof.retentionHours) || Number(proof.retentionHours) < 48 || Number(proof.retentionHours) > 2160
    || !verifiedAt || verifiedAt > now.toISOString() || !expiresAt || expiresAt <= now.toISOString()
    || Date.parse(expiresAt) - Date.parse(verifiedAt) > 31 * DAY_MS
    || !seedAt || seedAt > verifiedAt || seed?.complete !== true || !seedIds) {
    throw new ProviderReadError("provider_capability_evidence_unverified");
  }
  return { schemaVersion: 1, proofId: String(proof.proofId), environment: def.environment,
    providerId: def.providerId, deployedVersion: proof.deployedVersion, verifiedAt, expiresAt,
    startFiltersVerified: true, pendingStatusFiltersVerified: true, metadataOnlyDetailVerified: true,
    retentionHours: Number(proof.retentionHours), seed: { observedAt: seedAt, pendingExecutionIds: seedIds, complete: true } };
}

export function parseN8nCollectionState(value: unknown, proof: N8nCoverageEvidence, now: Date): N8nCollectionState {
  const seedAt = proof.seed.observedAt;
  const state = record(value);
  const from = instant(state?.startedCoverageFrom);
  const through = instant(state?.startedCoverageThrough);
  const pending = ids(state?.pendingExecutionIds);
  const invalidatedAt = instant(state?.invalidatedAt);
  if (!state || state.schemaVersion !== 1 || state.proofId !== proof.proofId || from !== seedAt
    || !through || through < seedAt || through > now.toISOString() || !pending
    || (state.invalidatedAt != null && (!invalidatedAt || invalidatedAt < seedAt || invalidatedAt > now.toISOString()))) {
    throw new ProviderReadError("provider_checkpoint_invalid");
  }
  const parsed: N8nCollectionState = { schemaVersion: 1, proofId: String(proof.proofId), startedCoverageFrom: from,
    startedCoverageThrough: through, pendingExecutionIds: pending, ...(invalidatedAt ? { invalidatedAt } : {}) };
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") >= N8N_MAX_CHECKPOINT_BYTES) throw new ProviderReadError("provider_checkpoint_invalid");
  return parsed;
}

export function reviewedN8nState(def: JobDefinition, now: Date, config: N8nIncrementalConfig): N8nCollectionState {
  const proof = parseN8nCoverageEvidence(config.evidence, def, now);
  return config.state === null
    ? { schemaVersion: 1, proofId: proof.proofId, startedCoverageFrom: proof.seed.observedAt,
      startedCoverageThrough: proof.seed.observedAt, pendingExecutionIds: [...proof.seed.pendingExecutionIds] }
    : parseN8nCollectionState(config.state, proof, now);
}

/**
 * Optimizes discovery by start time without changing the metric to a start-time
 * cohort. Exact pending IDs retain old-started/new-finished execution outcomes.
 * This path stays opt-in until the deployed public API and complete seed are
 * verified. It must not infer that MCP support proves public-API support.
 */
export async function collectIncrementalN8nExecutions(input: {
  def: JobDefinition; now: Date; base: URL; headers: Record<string, string>;
  observation: N8nJobObservation; config: N8nIncrementalConfig;
  normalize: (raw: unknown) => JobRun | null;
}): Promise<N8nJobObservation> {
  const { def, now, base, headers, observation, config, normalize } = input;
  const rows = new Map<string, JobRun>();
  let state: N8nCollectionState;
  try { state = reviewedN8nState(def, now, config); }
  catch (error) { observation.code = providerErrorCode(error); return observation; }
  // Leave an hour of safety for API/clock/delivery delay. An expired checkpoint
  // requires a newly reviewed seed; silently resetting it would hide a gap.
  if (now.getTime() - Date.parse(state.startedCoverageThrough) + OVERLAP_MS >= (config.evidence.retentionHours - 1) * 3_600_000) {
    observation.coverage = "partial"; observation.code = "provider_checkpoint_retention_gap"; return observation;
  }
  const pending = new Set(state.pendingExecutionIds);
  const completed = new Set<string>();
  let requests = 0;
  const deadline = Date.now() + MAX_COLLECTION_MS;
  let complete = true;
  const gap = (code: string) => { complete = false; observation.coverage = "partial"; observation.code = code; };
  const retentionUnverified = ["provider_execution_history_disabled", "provider_history_retention_unverified"].includes(observation.code ?? "");
  if (retentionUnverified) {
    state = { ...state, invalidatedAt: state.invalidatedAt ?? observation.windowEnd };
    gap("provider_retention_contract_changed");
  } else if (state.invalidatedAt) gap("provider_checkpoint_requires_review");
  const read = async (url: URL) => {
    if (requests++ >= MAX_REQUESTS || Date.now() >= deadline) throw new ProviderReadError("provider_collection_budget_exceeded");
    return readProviderJson(url, { headers });
  };
  const accept = (raw: unknown, expectedStatus?: string, expectedId?: string) => {
    const value = record(raw);
    const id = safeId(value?.id);
    const run = normalize(raw);
    if (!value || !id || !run || (expectedStatus && value.status !== expectedStatus) || (expectedId && id !== expectedId)
      || (run.startedAt && run.startedAt > observation.windowEnd)) { gap("provider_metadata_incomplete"); return; }
    // A provider detail read can observe a completion after our fixed window.
    // Keep its ID pending for the next poll rather than dropping the outcome.
    if (run.finishedAt && run.finishedAt > observation.windowEnd) { pending.add(id); return; }
    const terminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(run.status);
    if (!terminal && !PENDING_STATUSES.includes(value.status as typeof PENDING_STATUSES[number])) {
      gap("provider_metadata_incomplete"); return;
    }
    const prior = rows.get(run.id);
    if (!prior || !["SUCCEEDED", "FAILED", "CANCELED"].includes(prior.status) || terminal) rows.set(run.id, run);
    if (terminal) { completed.add(id); pending.delete(id); }
    else if (!completed.has(id)) pending.add(id);
  };
  const list = async (status?: string) => {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const url = new URL("/api/v1/executions", base);
      url.searchParams.set("workflowId", def.providerId);
      url.searchParams.set("includeData", "false");
      url.searchParams.set("limit", String(PAGE_SIZE));
      if (status) url.searchParams.set("status", status);
      else {
        url.searchParams.set("startedAfter", new Date(Date.parse(state.startedCoverageThrough) - OVERLAP_MS).toISOString());
        url.searchParams.set("startedBefore", observation.windowEnd);
      }
      if (cursor) url.searchParams.set("cursor", cursor);
      const result = record(await read(url));
      if (!result || !Array.isArray(result.data) || result.data.length > PAGE_SIZE) throw new ProviderReadError("provider_invalid_response");
      for (const raw of result.data) {
        const startedAt = instant(record(raw)?.startedAt);
        if (!status && (!startedAt || startedAt < url.searchParams.get("startedAfter")! || startedAt > observation.windowEnd)) {
          gap("provider_start_filter_unverified"); continue;
        }
        accept(raw, status);
      }
      observation.runs = [...rows.values()];
      if (result.nextCursor == null || result.nextCursor === "") return;
      if (typeof result.nextCursor !== "string" || result.nextCursor.length > 2048 || seen.has(result.nextCursor)) {
        throw new ProviderReadError("provider_invalid_pagination");
      }
      cursor = result.nextCursor; seen.add(cursor);
    }
    gap("provider_history_truncated");
  };
  try {
    // No startedAt filter here: queued executions can have a null startedAt,
    // and waiting/running executions may have begun months before this window.
    for (const status of PENDING_STATUSES) await list(status);
    // Discover starts AFTER the active lists. Otherwise a newly started run
    // omitted as running by this query could finish before the active scan,
    // then disappear behind the advanced watermark on the next poll.
    await list();
    // Refresh the durable pending set, even when the start-date cohort is empty.
    // Metadata-only per-ID reads are exact correlation, never nearest-time pairs.
    for (const id of [...pending]) {
      if (completed.has(id)) continue;
      const url = new URL(`/api/v1/executions/${id}`, base);
      url.searchParams.set("includeData", "false");
      try { accept(await read(url), undefined, id); }
      catch (error) {
        gap(providerErrorCode(error) === "provider_job_not_found" ? "provider_pending_execution_unavailable" : providerErrorCode(error));
        // Retain inaccessible/pruned IDs; absence is not completion or success.
      }
    }
  } catch (error) { gap(providerErrorCode(error)); }
  observation.runs = [...rows.values()];
  if (pending.size > N8N_MAX_PENDING_EXECUTIONS) {
    gap("provider_pending_capacity_exceeded");
    // Preserve a bounded prior set and poison completeness, rather than losing
    // a newly observed retention invalidation or silently dropping excess IDs.
    observation.n8nCheckpoint = { ...state, invalidatedAt: state.invalidatedAt ?? observation.windowEnd,
      pendingExecutionIds: state.pendingExecutionIds.filter((id) => !completed.has(id)) };
    return observation;
  }
  // Even a partial poll can retire explicitly completed pending IDs. The start
  // watermark does not advance, so the next poll rediscovers any skipped starts.
  observation.n8nCheckpoint = { ...state, startedCoverageThrough: complete ? observation.windowEnd : state.startedCoverageThrough,
    pendingExecutionIds: [...pending].sort() };
  if (complete && observation.code !== "provider_execution_history_disabled" && observation.code !== "provider_history_retention_unverified") {
    if (state.startedCoverageFrom <= observation.windowStart) {
      // A queued execution can be canceled before it ever starts. If it both
      // queues and terminates between polls, no startedAt cohort/status poll
      // can discover it. Until a proven completion-time metadata source covers
      // those outcomes, a capability proof alone cannot authorize a full rate.
      observation.coverage = "partial"; observation.code = "provider_null_start_history_unverified";
    }
    else { observation.coverage = "partial"; observation.code = "provider_completion_window_warming"; }
  } else observation.coverage = "partial";
  return observation;
}
