import { useState, useEffect, useRef, useCallback } from 'react';
import { FileText, ListChecks, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import type { AuthUser } from '@trade-request/shared';
import { fetchRequestCounts, type RequestCounts } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Tooltip } from './ui/Tooltip';

interface Props {
  user: AuthUser;
  onNavigate: (view: string) => void;
}

export function HomePage({ user, onNavigate }: Props) {
  const [stats, setStats] = useState<RequestCounts | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const mountedRef = useRef(true);
  const { isDemo } = useAuth();

  const loadStats = useCallback(() => {
    setStatsError(false);
    setStatsLoading(true);
    fetchRequestCounts()
      .then((counts) => {
        if (mountedRef.current) setStats(counts);
      })
      .catch(() => {
        if (mountedRef.current) setStatsError(true);
      })
      .finally(() => {
        if (mountedRef.current) setStatsLoading(false);
      });
  }, []);

  useEffect(() => {
    // Set on mount too: React's development double-mount runs the cleanup once before the real mount.
    mountedRef.current = true;
    loadStats();
    return () => {
      mountedRef.current = false;
    };
  }, [loadStats, isDemo]);

  const firstName = user.name.split(' ')[0];

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="font-serif text-[26px] font-medium text-[var(--text-primary)]">Welcome back, {firstName}</h1>
        <p className="text-[14px] text-[var(--text-muted)] mt-1">Here's a snapshot of your trade activity.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statsError && !statsLoading ? (
          <div className="col-span-full bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] p-5 flex items-center justify-between">
            <span className="text-[13px] text-[var(--text-muted)]">Unable to load stats.</span>
            <button
              onClick={loadStats}
              className="px-3 py-1.5 text-[12px] font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
            >
              Retry
            </button>
          </div>
        ) : statsLoading || !stats ? (
          <>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] p-5">
                <div className="animate-pulse">
                  <div className="h-4 w-24 bg-[var(--bg-surface)] rounded mb-3" />
                  <div className="h-8 w-12 bg-[var(--bg-surface)] rounded" />
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <StatCard
              label="Total Requests"
              value={stats.total}
              icon={<FileText size={18} />}
              colorClass="text-[var(--text-label)]"
              tooltip="All submitted trade requests"
            />
            <StatCard
              label="Pending Review"
              value={stats.pendingReview}
              icon={<Clock size={18} />}
              colorClass="text-[var(--yellow)]"
              tooltip="Awaiting trader review"
            />
            <StatCard
              label="Needs Info"
              value={stats.needsInfo}
              icon={<AlertCircle size={18} />}
              colorClass="text-[var(--red)]"
              tooltip="Returned to advisor for clarification"
            />
            <StatCard
              label="Approved / Done"
              value={stats.approved}
              icon={<CheckCircle2 size={18} />}
              colorClass="text-[var(--green)]"
              tooltip="Approved or completed requests"
            />
          </>
        )}
      </div>

      {/* Quick Actions */}
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--text-label)] mb-3">
        Quick Actions
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ActionCard
          title="New Trade Request"
          description="Submit a new trade request for a client account."
          icon={<FileText size={22} className="text-[var(--green)]" />}
          onClick={() => onNavigate('form')}
        />
        <ActionCard
          title="Trading Queue"
          description={
            user.role === 'trader'
              ? 'Review and manage all pending trade requests.'
              : 'View all trade requests and their status.'
          }
          icon={<ListChecks size={22} className="text-[var(--blue-muted)]" />}
          onClick={() => onNavigate('queue')}
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  colorClass,
  tooltip,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  colorClass: string;
  tooltip?: string;
}) {
  return (
    <Tooltip content={tooltip ?? ''} position="bottom" className="flex">
      <div className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] p-5 flex-1">
        <div className="flex items-center gap-2 mb-3">
          <span className={colorClass}>{icon}</span>
          <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-label)]">{label}</span>
        </div>
        <p className="text-[28px] font-serif font-medium text-[var(--text-primary)]">{value}</p>
      </div>
    </Tooltip>
  );
}

function ActionCard({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] p-6 text-left hover:border-[var(--text-label)] transition-colors group"
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5">{icon}</div>
        <div>
          <h3 className="text-[15px] font-semibold text-[var(--text-primary)] group-hover:text-[var(--bg-pill)]">
            {title}
          </h3>
          <p className="text-[13px] text-[var(--text-muted)] mt-1">{description}</p>
        </div>
      </div>
    </button>
  );
}
