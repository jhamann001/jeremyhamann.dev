// When-column formatting for the Audit Log (WO ticket), mirroring the frozen
// mockup's fmtT / rel (index.html renderAudit :2763–2764). Pure (no React) —
// unit-tested in test/audit-time.test.ts. `now` is injectable so relative
// times are deterministic under test.

const MON = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Absolute timestamp, mockup fmtT format: "Jun 23 · 2:41 PM". */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${MON[d.getMonth()]} ${d.getDate()} · ${h % 12 || 12}:${min} ${h < 12 ? "AM" : "PM"}`;
}

/** Calendar-only source date, rendered without a local-time-zone day shift. */
export function fmtDateOnly(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return iso;
  return `${MON[month - 1]} ${day}, ${match[1]}`;
}

/** Relative timestamp, mockup rel format: "just now" / "12m ago" / "3h ago" / "2d ago". */
export function relTime(iso: string, now: number = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
