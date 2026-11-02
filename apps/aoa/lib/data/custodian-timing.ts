import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";

const auth = new ServiceAuth();
const DEFAULT_URL = "https://transfers.jeremyhamann.dev";

class ObservedTimingUnavailableError extends Error {
  readonly reason = "unavailable" as const;
  constructor() {
    super("Custodian library unavailable");
    this.name = "CustodianLibraryError";
  }
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ObservedTimingUnavailableError());
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function trackerOrigin(): string {
  const base = new URL(process.env.TRANSFER_TRACKER_URL ?? DEFAULT_URL);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Invalid tracker origin");
  }
  return base.origin;
}

export type ObservedCustodianTiming = {
  observedAvgProcessingBusinessDays: number | null;
  observedCompletedTransfers: number;
};

/** Self-contained read-only GET of the existing machine library timing fields. */
export async function readObservedCustodianTiming(): Promise<Map<string, ObservedCustodianTiming>> {
  let response;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8_000);
  try {
    const origin = trackerOrigin();
    const client = await untilAborted(auth.getIdTokenClient(origin), controller.signal);
    if (controller.signal.aborted) throw new ObservedTimingUnavailableError();
    response = await untilAborted(client.request({
      url: `${origin}/api/machine/custodians`, method: "GET",
      timeout: 8_000, retry: false, maxRedirects: 0, signal: controller.signal,
      headers: { "Cache-Control": "no-store" }, validateStatus: () => true,
    }), controller.signal);
  } catch {
    throw new ObservedTimingUnavailableError();
  } finally {
    clearTimeout(deadline);
  }
  if (response.status !== 200) throw new ObservedTimingUnavailableError();
  const data = response.data as { custodians?: unknown };
  if (!Array.isArray(data?.custodians)) throw new ObservedTimingUnavailableError();
  const map = new Map<string, ObservedCustodianTiming>();
  for (const row of data.custodians) {
    if (!row || typeof row !== "object") throw new ObservedTimingUnavailableError();
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || !id) throw new ObservedTimingUnavailableError();
    const avg = (row as { observedAvgProcessingBusinessDays?: unknown }).observedAvgProcessingBusinessDays;
    const completed = (row as { observedCompletedTransfers?: unknown }).observedCompletedTransfers;
    if (avg !== null && (typeof avg !== "number" || !Number.isFinite(avg))) {
      throw new ObservedTimingUnavailableError();
    }
    if (typeof completed !== "number" || !Number.isInteger(completed) || completed < 0) {
      throw new ObservedTimingUnavailableError();
    }
    map.set(id, {
      observedAvgProcessingBusinessDays: avg,
      observedCompletedTransfers: completed,
    });
  }
  return map;
}
