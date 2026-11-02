import "server-only";
import { callTradeRequestService } from "./client";
import type { PriorAllocation } from "./new-request-allocation";

const record = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

function normalisePriorAllocation(body: unknown): PriorAllocation | null {
  if (!record(body) || !record(body.baseAllocation) || !Array.isArray(body.equityStrategies)) return null;
  const riskProfile = finite(body.riskProfile);
  const equity = finite(body.baseAllocation.equity);
  const fixed = finite(body.baseAllocation.fixed);
  const cash = finite(body.baseAllocation.cash);
  if (riskProfile === null || !Number.isInteger(riskProfile) || riskProfile < 1 || riskProfile > 25) return null;
  if (equity === null || fixed === null || cash === null) return null;
  const equityStrategies: PriorAllocation["equityStrategies"] = [];
  for (const [index, entry] of body.equityStrategies.entries()) {
    if (!record(entry) || typeof entry.benchmark !== "string") return null;
    const allocation = finite(entry.allocation);
    if (allocation === null) return null;
    equityStrategies.push({
      id: finite(entry.id) ?? index + 1,
      benchmark: entry.benchmark,
      allocation,
      rationale: typeof entry.rationale === "string" ? entry.rationale : "",
    });
  }
  return { riskProfile, baseAllocation: { equity, fixed, cash }, equityStrategies };
}

/**
 * Business Rules → Prior allocation, read as the signed-in person: a reviewer
 * gets any client's, an ADVISOR only a client on a request they submitted.
 * Any refusal, failure or unreadable body means no prior allocation.
 */
export async function readPriorAllocation(clientId: string): Promise<PriorAllocation | null> {
  const result = await callTradeRequestService<unknown>({
    operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${encodeURIComponent(clientId)}`,
    defaultMessage: "prior_allocation_unavailable",
  });
  return result.ok ? normalisePriorAllocation(result.data) : null;
}
