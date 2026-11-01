import { useState, useEffect, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bell, LogOut, Sun, Moon, Monitor, Menu, X, Wrench } from 'lucide-react';
import type { Notification, AuthUser, ThemePreference } from '@trade-request/shared';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { Tooltip } from './ui/Tooltip';
import { PortfolioLink } from './PortfolioLink';

interface Props {
  user: AuthUser;
  activeView: string;
  onViewChange: (view: string) => void;
  notifications: Notification[];
  unreadCount: number;
  onMarkRead: (id: string) => void | Promise<void>;
  onMarkAllRead: () => void | Promise<void>;
  /** When true, today's drift results are available and unseen — highlights the Drift tab. */
  driftHasNewResults?: boolean;
  /** MCP-only service mode: only the Connected Apps tab, no notification bell. */
  connectedAppsOnly?: boolean;
}

export function TopNav({
  user,
  activeView,
  onViewChange,
  notifications,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
  driftHasNewResults = false,
  connectedAppsOnly = false,
}: Props) {
  const { logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const [showNotifications, setShowNotifications] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);

  const cycleTheme = () => {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    setPreference(order[(order.indexOf(preference) + 1) % order.length]);
  };

  const closeNotifications = useCallback(() => setShowNotifications(false), []);

  useEffect(() => {
    if (!showNotifications) return;
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        closeNotifications();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNotifications();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showNotifications, closeNotifications]);

  const { roleOverride, actualUser, isDemo, canDemo, toggleDemo, hasOutbox } = useAuth();
  const isRoleOverridden = roleOverride !== null && actualUser !== null && roleOverride !== actualUser.role;

  const tabs = connectedAppsOnly
    ? [{ id: 'connected-apps', label: 'Connected Apps' }]
    : [
        { id: 'home', label: 'Home' },
        { id: 'form', label: 'New Request' },
        { id: 'queue', label: 'Trading Queue' },
        { id: 'drift', label: 'Drift' },
        ...(user.role === 'trader' ? [{ id: 'users', label: 'Users' }] : []),
        { id: 'connected-apps', label: 'Connected Apps' },
        ...(hasOutbox ? [{ id: 'outbox', label: 'Outbox' }] : []),
      ];

  const isActiveTab = (id: string) =>
    activeView === id ||
    (id === 'queue' &&
      (activeView.startsWith('modal-') || activeView.startsWith('edit-') || activeView.startsWith('clone-')));

  const handleNavClick = (id: string) => {
    onViewChange(id);
    setMobileMenuOpen(false);
  };

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const first = mobileMenuRef.current?.querySelector<HTMLElement>('button[role="menuitem"]');
    first?.focus();
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        mobileMenuRef.current &&
        !mobileMenuRef.current.contains(e.target as Node) &&
        !menuToggleRef.current?.contains(e.target as Node)
      ) {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [mobileMenuOpen]);

  return (
    <nav
      className="bg-[var(--bg-card)] border-b border-[var(--border)] px-4 md:px-7 h-14 flex justify-between items-center sticky top-0 z-40"
      role="navigation"
      aria-label="Trade Center"
    >
      <div className="flex items-center gap-3 md:gap-4">
        <PortfolioLink label="Portfolio" compact className="pr-3 md:pr-4 border-r border-[var(--border)]" />
        <div className="text-[17px] tracking-tight text-[var(--text-primary)]">
          cedarRidge<sup className="text-[9px] italic text-[var(--text-muted)]">.ai</sup>
        </div>
        <span className="text-[13px] text-[var(--text-muted)] hidden sm:inline xl:hidden 2xl:inline whitespace-nowrap">
          Trade Center
        </span>

        {/* The full tab row needs about 1,250px with every tab, so it starts at xl with tighter tabs and drops
            the "Trade Center" label until 2xl; narrower screens use the menu below. */}
        <div className="hidden xl:flex bg-[var(--bg-surface)] rounded-full p-[3px] gap-0.5 ml-4">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() => handleNavClick(tab.id)}
              aria-current={isActiveTab(tab.id) ? 'page' : undefined}
              className={`px-3 2xl:px-[18px] py-1.5 text-[13px] font-medium rounded-full whitespace-nowrap transition-colors ${
                isActiveTab(tab.id)
                  ? 'bg-[var(--bg-pill)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab.label}
              {tab.id === 'drift' && driftHasNewResults && (
                <span
                  className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[var(--yellow)] animate-pulse align-middle"
                  aria-label="New drift results available today"
                  title="New drift results available today"
                />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 md:gap-3">
        <Tooltip content={`Theme: ${preference}`} position="bottom">
          <button
            type="button"
            onClick={cycleTheme}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            aria-label={`Theme: ${preference}. Click to change.`}
          >
            {preference === 'light' && <Sun size={16} />}
            {preference === 'dark' && <Moon size={16} />}
            {preference === 'system' && <Monitor size={16} />}
          </button>
        </Tooltip>

        {canDemo && (
          <Tooltip content={isDemo ? 'Exit demo mode' : 'Enter demo mode'} position="bottom">
            <button
              type="button"
              onClick={toggleDemo}
              className={`px-2 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md border-2 transition-all flex items-center gap-1.5 ${
                isDemo
                  ? 'border-amber-500 bg-amber-500 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-amber-950'
                  : 'border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50'
              }`}
              aria-label={isDemo ? 'Exit demo mode' : 'Enter demo mode'}
            >
              <Wrench size={12} />
              Demo
            </button>
          </Tooltip>
        )}

        {!connectedAppsOnly && (
          <div className="relative" ref={notifRef}>
            <Tooltip
              content={
                unreadCount > 0 ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}` : 'Notifications'
              }
              position="bottom"
            >
              <button
                type="button"
                onClick={() => setShowNotifications((s) => !s)}
                aria-label="Notifications"
                aria-expanded={showNotifications}
                aria-haspopup="true"
                className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] relative"
              >
                <Bell size={18} />
                {unreadCount > 0 && (
                  <>
                    <span
                      className="absolute top-1 right-1 w-[5px] h-[5px] bg-[var(--red)] rounded-full"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{unreadCount} unread</span>
                  </>
                )}
              </button>
            </Tooltip>

            {showNotifications && (
              <div
                className="absolute right-0 mt-2 w-80 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-lg overflow-hidden z-50"
                role="region"
                aria-label="Notifications"
              >
                <div className="px-4 py-3 border-b border-[var(--border)] flex justify-between items-center">
                  <h3 className="text-sm font-bold text-[var(--text-primary)]">Notifications</h3>
                  <button
                    type="button"
                    onClick={onMarkAllRead}
                    className="text-xs text-[var(--text-label)] hover:text-[var(--text-primary)]"
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="p-4 text-sm text-[var(--text-muted)] text-center">No notifications</div>
                  ) : (
                    notifications.map((n) => (
                      <button
                        type="button"
                        key={n.id}
                        onClick={() => onMarkRead(n.id)}
                        className={`w-full text-left p-4 border-b border-[var(--border-light)] cursor-pointer hover:bg-[var(--bg-surface)] ${
                          !n.isRead ? 'bg-[var(--blue-light)]' : ''
                        }`}
                      >
                        <p
                          className={`text-sm ${!n.isRead ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)]'}`}
                        >
                          {n.message}
                        </p>
                        <p className="text-xs text-[var(--text-muted)] mt-1">{new Date(n.date).toLocaleString()}</p>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="hidden xl:flex items-center gap-2 bg-[var(--bg-surface)] rounded-lg px-3 py-1.5">
          {user.picture ? (
            <img src={user.picture} alt="" className="w-6 h-6 rounded-full" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-[var(--bg-pill)] flex items-center justify-center text-[10px] font-bold text-white">
              {user.name.charAt(0)}
            </div>
          )}
          <span className="text-[13px] font-semibold text-[var(--text-primary)] whitespace-nowrap">{user.name}</span>
          <span
            className={`w-[7px] h-[7px] rounded-full ${user.role === 'advisor' ? 'bg-[var(--green)]' : 'bg-[var(--blue-muted)]'}`}
          />
          <span className="text-[11px] text-[var(--text-muted)] capitalize">{user.role}</span>
          {(isRoleOverridden || isDemo) && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
              demo
            </span>
          )}
        </div>

        <Tooltip content="Sign out" position="bottom">
          <button
            type="button"
            onClick={logout}
            className="hidden xl:block p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </Tooltip>

        <button
          ref={menuToggleRef}
          type="button"
          onClick={() => setMobileMenuOpen((s) => !s)}
          className="xl:hidden p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          aria-label="Menu"
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {mobileMenuOpen && (
        <div
          ref={mobileMenuRef}
          className="absolute top-14 left-0 right-0 bg-[var(--bg-card)] border-b border-[var(--border)] shadow-lg z-50 xl:hidden"
          role="menu"
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key === 'Escape') {
              setMobileMenuOpen(false);
              menuToggleRef.current?.focus();
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const items = mobileMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
              if (!items?.length) return;
              const idx = Array.from(items).indexOf(e.target as HTMLElement);
              const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
              items[next].focus();
            }
          }}
        >
          <div className="p-4 space-y-1">
            {tabs.map((tab) => (
              <button
                type="button"
                role="menuitem"
                key={tab.id}
                onClick={() => handleNavClick(tab.id)}
                className={`w-full text-left px-4 py-2.5 rounded-lg text-[14px] font-medium transition-colors ${
                  isActiveTab(tab.id)
                    ? 'bg-[var(--bg-pill)] text-white'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              {user.picture ? (
                <img src={user.picture} alt="" className="w-6 h-6 rounded-full" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-[var(--bg-pill)] flex items-center justify-center text-[10px] font-bold text-white">
                  {user.name.charAt(0)}
                </div>
              )}
              <span className="text-[13px] font-semibold text-[var(--text-primary)]">{user.name}</span>
              <span className="text-[11px] text-[var(--text-muted)] capitalize">({user.role})</span>
              {(isRoleOverridden || isDemo) && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
                  demo
                </span>
              )}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
