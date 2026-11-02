import "server-only";
import { createHash } from "node:crypto";
import { custodianTrackerClient } from "@/lib/data/custodian-library";
import {
  confirmCustodianAuthorityRevision,
  listCustodianAuthorityRevisions,
  type CustodianAuthorityRevision,
} from "@/lib/data/custodian-authority";

export type ProjectionRequest = {
  revision: number;
  previousRevision: number | null;
  checksum: string;
  body: unknown;
};

export type ProjectionAttempt =
  | { outcome: "accepted"; revision: number }
  | { outcome: "duplicate"; revision: number }
  | { outcome: "rejected"; revision: number; reason: "gap" | "mismatch" }
  | { outcome: "retry"; revision: number }
  | { outcome: "unauthorized"; revision: number };

export type DeliveryResult = {
  delivered: number[];
  stoppedRevision: number | null;
  reason: "complete" | "gap" | "mismatch" | "retry" | "unauthorized";
};

export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === "bigint" || typeof value === "function") {
    throw new Error("custodian revision body is not JSON");
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function custodianRevisionChecksum(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function projectionAttemptFromResponse(revision: number, status: number | null, data: unknown): ProjectionAttempt {
  const record = data !== null && typeof data === "object" ? data as Record<string, unknown> : null;
  const sameRevision = record?.revision === revision;
  if (status === 200 && sameRevision && record?.outcome === "accepted") return { outcome: "accepted", revision };
  if (status === 200 && sameRevision && record?.outcome === "duplicate") return { outcome: "duplicate", revision };
  if (status === 409 && sameRevision && record?.outcome === "rejected" && (record.reason === "gap" || record.reason === "mismatch")) {
    return { outcome: "rejected", revision, reason: record.reason };
  }
  if (status === 401) return { outcome: "unauthorized", revision };
  return { outcome: "retry", revision };
}

export async function deliverCustodianRevisions(
  revisions: readonly CustodianAuthorityRevision[],
  receiver: (input: ProjectionRequest) => Promise<ProjectionAttempt>,
): Promise<DeliveryResult> {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  const delivered: number[] = [];
  let previous: number | null = null;
  const seen = new Map<number, string>();
  for (const row of ordered) {
    if (!Number.isInteger(row.revision) || row.revision < 1) {
      return { delivered, stoppedRevision: row.revision, reason: "mismatch" };
    }
    const checksum = custodianRevisionChecksum(row.body);
    const priorChecksum = seen.get(row.revision);
    if (priorChecksum !== undefined) {
      return { delivered, stoppedRevision: row.revision, reason: priorChecksum === checksum ? "gap" : "mismatch" };
    }
    seen.set(row.revision, checksum);
    if (previous !== null && row.revision !== previous + 1) {
      return { delivered, stoppedRevision: previous + 1, reason: "gap" };
    }
    if (previous === null && row.revision !== 1) {
      return { delivered, stoppedRevision: 1, reason: "gap" };
    }
    const attempt = await receiver({ revision: row.revision, previousRevision: previous, checksum, body: row.body });
    if (attempt.revision !== row.revision) return { delivered, stoppedRevision: row.revision, reason: "retry" };
    if (attempt.outcome === "accepted" || attempt.outcome === "duplicate") {
      delivered.push(row.revision);
      previous = row.revision;
      continue;
    }
    if (attempt.outcome === "rejected") return { delivered, stoppedRevision: row.revision, reason: attempt.reason };
    if (attempt.outcome === "unauthorized") return { delivered, stoppedRevision: row.revision, reason: "unauthorized" };
    return { delivered, stoppedRevision: row.revision, reason: "retry" };
  }
  return { delivered, stoppedRevision: null, reason: "complete" };
}

async function postProjection(input: ProjectionRequest): Promise<ProjectionAttempt> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const { client, origin } = await custodianTrackerClient(controller.signal);
    const res = await client.request({
      url: `${origin}/api/machine/custodians/projection`,
      method: "POST",
      data: input,
      timeout: 10_000,
      retry: false,
      maxRedirects: 0,
      signal: controller.signal,
      validateStatus: () => true,
      headers: { "Cache-Control": "no-store" },
    });
    return projectionAttemptFromResponse(input.revision, res.status, res.data);
  } catch {
    return { outcome: "retry", revision: input.revision };
  } finally {
    clearTimeout(deadline);
  }
}

export async function runCustodianProjectionDelivery(): Promise<DeliveryResult> {
  const revisions = await listCustodianAuthorityRevisions();
  return deliverCustodianRevisions(revisions, async (input) => {
    const attempt = await postProjection(input);
    if (attempt.outcome !== "accepted" && attempt.outcome !== "duplicate") return attempt;
    try {
      await confirmCustodianAuthorityRevision(input.revision);
      return attempt;
    } catch {
      return { outcome: "retry", revision: input.revision };
    }
  });
}
