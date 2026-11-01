import type { AuditEntry } from '@trade-request/shared';

interface Props {
  entries: AuditEntry[];
}

export function AuditTrail({ entries }: Props) {
  return (
    <div className="pl-7 relative">
      <div className="absolute left-[15px] top-0 bottom-0 w-0.5 bg-[var(--border)]" />
      {entries.map((log, i) => (
        <div key={log.id ?? i} className="relative mb-5">
          <div
            className={`absolute -left-[13px] top-1 w-3 h-3 rounded-full border-2 bg-[var(--bg-card)] ${
              i === 0 ? 'border-[var(--bg-pill)]' : 'border-[var(--border)]'
            }`}
          />
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex justify-between mb-1">
              <span className="font-bold text-[var(--text-primary)] text-sm">{log.action}</span>
              <span className="text-xs text-[var(--text-muted)]">{log.date}</span>
            </div>
            <p className="text-xs text-[var(--text-label)] font-medium mb-1.5">{log.user}</p>
            <p className="text-sm text-[var(--text-secondary)]">{log.notes}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
