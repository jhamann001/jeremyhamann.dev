import { createHash } from "node:crypto";
import {
  TRANSFER_LINKAGE_CONTRACT_VERSION, ACAT_MATCH_REASONS, ACAT_MATCH_RULE_VERSION,
  type AcatMatchDecision, type AcatLinkRunMode,
} from "../acat-link-contract";

export type ManifestJson = null | string | number | boolean | ManifestJson[] | { [key: string]: ManifestJson };

/** Stable JSON rejects unsupported values instead of silently discarding them
 * as JSON.stringify normally does. Digests must cover every reviewed fact. */
export function stableManifestJson(value: ManifestJson): string {
  const ancestors = new Set<object>();
  function encode(item: ManifestJson, depth: number): string {
    if (depth > 32) throw new Error("acat_manifest_invalid_json");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("acat_manifest_invalid_json");
      return JSON.stringify(item);
    }
    if (typeof item !== "object" || ancestors.has(item)
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
      throw new Error("acat_manifest_invalid_json");
    }
    ancestors.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, (member) => encode(member, depth + 1)).join(",")}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(",")}}`;
    ancestors.delete(item);
    return result;
  }
  return encode(value, 0);
}

export function manifestDigest(value: ManifestJson): string {
  return boundedDigest(value, 1_048_576);
}

function boundedDigest(value: ManifestJson, maxBytes: number): string {
  const serialized = stableManifestJson(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("acat_manifest_payload_too_large");
  return createHash("sha256").update(serialized).digest("hex");
}

export type ManifestDecision = AcatMatchDecision & {
  decisionKey: string;
  payload: ManifestJson;
};

export type PreparedManifest = {
  mode: AcatLinkRunMode;
  contractVersion: typeof TRANSFER_LINKAGE_CONTRACT_VERSION;
  ruleVersion: typeof ACAT_MATCH_RULE_VERSION;
  installationId: string;
  sourceScope: string;
  sourceDigest: string;
  sourceCount: number;
  sourceComplete: boolean;
  targetDigest: string;
  targetCount: number;
  decisions: ManifestDecision[];
};

const SHA256 = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const MODES = new Set(["PREPARE", "APPLY", "VERIFY", "UNDO", "AUTOMATIC"]);
const ACTIONS = new Set(["preserve", "propose", "review", "exclude", "no_counterpart"]);

/** Timestamps/publication IDs are recorded separately. A fresh publication of
 * identical facts does not create a new decision or require repeat approval. */
export function sealPreparedManifest(manifest: PreparedManifest): { digest: string; idempotencyKey: string } {
  if (!manifest.sourceComplete || !count(manifest.sourceCount) || !count(manifest.targetCount)
    || manifest.sourceCount > 5_000 || manifest.targetCount > 5_000
    || !SHA256.test(manifest.sourceDigest) || !SHA256.test(manifest.targetDigest)
    || manifest.contractVersion !== TRANSFER_LINKAGE_CONTRACT_VERSION || manifest.ruleVersion !== ACAT_MATCH_RULE_VERSION
    || !MODES.has(manifest.mode) || ![manifest.installationId, manifest.sourceScope].every((key) => KEY.test(key))
    || manifest.decisions.length > 10_000) {
    throw new Error("acat_manifest_invalid_scope");
  }
  const keys = new Set<string>();
  for (const item of manifest.decisions) {
    if (!KEY.test(item.decisionKey) || keys.has(item.decisionKey)
      || !ACAT_MATCH_REASONS.includes(item.reason) || !ACTIONS.has(item.action) || item.ruleVersion !== manifest.ruleVersion
      || (!item.recordId && !item.transferId)
      || (item.recordId !== null && !KEY.test(item.recordId))
      || (item.transferId !== null && !KEY.test(item.transferId))
      || !SHA256.test(item.evidenceDigest) || !SHA256.test(item.sourceCandidateSetDigest)
      || (item.targetDigest !== null && !SHA256.test(item.targetDigest))
      || (item.sourceRecordDigest !== null && !SHA256.test(item.sourceRecordDigest))
      || (item.sourceAccountDigest !== null && !SHA256.test(item.sourceAccountDigest))
      || (item.targetVersion !== null && !count(item.targetVersion))) {
      throw new Error("acat_manifest_invalid_decision");
    }
    keys.add(item.decisionKey);
  }
  // The complete manifest can contain 10,000 compact decisions. Keep the
  // aggregate bounded independently of the smaller individual value bound.
  // Persisted decision envelopes retain their separate 60 KB service limit.
  const digest = boundedDigest({
    ...manifest,
    decisions: [...manifest.decisions].sort((a, b) => a.decisionKey < b.decisionKey ? -1 : a.decisionKey > b.decisionKey ? 1 : 0).map((item) => ({ ...item })),
  }, 16_777_216);
  return { digest, idempotencyKey: `acat-manifest-v1:${digest}` };
}

/** The supplied digest is never trusted as a replacement for recomputing the
 * stored evidence. Detect row tampering/corruption before invoking a writer. */
export function verifyPreparedManifest(manifest: PreparedManifest, expectedDigest: string): boolean {
  return SHA256.test(expectedDigest) && sealPreparedManifest(manifest).digest === expectedDigest;
}
