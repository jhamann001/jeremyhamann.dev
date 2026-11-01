import type { RequestStatus } from '@trade-request/shared';

const STYLES: Record<RequestStatus, string> = {
  'Pending Review': 'text-[var(--blue-muted)] bg-[var(--blue-light)]',
  'Needs Info': 'text-[var(--yellow)] bg-[var(--yellow-light)]',
  'Pending Current Asset Liquidation': 'text-[var(--text-secondary)] bg-[var(--bg-surface)]',
  Approved: 'text-[var(--green)] bg-[var(--green-light)]',
  Completed: 'text-[var(--green)] bg-[var(--green-light)]',
  Rejected: 'text-[var(--red)] bg-[var(--red-light)]',
};

const DESCRIPTIONS: Record<RequestStatus, string> = {
  'Pending Review': 'Awaiting trader review',
  'Needs Info': 'Returned to advisor for additional details',
  'Pending Current Asset Liquidation': 'Waiting for existing positions to be sold',
  Approved: 'Approved and ready for execution',
  Completed: 'Fully executed',
  Rejected: 'Permanently rejected — advisor must submit a new request',
};

interface Props {
  status: RequestStatus;
}

export function StatusBadge({ status }: Props) {
  const style = STYLES[status] ?? 'text-[var(--text-muted)] bg-[var(--bg-surface)]';
  return (
    <span
      className={`px-3 py-1 rounded-md text-[11px] font-semibold ${style}`}
      title={DESCRIPTIONS[status]}
      aria-label={`${status}: ${DESCRIPTIONS[status]}`}
    >
      {status}
    </span>
  );
}
