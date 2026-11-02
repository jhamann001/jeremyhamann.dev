import type { JobFilter, JobSchedule, JobStatus, RunStatus } from "@/lib/data-jobs/contracts";

export const JOB_FILTERS: { value: JobFilter; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "SOURCE_ATTENTION", label: "Source needs attention" },
  { value: "FAILED", label: "Failed" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "STALLED", label: "Stalled" },
  { value: "UNKNOWN", label: "Unknown" },
  { value: "RUNNING", label: "Running" },
  { value: "HEALTHY", label: "Healthy" },
  { value: "PAUSED", label: "Paused" },
];

export function jobTone(status: JobStatus | RunStatus): "green" | "red" | "amber" | "blue" | "gray" {
  if (status === "HEALTHY" || status === "SUCCEEDED") return "green";
  if (["FAILED", "OVERDUE", "STALLED"].includes(status)) return "red";
  if (status === "UNKNOWN" || status === "ACKNOWLEDGED") return "amber";
  if (status === "RUNNING") return "blue";
  return "gray";
}

export function statusLabel(status: JobStatus | RunStatus): string {
  if (status === "ACKNOWLEDGED") return "Delivery acknowledged";
  return status.toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

export function jobTimestamp(value: string | null | undefined, timezone = "America/New_York"): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not recorded";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      timeZoneName: "short", timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return jobTimestamp(value, "UTC");
  }
}

export function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "Not recorded";
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function nextRunLabel(schedule: JobSchedule | undefined, enabled: boolean | null | undefined): string {
  if (enabled === false) return "Paused — no expected run";
  if (!schedule) return "Schedule not observed";
  if (schedule.kind === "manual") return "On demand";
  if (schedule.kind === "event") return "When the trigger fires";
  if (schedule.kind === "unknown" || !schedule.nextRunAt || schedule.nextRunBasis === "unknown") return "Not available";
  const prefix = schedule.nextRunBasis === "calculated" ? "Expected: " : "";
  return `${prefix}${jobTimestamp(schedule.nextRunAt, schedule.timezone ?? "UTC")}`;
}

export function successRateLabel(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) return "Not available";
  // Never round a near-perfect result to 100% when there was a failed execution.
  if (rate > 99.9 && rate < 100) return ">99.9%";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(rate)}%`;
}

export function listUrl(q: string, status: JobFilter, cursor: string | null = null): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim().slice(0, 100));
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return `/api/data-health/jobs${params.size ? `?${params.toString()}` : ""}`;
}

export function historyUrl(jobId: string, cursor: string | null = null): string {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  return `/api/data-health/jobs/${encodeURIComponent(jobId)}/runs${params.size ? `?${params.toString()}` : ""}`;
}

export function uniqueById<T>(items: T[], id: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = id(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
