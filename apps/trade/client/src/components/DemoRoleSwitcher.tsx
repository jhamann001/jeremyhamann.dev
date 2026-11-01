import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import type { UserRole } from '@trade-request/shared';
import { Tooltip } from './ui/Tooltip';

export function DemoRoleSwitcher() {
  const { actualUser, roleOverride, setRoleOverride, isDemo } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  if (!actualUser) return null;
  if (!import.meta.env.DEV && !isDemo) return null;

  const isOverridden = roleOverride !== null && roleOverride !== actualUser.role;
  const effectiveRole: UserRole = isOverridden ? roleOverride : actualUser.role;
  const oppositeRole: UserRole = actualUser.role === 'advisor' ? 'trader' : 'advisor';

  if (collapsed) {
    return (
      <Tooltip content="Open demo role switcher" position="left" className="fixed bottom-4 right-4 z-50">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className={`w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-colors ${
            isOverridden
              ? 'bg-amber-500 text-white ring-2 ring-amber-300'
              : 'bg-[var(--bg-card)] text-[var(--text-muted)] border border-[var(--border)]'
          }`}
          aria-label="Demo role switcher"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </button>
      </Tooltip>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Demo Mode</span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-0.5"
          aria-label="Collapse"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      <div className="p-4 space-y-3">
        <div className="text-[12px] text-[var(--text-muted)]">
          Signed in as <span className="font-medium text-[var(--text-primary)]">{actualUser.name}</span>
          <span className="ml-1 capitalize">({actualUser.role})</span>
        </div>

        <div className="text-[12px] text-[var(--text-muted)]">Viewing as:</div>
        <div className="flex gap-2">
          <RoleButton
            role={actualUser.role}
            label={`${actualUser.role} (you)`}
            active={effectiveRole === actualUser.role}
            onClick={() => setRoleOverride(null)}
          />
          <RoleButton
            role={oppositeRole}
            label={`${oppositeRole} (demo)`}
            active={effectiveRole === oppositeRole}
            onClick={() => setRoleOverride(oppositeRole)}
          />
        </div>

        {isOverridden && (
          <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-3 py-2">
            UI views are overridden. Server-enforced actions (status changes, user management) still use your real role.
          </div>
        )}
      </div>
    </div>
  );
}

function RoleButton({
  role,
  label,
  active,
  onClick,
}: {
  role: UserRole;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const dotColor = role === 'advisor' ? 'bg-[var(--green)]' : 'bg-[var(--blue-muted)]';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
        active
          ? 'bg-[var(--bg-pill)] text-white shadow-sm'
          : 'bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover,var(--bg-surface))]'
      }`}
    >
      <span className={`w-[6px] h-[6px] rounded-full ${active ? 'bg-white/80' : dotColor}`} />
      <span className="capitalize">{label}</span>
    </button>
  );
}
