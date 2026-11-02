import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { acatAdvisorListEnabled } from "@/lib/flags";
import type { AdvisorTransferRow } from "@/lib/transfers/advisor-transfer-status";

// Client Transfers advisor list (ticket). Always On Advice never opens the
// tracker database: it asks the tracker's trusted machine read for the redacted
// advisor list (ticket, tracker main 25555c2) and names the signed-in person by
// work email in the X-Aoa-Actor-Email header. The tracker alone decides whether
// that person is an advisor or admin; role grants stay on the tracker.
//
// Only the 15 whitelisted columns are ever copied out of the response, so a field
// the tracker did not intend to send (an account number, a fee amount or memo, an
// internal note) cannot reach the screen even if the tracker regressed.

const TRANSFER_TRACKER_URL = (
  process.env.TRANSFER_TRACKER_URL ?? "https://transfers.jeremyhamann.dev"
).replace(/\/+$/, "");
const ADVISOR_TIMEOUT_MS = 10_000;
const LOG_TAG = "advisor-transfers";
const PATH = "/api/machine/advisor/acats";

export type AdvisorTransfersResult =
  | { ok: true; rows: AdvisorTransferRow[] }
  | { ok: false; reason: "not_allowed" | "disabled" | "unavailable" };

const auth = new ServiceAuth();

export async function readAdvisorTransfers(email: string): Promise<AdvisorTransfersResult> {
  if (!acatAdvisorListEnabled()) return { ok: false, reason: "disabled" };
  const actor = email.trim().toLowerCase();
  if (!actor) return { ok: false, reason: "not_allowed" };
  const res = await callTracker(actor);
  if (!res) return { ok: false, reason: "unavailable" };
  return mapResponse(res.status, res.data);
}

async function callTracker(actor: string): Promise<{ status: number; data: unknown } | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
        controller.signal.throwIfAborted();
        const res = await client.request<unknown>({
          url: `${TRANSFER_TRACKER_URL}${PATH}`,
          method: "GET",
          headers: { "Cache-Control": "no-store", "X-Aoa-Actor-Email": actor },
          signal: controller.signal,
          timeout: ADVISOR_TIMEOUT_MS,
          retry: false,
          validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("advisor_timeout"));
        }, ADVISOR_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Never log the person, rows, or any response body.
    console.error(`[${LOG_TAG}] transport_failed`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapResponse(status: number, data: unknown): AdvisorTransfersResult {
  if (status === 200) {
    const rows = parseRows(data);
    if (rows) return { ok: true, rows };
    // Contract drift must be visible in logs; never log the body.
    console.error(`[${LOG_TAG}] malformed_payload`);
    return { ok: false, reason: "unavailable" };
  }
  console.error(`[${LOG_TAG}] status=${status}`);
  // Only the tracker's own refusal body is a refusal; any other 403 (for example a
  // platform or proxy response) is an outage, not a decision about the person.
  if (status === 403 && record(data) && data.error === "not_allowed") {
    return { ok: false, reason: "not_allowed" };
  }
  return { ok: false, reason: "unavailable" };
}

function parseRows(data: unknown): AdvisorTransferRow[] | null {
  if (!record(data) || !Array.isArray(data.acats)) return null;
  const rows: AdvisorTransferRow[] = [];
  for (const item of data.acats) {
    const row = parseRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function parseRow(value: unknown): AdvisorTransferRow | null {
  if (!record(value)) return null;
  const { id, clientName, status, acatDate } = value;
  if (typeof id !== "string" || typeof clientName !== "string" || typeof status !== "string" || typeof acatDate !== "string") {
    return null;
  }
  const direction = nullableString(value.direction);
  const type = nullableString(value.type);
  const accountType = nullableString(value.accountType);
  const transferringContra = nullableString(value.transferringContra);
  const wealthAdvisor = nullableString(value.wealthAdvisor);
  const additionalResources = nullableString(value.additionalResources);
  const originalClientRequestDate = nullableString(value.originalClientRequestDate);
  const opsSubmissionDateToApex = nullableString(value.opsSubmissionDateToApex);
  const apexCompletionDate = nullableString(value.apexCompletionDate);
  const custodian = parseCustodian(value.custodian);
  const amount = value.statementAmount;
  if (
    [direction, type, accountType, transferringContra, wealthAdvisor, additionalResources,
      originalClientRequestDate, opsSubmissionDateToApex, apexCompletionDate].includes(undefined) ||
    custodian === undefined ||
    !(amount === null || (typeof amount === "number" && Number.isFinite(amount)))
  ) {
    return null;
  }
  // Built key by key from the whitelist; nothing else is copied.
  const row: AdvisorTransferRow = {
    id, clientName, status, acatDate,
    direction: direction as string | null,
    type: type as string | null,
    accountType: accountType as string | null,
    transferringContra: transferringContra as string | null,
    wealthAdvisor: wealthAdvisor as string | null,
    additionalResources: additionalResources as string | null,
    originalClientRequestDate: originalClientRequestDate as string | null,
    opsSubmissionDateToApex: opsSubmissionDateToApex as string | null,
    apexCompletionDate: apexCompletionDate as string | null,
    statementAmount: amount as number | null,
    custodian,
  };
  return row;
}

function parseCustodian(value: unknown): AdvisorTransferRow["custodian"] | undefined {
  if (value === null) return null;
  if (!record(value)) return undefined;
  const { id, name, avgProcessingDays } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof avgProcessingDays !== "number" || !Number.isFinite(avgProcessingDays)) {
    return undefined;
  }
  return { id, name, avgProcessingDays };
}

/** string -> itself, null -> null, anything else (including a missing key) -> undefined. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
