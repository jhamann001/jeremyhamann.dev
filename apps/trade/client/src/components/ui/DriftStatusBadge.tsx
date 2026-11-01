import type { DriftCoverageStatus } from '@trade-request/shared';

const STYLES: Record<DriftCoverageStatus, string> = {
  full: 'text-[var(--green)] bg-[var(--green-light)]',
  partial: 'text-[var(--yellow)] bg-[var(--yellow-light)]',
  engine_only: 'text-[var(--blue-muted)] bg-[var(--blue-light)]',
  meridian_only: 'text-[var(--blue-muted)] bg-[var(--blue-light)]',
  unmapped_account: 'text-[var(--text-secondary)] bg-[var(--bg-surface)]',
};

const LABELS: Record<DriftCoverageStatus, string> = {
  full: 'Full',
  partial: 'Partial',
  engine_only: 'Engine only',
  meridian_only: 'Meridian only',
  unmapped_account: 'Unmapped',
};

const DESCRIPTIONS: Record<DriftCoverageStatus, string> = {
  full: 'Both engine and Meridian snapshots cover every account in the household',
  partial: 'At least one account is missing from one of the two snapshots',
  engine_only: 'Engine has rows but the Meridian snapshot does not',
  meridian_only: 'Meridian snapshot has rows but the engine does not',
  unmapped_account: 'Account number is not in households.json — config drift, not engine drift',
};

interface Props {
  status: DriftCoverageStatus;
}

export function DriftStatusBadge({ status }: Props) {
  const style = STYLES[status] ?? 'text-[var(--text-muted)] bg-[var(--bg-surface)]';
  const label = LABELS[status] ?? status;
  const description = DESCRIPTIONS[status] ?? label;
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
