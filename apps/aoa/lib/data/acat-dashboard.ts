import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { operationsAcatTransferDashboardEnabled } from "@/lib/flags";

const TRANSFER_TRACKER_URL = (
  process.env.TRANSFER_TRACKER_URL ?? "https://transfers.jeremyhamann.dev"
).replace(/\/+$/, "");

const DASHBOARD_TIMEOUT_MS = 10_000;
const LOG_TAG = "acat-dashboard";
const WORKFLOWS = ["ACAT", "MANUAL", "DRS", "RESIDUAL", "UNCLASSIFIED"] as const;
const REVIEW_STATUSES = ["OPEN", "IN_REVIEW", "CLOSED"] as const;
const REVIEW_RESOLUTIONS = [
  "CORRECTED",
  "RESOLVED_MANUALLY",
  "FALSE_POSITIVE",
  "NOT_APPLICABLE",
  "ACKNOWLEDGED_UNRESOLVED",
  "DUPLICATE",
] as const;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Workflow = (typeof WORKFLOWS)[number];
type ReviewStatus = (typeof REVIEW_STATUSES)[number];
type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];

export type Distribution = {
  average: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  sampleSize: number;
};

export type WorkflowTiming = {
  workflow: Workflow;
  requestToSubmit: Distribution;
  submitToComplete: Distribution;
  requestToComplete: Distribution;
};

export type MonthlyVolume = {
  month: string;
  label: string;
  total: number;
  workflows: Record<Workflow, number>;
};

export type FlowSplit = {
  totalCount: number;
  totalAmount: number;
  requestedCount: number;
  requestedAmount: number;
  residualCount: number;
  residualAmount: number;
};

export type DashboardFlow = {
  incoming: FlowSplit;
  outgoing: FlowSplit;
  netAmount: number;
  requestedNetAmount: number;
  residualNetAmount: number;
};

export type ContraPerformance = {
  contra: string;
  completed: number;
  finalized: number;
  rejectionRate: number;
  medianApexDays: number | null;
  completedAmount: number;
};

export type ResidualQueueItem = {
  record: { id: string; clientName: string | null; transferringContra: string | null };
  followUpDate: string;
  daysPastFollowUp: number;
};

export type ResidualBenchmark = {
  contra: string;
  sampleSize: number;
  medianDays: number | null;
  p75Days: number | null;
  p90Days: number | null;
};

export type QualityRule = { ruleKey: string; title: string; description: string };

export type QualityReview = {
  status: string;
  resolution: string | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type QualityException = {
  record: { id: string; clientName: string | null; transferringContra: string | null };
  ruleKey: string;
  fingerprint: string;
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  review: QualityReview | null;
};

export type DashboardReconciliation = {
  coverageRate: number;
  tracked: number;
  eligible: number;
  matched: number;
  matchRate: number | null;
  mismatch: number;
  pending: number;
  notTracked: number;
};

export type DashboardSummary = {
  total: number;
  Completed: number;
  Rejected: number;
  Canceled: number;
  Purged: number;
  active: number;
  validFinalized: number;
  completedRate: number;
  rejectionRate: number;
  canceledRate: number;
};

export type AcatDashboard = {
  summary: DashboardSummary;
  workflowTimings: WorkflowTiming[];
  monthlyVolume: MonthlyVolume[];
  flow: DashboardFlow;
  topContras: { acat: ContraPerformance[]; manual: ContraPerformance[] };
  residuals: { queue: ResidualQueueItem[]; benchmarks: ResidualBenchmark[] };
  quality: { rules: QualityRule[]; exceptions: QualityException[] };
  reconciliation: DashboardReconciliation;
};

export type DashboardReadResult =
  | { ok: true; dashboard: AcatDashboard }
  | { ok: false; retryable: boolean; reason: string };

export type ReviewWrite = {
  acatRecordId: string;
  ruleKey: string;
  fingerprint: string;
  status: ReviewStatus;
  resolution: ReviewResolution | null;
  note: string | null;
};

export type ReviewWriteResult =
  | { ok: true; review: { status: string; resolution: string | null; note: string | null } }
  | { ok: false; open: true; reason: string };

const auth = new ServiceAuth();

export function boundedRecordId(value: unknown): string | null {
  return typeof value === "string" && RECORD_ID.test(value) ? value : null;
}

export function acatDetailHref(recordId: string): string {
  return `/acat-tracking?record=${encodeURIComponent(recordId)}`;
}

export async function readAcatDashboard(): Promise<DashboardReadResult> {
  if (!operationsAcatTransferDashboardEnabled()) {
    return { ok: false, retryable: true, reason: "not_found" };
  }
  const res = await callTracker("GET", "/api/machine/dashboard");
  if (!res) return { ok: false, retryable: true, reason: "transport_error" };
  return mapRead(res.status, res.data);
}

export async function postAcatDashboardReview(input: unknown): Promise<ReviewWriteResult> {
  if (!operationsAcatTransferDashboardEnabled()) {
    return { ok: false, open: true, reason: "not_found" };
  }
  const body = normalizeReviewWrite(input);
  if (!body) return { ok: false, open: true, reason: "validation_error" };
  const res = await callTracker("POST", "/api/machine/dashboard/reviews", body);
  if (!res) return { ok: false, open: true, reason: "transport_error" };
  return mapWrite(res.status, res.data);
}

async function callTracker(
  method: "GET" | "POST",
  path: string,
  data?: ReviewWrite,
): Promise<{ status: number; data: unknown } | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const client = await auth.getIdTokenClient(TRANSFER_TRACKER_URL);
        controller.signal.throwIfAborted();
        const res = await client.request<unknown>({
          url: `${TRANSFER_TRACKER_URL}${path}`,
          method,
          data,
          headers: { "Cache-Control": "no-store" },
          signal: controller.signal,
          timeout: DASHBOARD_TIMEOUT_MS,
          retry: false,
          validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("dashboard_timeout"));
        }, DASHBOARD_TIMEOUT_MS);
      }),
    ]);
  } catch {
    console.error(`[${LOG_TAG}] transport_failed`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapRead(status: number, data: unknown): DashboardReadResult {
  if (status === 401 || status === 403) {
    console.error(`[${LOG_TAG}] status=${status}`);
    return { ok: false, retryable: false, reason: "unauthorized" };
  }
  if (status === 200) {
    const dashboard = parseDashboard(data);
    if (!dashboard) return { ok: false, retryable: true, reason: "malformed" };
    return { ok: true, dashboard };
  }
  console.error(`[${LOG_TAG}] status=${status}`);
  if (status === 404) return { ok: false, retryable: true, reason: token(data, ["not_found"]) ?? "not_found" };
  if (status === 429) return { ok: false, retryable: true, reason: "rate_limited" };
  if (status === 500) return { ok: false, retryable: true, reason: "internal_error" };
  return { ok: false, retryable: true, reason: "unavailable" };
}

function mapWrite(status: number, data: unknown): ReviewWriteResult {
  if (status === 200) {
    const review = parseReview(data);
    if (!review) return { ok: false, open: true, reason: "malformed" };
    return { ok: true, review };
  }
  console.error(`[${LOG_TAG}] status=${status}`);
  if (status === 400) return { ok: false, open: true, reason: validationText(data) };
  if (status === 401 || status === 403) return { ok: false, open: true, reason: "unauthorized" };
  if (status === 404) return { ok: false, open: true, reason: token(data, ["not_found", "transfer_not_found"]) ?? "not_found" };
  if (status === 429) return { ok: false, open: true, reason: "rate_limited" };
  if (status === 500) return { ok: false, open: true, reason: "internal_error" };
  return { ok: false, open: true, reason: "unavailable" };
}

function token(data: unknown, allowed: readonly string[]): string | null {
  if (!record(data) || typeof data.error !== "string") return null;
  return allowed.includes(data.error) ? data.error : null;
}

function validationText(data: unknown): string {
  if (!record(data) || typeof data.error !== "string") return "validation_error";
  const text = data.error.trim();
  if (!text || text.length > 500 || /[\r\n<>]/.test(text)) return "validation_error";
  return text;
}

function normalizeReviewWrite(value: unknown): ReviewWrite | null {
  if (!record(value)) return null;
  const acatRecordId = boundedText(value.acatRecordId, 120);
  const ruleKey = boundedText(value.ruleKey, 120);
  const fingerprint = boundedText(value.fingerprint, 500);
  if (!acatRecordId || !ruleKey || !fingerprint) return null;
  if (typeof value.status !== "string" || !REVIEW_STATUSES.includes(value.status as ReviewStatus)) return null;
  if (value.resolution != null && (typeof value.resolution !== "string" || !REVIEW_RESOLUTIONS.includes(value.resolution as ReviewResolution))) {
    return null;
  }
  if (value.note != null && (typeof value.note !== "string" || value.note.length > 2000)) return null;
  return {
    acatRecordId,
    ruleKey,
    fingerprint,
    status: value.status as ReviewStatus,
    resolution: value.resolution == null ? null : value.resolution as ReviewResolution,
    note: typeof value.note === "string" ? value.note : null,
  };
}

function parseReview(data: unknown): { status: string; resolution: string | null; note: string | null } | null {
  if (!record(data) || typeof data.status !== "string" || data.status === "") return null;
  if (data.resolution != null && typeof data.resolution !== "string") return null;
  if (data.note != null && typeof data.note !== "string") return null;
  return {
    status: data.status,
    resolution: typeof data.resolution === "string" ? data.resolution : null,
    note: typeof data.note === "string" ? data.note : null,
  };
}

function parseDashboard(data: unknown): AcatDashboard | null {
  if (!record(data)) return null;
  const summary = parseSummary(data.summary);
  const workflowTimings = arrayOf(data.workflowTimings, parseTiming);
  const monthlyVolume = arrayOf(data.monthlyVolume, parseMonth);
  const flow = parseFlow(data.flow);
  const topContras = parseContras(data.topContras);
  const residuals = parseResiduals(data.residuals);
  const quality = parseQuality(data.quality);
  const reconciliation = parseReconciliation(data.reconciliation);
  if (!summary || !workflowTimings || !monthlyVolume || !flow || !topContras || !residuals || !quality || !reconciliation) {
    return null;
  }
  return { summary, workflowTimings, monthlyVolume, flow, topContras, residuals, quality, reconciliation };
}

function parseSummary(value: unknown): DashboardSummary | null {
  if (!record(value)) return null;
  const total = finite(value.total);
  const Completed = finite(value.Completed);
  const Rejected = finite(value.Rejected);
  const Canceled = finite(value.Canceled);
  const Purged = finite(value.Purged);
  const active = finite(value.active);
  const validFinalized = finite(value.validFinalized);
  const completedRate = finite(value.completedRate);
  const rejectionRate = finite(value.rejectionRate);
  const canceledRate = finite(value.canceledRate);
  if ([total, Completed, Rejected, Canceled, Purged, active, validFinalized, completedRate, rejectionRate, canceledRate].some((item) => item == null)) {
    return null;
  }
  return {
    total: total as number,
    Completed: Completed as number,
    Rejected: Rejected as number,
    Canceled: Canceled as number,
    Purged: Purged as number,
    active: active as number,
    validFinalized: validFinalized as number,
    completedRate: completedRate as number,
    rejectionRate: rejectionRate as number,
    canceledRate: canceledRate as number,
  };
}

function parseTiming(value: unknown): WorkflowTiming | null {
  if (!record(value) || typeof value.workflow !== "string" || !WORKFLOWS.includes(value.workflow as Workflow)) return null;
  const requestToSubmit = parseDistribution(value.requestToSubmit);
  const submitToComplete = parseDistribution(value.submitToComplete);
  const requestToComplete = parseDistribution(value.requestToComplete);
  if (!requestToSubmit || !submitToComplete || !requestToComplete) return null;
  return { workflow: value.workflow as Workflow, requestToSubmit, submitToComplete, requestToComplete };
}

function parseDistribution(value: unknown): Distribution | null {
  if (!record(value)) return null;
  const average = nullableFinite(value.average);
  const median = nullableFinite(value.median);
  const p75 = nullableFinite(value.p75);
  const p90 = nullableFinite(value.p90);
  const sampleSize = finite(value.sampleSize);
  if (average === undefined || median === undefined || p75 === undefined || p90 === undefined || sampleSize == null) return null;
  return { average, median, p75, p90, sampleSize };
}

function parseMonth(value: unknown): MonthlyVolume | null {
  if (!record(value) || typeof value.month !== "string" || typeof value.label !== "string") return null;
  const total = finite(value.total);
  if (total == null || !record(value.workflows)) return null;
  const workflows = {} as Record<Workflow, number>;
  for (const workflow of WORKFLOWS) {
    const count = finite(value.workflows[workflow]);
    if (count == null) return null;
    workflows[workflow] = count;
  }
  return { month: value.month, label: value.label, total, workflows };
}

function parseFlow(value: unknown): DashboardFlow | null {
  if (!record(value)) return null;
  const incoming = parseSplit(value.incoming);
  const outgoing = parseSplit(value.outgoing);
  const netAmount = finite(value.netAmount);
  const requestedNetAmount = finite(value.requestedNetAmount);
  const residualNetAmount = finite(value.residualNetAmount);
  if (!incoming || !outgoing || netAmount == null || requestedNetAmount == null || residualNetAmount == null) return null;
  return { incoming, outgoing, netAmount, requestedNetAmount, residualNetAmount };
}

function parseSplit(value: unknown): FlowSplit | null {
  if (!record(value)) return null;
  const totalCount = finite(value.totalCount);
  const totalAmount = finite(value.totalAmount);
  const requestedCount = finite(value.requestedCount);
  const requestedAmount = finite(value.requestedAmount);
  const residualCount = finite(value.residualCount);
  const residualAmount = finite(value.residualAmount);
  if ([totalCount, totalAmount, requestedCount, requestedAmount, residualCount, residualAmount].some((item) => item == null)) {
    return null;
  }
  return {
    totalCount: totalCount as number,
    totalAmount: totalAmount as number,
    requestedCount: requestedCount as number,
    requestedAmount: requestedAmount as number,
    residualCount: residualCount as number,
    residualAmount: residualAmount as number,
  };
}

function parseContras(value: unknown): AcatDashboard["topContras"] | null {
  if (!record(value)) return null;
  const acat = arrayOf(value.acat, parseContra);
  const manual = arrayOf(value.manual, parseContra);
  if (!acat || !manual) return null;
  return { acat, manual };
}

function parseContra(value: unknown): ContraPerformance | null {
  if (!record(value) || typeof value.contra !== "string") return null;
  const completed = finite(value.completed);
  const finalized = finite(value.finalized);
  const rejectionRate = finite(value.rejectionRate);
  const medianApexDays = nullableFinite(value.medianApexDays);
  const completedAmount = finite(value.completedAmount);
  if (completed == null || finalized == null || rejectionRate == null || medianApexDays === undefined || completedAmount == null) {
    return null;
  }
  return { contra: value.contra, completed, finalized, rejectionRate, medianApexDays, completedAmount };
}

function parseResiduals(value: unknown): AcatDashboard["residuals"] | null {
  if (!record(value)) return null;
  const queue = arrayOf(value.queue, parseQueueItem);
  const benchmarks = arrayOf(value.benchmarks, parseBenchmark);
  if (!queue || !benchmarks) return null;
  return { queue, benchmarks };
}

function parseQueueItem(value: unknown): ResidualQueueItem | null {
  if (!record(value)) return null;
  const row = parseIdentity(value.record);
  const daysPastFollowUp = finite(value.daysPastFollowUp);
  if (!row || typeof value.followUpDate !== "string" || daysPastFollowUp == null) return null;
  return { record: row, followUpDate: value.followUpDate, daysPastFollowUp };
}

function parseBenchmark(value: unknown): ResidualBenchmark | null {
  if (!record(value) || typeof value.contra !== "string") return null;
  const sampleSize = finite(value.sampleSize);
  const medianDays = nullableFinite(value.medianDays);
  const p75Days = nullableFinite(value.p75Days);
  const p90Days = nullableFinite(value.p90Days);
  if (sampleSize == null || medianDays === undefined || p75Days === undefined || p90Days === undefined) return null;
  return { contra: value.contra, sampleSize, medianDays, p75Days, p90Days };
}

function parseQuality(value: unknown): AcatDashboard["quality"] | null {
  if (!record(value)) return null;
  const rules = arrayOf(value.rules, parseRule);
  const exceptions = arrayOf(value.exceptions, parseException);
  if (!rules || !exceptions) return null;
  return { rules, exceptions };
}

function parseRule(value: unknown): QualityRule | null {
  if (!record(value) || typeof value.ruleKey !== "string" || typeof value.title !== "string" || typeof value.description !== "string") {
    return null;
  }
  return { ruleKey: value.ruleKey, title: value.title, description: value.description };
}

function parseException(value: unknown): QualityException | null {
  if (!record(value)) return null;
  const row = parseIdentity(value.record);
  const review = parseExceptionReview(value.review);
  if (!row || review === undefined) return null;
  if (typeof value.ruleKey !== "string" || typeof value.fingerprint !== "string" || typeof value.title !== "string" || typeof value.detail !== "string") {
    return null;
  }
  if (value.severity !== "high" && value.severity !== "medium" && value.severity !== "low") return null;
  return {
    record: row,
    ruleKey: value.ruleKey,
    fingerprint: value.fingerprint,
    title: value.title,
    detail: value.detail,
    severity: value.severity,
    review,
  };
}

function parseExceptionReview(value: unknown): QualityReview | null | undefined {
  if (value === null) return null;
  if (!record(value) || typeof value.status !== "string") return undefined;
  if (value.resolution != null && typeof value.resolution !== "string") return undefined;
  if (value.note != null && typeof value.note !== "string") return undefined;
  if (value.reviewedBy != null && typeof value.reviewedBy !== "string") return undefined;
  if (value.reviewedAt != null && typeof value.reviewedAt !== "string") return undefined;
  return {
    status: value.status,
    resolution: typeof value.resolution === "string" ? value.resolution : null,
    note: typeof value.note === "string" ? value.note : null,
    reviewedBy: typeof value.reviewedBy === "string" ? value.reviewedBy : null,
    reviewedAt: typeof value.reviewedAt === "string" ? value.reviewedAt : null,
  };
}

function parseReconciliation(value: unknown): DashboardReconciliation | null {
  if (!record(value)) return null;
  const coverageRate = finite(value.coverageRate);
  const tracked = finite(value.tracked);
  const eligible = finite(value.eligible);
  const matched = finite(value.matched);
  const matchRate = nullableFinite(value.matchRate);
  const mismatch = finite(value.mismatch);
  const pending = finite(value.pending);
  const notTracked = finite(value.notTracked);
  if ([coverageRate, tracked, eligible, matched, mismatch, pending, notTracked].some((item) => item == null) || matchRate === undefined) {
    return null;
  }
  return {
    coverageRate: coverageRate as number,
    tracked: tracked as number,
    eligible: eligible as number,
    matched: matched as number,
    matchRate,
    mismatch: mismatch as number,
    pending: pending as number,
    notTracked: notTracked as number,
  };
}

function parseIdentity(value: unknown): ResidualQueueItem["record"] | null {
  if (!record(value) || typeof value.id !== "string" || value.id === "") return null;
  if (value.clientName != null && typeof value.clientName !== "string") return null;
  if (value.transferringContra != null && typeof value.transferringContra !== "string") return null;
  return {
    id: value.id,
    clientName: typeof value.clientName === "string" ? value.clientName : null,
    transferringContra: typeof value.transferringContra === "string" ? value.transferringContra : null,
  };
}

function arrayOf<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
}
