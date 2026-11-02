import "server-only";
import type { JobDefinition } from "./contracts";
import { parseN8nCollectionState, parseN8nCoverageEvidence, type N8nIncrementalConfig } from "./providers/n8n-coverage";

/** Non-secret, explicitly reviewed capability proof; never infer it from an API key. */
export function n8nIncrementalConfiguration(job: JobDefinition, now: Date, raw: string | undefined, saved: unknown):
  { kind: "disabled" } | { kind: "invalid" } | { kind: "enabled"; config: N8nIncrementalConfig } {
  if (!raw) return { kind: "disabled" };
  try {
    if (raw.length > 256_000) throw new Error();
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 50) throw new Error();
    const matches = entries.filter((entry) => entry && typeof entry === "object"
      && entry.environment === job.environment && entry.providerId === job.providerId);
    if (matches.length === 0) return { kind: "disabled" };
    if (matches.length !== 1) throw new Error();
    const evidence = parseN8nCoverageEvidence(matches[0], job, now);
    // A new reviewed proof has a new complete seed; never reuse another proof's state.
    const sameProof = saved && typeof saved === "object" && "proofId" in saved && saved.proofId === evidence.proofId;
    const state = sameProof ? parseN8nCollectionState(saved, evidence, now) : null;
    return { kind: "enabled", config: { evidence, state } };
  } catch { return { kind: "invalid" }; }
}
