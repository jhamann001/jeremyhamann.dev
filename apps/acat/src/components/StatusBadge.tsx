"use client";

import { ACAT_STATUS_LABELS } from "@/lib/types";

type Hue =
  | "slate"
  | "blue"
  | "amber"
  | "sky"
  | "indigo"
  | "violet"
  | "cyan"
  | "teal"
  | "emerald"
  | "lime"
  | "purple"
  | "green"
  | "red"
  | "gray"
  | "orange"
  | "yellow";

const STATUS_HUE: Record<string, Hue> = {
  WaitingForApex: "slate",
  PendingAccountOpening: "blue",
  WaitingOnClient: "amber",
  WaitingForStatement: "amber",
  AcatReceived: "sky",
  ToCome: "indigo",
  Submitted: "violet",
  PendingReview: "cyan",
  PendingContraResponse: "teal",
  Accepted: "emerald",
  PendingSettlement: "lime",
  PendingBookkeeping: "purple",
  Completed: "green",
  Rejected: "red",
  Purged: "gray",
  Canceled: "orange",
  Deferred: "yellow",
  Mapped: "emerald",
  Unmapped: "amber",
  Pending: "blue",
  Expected: "violet",
};

const HUE_CLASSES: Record<Hue, { wrap: string; dot: string }> = {
  slate: {
    wrap: "bg-[color:var(--status-slate-bg)] text-[color:var(--status-slate-fg)] border-[color:var(--status-slate-edge)]",
    dot: "bg-[color:var(--status-slate-dot)]",
  },
  blue: {
    wrap: "bg-[color:var(--status-blue-bg)] text-[color:var(--status-blue-fg)] border-[color:var(--status-blue-edge)]",
    dot: "bg-[color:var(--status-blue-dot)]",
  },
  amber: {
    wrap: "bg-[color:var(--status-amber-bg)] text-[color:var(--status-amber-fg)] border-[color:var(--status-amber-edge)]",
    dot: "bg-[color:var(--status-amber-dot)]",
  },
  sky: {
    wrap: "bg-[color:var(--status-sky-bg)] text-[color:var(--status-sky-fg)] border-[color:var(--status-sky-edge)]",
    dot: "bg-[color:var(--status-sky-dot)]",
  },
  indigo: {
    wrap: "bg-[color:var(--status-indigo-bg)] text-[color:var(--status-indigo-fg)] border-[color:var(--status-indigo-edge)]",
    dot: "bg-[color:var(--status-indigo-dot)]",
  },
  violet: {
    wrap: "bg-[color:var(--status-violet-bg)] text-[color:var(--status-violet-fg)] border-[color:var(--status-violet-edge)]",
    dot: "bg-[color:var(--status-violet-dot)]",
  },
  cyan: {
    wrap: "bg-[color:var(--status-cyan-bg)] text-[color:var(--status-cyan-fg)] border-[color:var(--status-cyan-edge)]",
    dot: "bg-[color:var(--status-cyan-dot)]",
  },
  teal: {
    wrap: "bg-[color:var(--status-teal-bg)] text-[color:var(--status-teal-fg)] border-[color:var(--status-teal-edge)]",
    dot: "bg-[color:var(--status-teal-dot)]",
  },
  emerald: {
    wrap: "bg-[color:var(--status-emerald-bg)] text-[color:var(--status-emerald-fg)] border-[color:var(--status-emerald-edge)]",
    dot: "bg-[color:var(--status-emerald-dot)]",
  },
  lime: {
    wrap: "bg-[color:var(--status-lime-bg)] text-[color:var(--status-lime-fg)] border-[color:var(--status-lime-edge)]",
    dot: "bg-[color:var(--status-lime-dot)]",
  },
  purple: {
    wrap: "bg-[color:var(--status-purple-bg)] text-[color:var(--status-purple-fg)] border-[color:var(--status-purple-edge)]",
    dot: "bg-[color:var(--status-purple-dot)]",
  },
  green: {
    wrap: "bg-[color:var(--status-green-bg)] text-[color:var(--status-green-fg)] border-[color:var(--status-green-edge)]",
    dot: "bg-[color:var(--status-green-dot)]",
  },
  red: {
    wrap: "bg-[color:var(--status-red-bg)] text-[color:var(--status-red-fg)] border-[color:var(--status-red-edge)]",
    dot: "bg-[color:var(--status-red-dot)]",
  },
  gray: {
    wrap: "bg-[color:var(--status-gray-bg)] text-[color:var(--status-gray-fg)] border-[color:var(--status-gray-edge)]",
    dot: "bg-[color:var(--status-gray-dot)]",
  },
  orange: {
    wrap: "bg-[color:var(--status-orange-bg)] text-[color:var(--status-orange-fg)] border-[color:var(--status-orange-edge)]",
    dot: "bg-[color:var(--status-orange-dot)]",
  },
  yellow: {
    wrap: "bg-[color:var(--status-yellow-bg)] text-[color:var(--status-yellow-fg)] border-[color:var(--status-yellow-edge)]",
    dot: "bg-[color:var(--status-yellow-dot)]",
  },
};

export const STATUS_HUE_MAP = STATUS_HUE;

export default function StatusBadge({ status }: { status: string }) {
  const hue = STATUS_HUE[status] ?? "gray";
  const classes = HUE_CLASSES[hue];

  return (
    <span
      data-status={status}
      data-hue={hue}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${classes.wrap}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${classes.dot}`} />
      {ACAT_STATUS_LABELS[status as keyof typeof ACAT_STATUS_LABELS] ?? status}
    </span>
  );
}
