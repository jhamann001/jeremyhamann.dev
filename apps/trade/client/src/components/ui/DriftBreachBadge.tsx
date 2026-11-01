import type { DriftBadgeKind } from '../../utils/driftBadge';

const STYLES: Record<DriftBadgeKind, string> = {
  clean: 'text-[var(--green)] bg-[var(--green-light)]',
  'would-alert': 'text-[var(--red)] bg-[var(--red-light)]',
  'allow-listed': 'text-[var(--yellow)] bg-[var(--yellow-light)]',
  unmapped: 'text-[var(--text-secondary)] bg-[var(--bg-surface)]',
};

const LABELS: Record<DriftBadgeKind, string> = {
  clean: 'Clean',
  'would-alert': 'Would alert',
  'allow-listed': 'Allow-listed',
  unmapped: 'Unmapped',
};

const DESCRIPTIONS: Record<DriftBadgeKind, string> = {
  clean: 'Within tolerance — no alert',
  'would-alert': 'Live alert would fire today if DRIFT_ALERTS_ENABLED=true',
  'allow-listed': 'Known-expected divergence; alert is suppressed by the allow-list',
  unmapped: 'Account number is not in households.json — config drift, not engine drift',
};

interface Props {
  kind: DriftBadgeKind;
  /** Optional override for the hover/aria text. The allow-listed case uses
   *  this to surface the entry's `reason` and `notes` from the static
   *  allow-list endpoint. */
  tooltip?: string;
}

export function DriftBreachBadge({ kind, tooltip }: Props) {
  const style = STYLES[kind] ?? 'text-[var(--text-muted)] bg-[var(--bg-surface)]';
  const label = LABELS[kind] ?? kind;
  const description = tooltip ?? DESCRIPTIONS[kind] ?? label;
  return (
    <span
      className={`px-2.5 py-0.5 rounded-md text-[11px] font-semibold ${style}`}
      title={description}
      aria-label={`${label}: ${description}`}
    >
      {label}
    </span>
  );
}
