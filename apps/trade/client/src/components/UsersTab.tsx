import { useState, useEffect, useCallback, useRef } from 'react';
import { UserPlus, Shield, ShieldCheck, UserX, RotateCcw, MessageSquare } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { AuthUser, UserRole } from '@trade-request/shared';
import {
  fetchUsers,
  inviteUser,
  updateUserRole,
  deactivateUser,
  reactivateUser,
  updateSlackId,
  invalidateUsersCache,
  extractApiError,
} from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Tooltip } from './ui/Tooltip';

export function UsersTab() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', name: '', role: 'advisor' as UserRole });
  const [inviteError, setInviteError] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingSlack, setEditingSlack] = useState<string | null>(null);
  const [slackInput, setSlackInput] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Set on mount too: React's development double-mount runs the cleanup once before the real mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (bustCache = false) => {
    if (bustCache) invalidateUsersCache();
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchUsers();
      if (!mountedRef.current) return;
      setUsers(data);
    } catch {
      if (!mountedRef.current) return;
      setLoadError('Failed to load users. Please try again.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleInvite = async () => {
    setInviteError('');
    setBusyAction('invite');
    try {
      await inviteUser(inviteForm);
      if (!mountedRef.current) return;
      setShowInvite(false);
      setInviteForm({ email: '', name: '', role: 'advisor' });
      load(true);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setInviteError(extractApiError(err, 'Failed to invite user'));
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleRoleChange = async (id: string, role: UserRole) => {
    if (!window.confirm(`Change this user's role to ${role}?`)) return;
    setActionError('');
    setBusyAction(`role-${id}`);
    try {
      await updateUserRole(id, role);
      if (!mountedRef.current) return;
      load(true);
    } catch (_err: unknown) {
      if (!mountedRef.current) return;
      setActionError('Failed to update role. Please try again.');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!window.confirm('Are you sure you want to deactivate this user?')) return;
    setActionError('');
    setBusyAction(`deactivate-${id}`);
    try {
      await deactivateUser(id);
      if (!mountedRef.current) return;
      load(true);
    } catch (_err: unknown) {
      if (!mountedRef.current) return;
      setActionError('Failed to deactivate user. Please try again.');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleReactivate = async (id: string) => {
    setActionError('');
    setBusyAction(`reactivate-${id}`);
    try {
      await reactivateUser(id);
      if (!mountedRef.current) return;
      load(true);
    } catch (_err: unknown) {
      if (!mountedRef.current) return;
      setActionError('Failed to reactivate user. Please try again.');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const startEditSlack = (user: AuthUser) => {
    setEditingSlack(user.id);
    setSlackInput(user.slackUserId ?? '');
  };

  const savingSlackRef = useRef(false);
  const slackCancelledRef = useRef(false);
  const saveSlack = async (userId: string) => {
    if (savingSlackRef.current || slackCancelledRef.current) return;
    savingSlackRef.current = true;
    setActionError('');
    try {
      await updateSlackId(userId, slackInput.trim());
      if (!mountedRef.current) return;
      setEditingSlack(null);
      load(true);
    } catch {
      if (!mountedRef.current) return;
      setActionError('Failed to save Slack ID. Please try again.');
    } finally {
      savingSlackRef.current = false;
    }
  };

  const handleSlackKeyDown = (e: React.KeyboardEvent, userId: string) => {
    if (e.key === 'Enter') saveSlack(userId);
    if (e.key === 'Escape') {
      slackCancelledRef.current = true;
      setEditingSlack(null);
      setTimeout(() => {
        slackCancelledRef.current = false;
      }, 0);
    }
  };

  const inviteModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(inviteModalRef, showInvite);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-serif text-[22px] font-medium text-[var(--text-primary)]">User Management</h2>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--bg-pill)] text-white rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity"
        >
          <UserPlus size={15} />
          Invite User
        </button>
      </div>

      {/* Invite Modal */}
      {showInvite && (
        <div
          className="fixed inset-0 bg-black/25 z-50 flex items-center justify-center"
          onClick={() => setShowInvite(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowInvite(false);
          }}
        >
          <div
            ref={inviteModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-modal-title"
            className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border)] shadow-lg w-full max-w-[420px] p-7"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowInvite(false);
                return;
              }
              e.stopPropagation();
            }}
          >
            <h3 id="invite-modal-title" className="font-serif text-[18px] font-medium text-[var(--text-primary)] mb-5">
              Invite New User
            </h3>

            {inviteError && (
              <div className="mb-4 bg-[var(--red-light)] border border-[var(--red-border)] rounded-xl px-4 py-3 text-[13px] text-[var(--red)]">
                {inviteError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="invite-name"
                  className="block text-[12px] font-semibold uppercase tracking-wider text-[var(--text-label)] mb-1"
                >
                  Full Name
                </label>
                <input
                  id="invite-name"
                  value={inviteForm.name}
                  onChange={(e) => setInviteForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[14px] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--bg-pill)]"
                  placeholder="Jane Smith"
                />
              </div>
              <div>
                <label
                  htmlFor="invite-email"
                  className="block text-[12px] font-semibold uppercase tracking-wider text-[var(--text-label)] mb-1"
                >
                  Email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[14px] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--bg-pill)]"
                  placeholder="jane@example.org"
                />
              </div>
              <div>
                <label
                  htmlFor="invite-role"
                  className="block text-[12px] font-semibold uppercase tracking-wider text-[var(--text-label)] mb-1"
                >
                  Role
                </label>
                <select
                  id="invite-role"
                  value={inviteForm.role}
                  onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                  className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-[14px] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--bg-pill)]"
                >
                  <option value="advisor">Advisor</option>
                  <option value="trader">Trader</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowInvite(false)}
                className="px-4 py-2 text-[13px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleInvite}
                disabled={
                  !inviteForm.email ||
                  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteForm.email) ||
                  !inviteForm.name ||
                  busyAction === 'invite'
                }
                className="px-5 py-2 bg-[var(--bg-pill)] text-white rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {busyAction === 'invite' ? 'Sending...' : 'Send Invite'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] overflow-hidden overflow-x-auto">
        {actionError && (
          <div className="mx-5 mt-4 bg-[var(--red-light)] border border-[var(--red-border)] rounded-xl px-4 py-3 text-[13px] text-[var(--red)]">
            {actionError}
          </div>
        )}
        {loadError ? (
          <div className="p-8 text-center">
            <div className="text-[var(--red)] text-sm mb-3">{loadError}</div>
            <button
              onClick={() => load(true)}
              className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="p-8 text-center text-[var(--text-muted)] text-[14px]">Loading users...</div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="bg-[var(--bg-surface)]">
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)]">
                  User
                </th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)]">
                  Email
                </th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)]">
                  Role
                </th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)]">
                  <Tooltip content="Slack member ID for trade notifications" position="bottom">
                    <span className="cursor-help">Slack</span>
                  </Tooltip>
                </th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)]">
                  Status
                </th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)]">
                  Last Login
                </th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-label)] text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={`border-t border-[var(--border-light)] ${!u.isActive ? 'opacity-50' : ''}`}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      {u.picture ? (
                        <img src={u.picture} alt="" className="w-7 h-7 rounded-full" />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-[var(--bg-surface)] flex items-center justify-center text-[11px] font-bold text-[var(--text-label)]">
                          {u.name.charAt(0)}
                        </div>
                      )}
                      <span className="font-medium text-[var(--text-primary)]">
                        {u.name}
                        {currentUser?.id === u.id && (
                          <span className="ml-1.5 text-[11px] text-[var(--text-muted)] font-normal">(You)</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[var(--text-muted)]">{u.email}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium ${
                        u.role === 'trader'
                          ? 'bg-[var(--blue-light)] text-[var(--blue-muted)]'
                          : 'bg-[var(--green-light)] text-[var(--green)]'
                      }`}
                    >
                      {u.role === 'trader' ? <ShieldCheck size={12} /> : <Shield size={12} />}
                      {u.role.charAt(0).toUpperCase() + u.role.slice(1)}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {editingSlack === u.id ? (
                      <input
                        autoFocus
                        value={slackInput}
                        onChange={(e) => setSlackInput(e.target.value)}
                        onBlur={() => saveSlack(u.id)}
                        onKeyDown={(e) => handleSlackKeyDown(e, u.id)}
                        placeholder="U0123456789"
                        className="w-28 border border-[var(--border)] rounded-md px-2 py-1 text-[12px] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--bg-pill)] font-mono"
                      />
                    ) : (
                      <Tooltip content="Click to edit Slack ID" position="bottom">
                        <button
                          onClick={() => startEditSlack(u)}
                          className="flex items-center gap-1.5 text-[12px] font-mono hover:text-[var(--text-primary)] transition-colors"
                        >
                          {u.slackUserId ? (
                            <span className="flex items-center gap-1 text-[var(--text-primary)]">
                              <MessageSquare size={11} className="text-[var(--green)]" />
                              {u.slackUserId}
                            </span>
                          ) : (
                            <span className="text-[var(--text-muted)] italic">Not linked</span>
                          )}
                        </button>
                      </Tooltip>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`text-[12px] font-medium ${u.isActive ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
                    >
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-[var(--text-muted)]">
                    {u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {currentUser?.id === u.id ? (
                        <span className="px-2 py-1 text-[12px] text-[var(--text-muted)]">
                          {u.role.charAt(0).toUpperCase() + u.role.slice(1)}
                        </span>
                      ) : (
                        <>
                          <select
                            value={u.role}
                            disabled={busyAction === `role-${u.id}`}
                            onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                            className="border border-[var(--border)] rounded-md px-2 py-1 text-[12px] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none disabled:opacity-50"
                          >
                            <option value="advisor">Advisor</option>
                            <option value="trader">Trader</option>
                          </select>
                          {u.isActive ? (
                            <Tooltip content="Revoke this user's access" position="left">
                              <button
                                onClick={() => handleDeactivate(u.id)}
                                disabled={busyAction === `deactivate-${u.id}`}
                                aria-label="Deactivate"
                                className="p-1.5 text-[var(--text-muted)] hover:text-[var(--red)] transition-colors disabled:opacity-50"
                              >
                                <UserX size={14} />
                              </button>
                            </Tooltip>
                          ) : (
                            <Tooltip content="Restore this user's access" position="left">
                              <button
                                onClick={() => handleReactivate(u.id)}
                                disabled={busyAction === `reactivate-${u.id}`}
                                aria-label="Reactivate"
                                className="p-1.5 text-[var(--text-muted)] hover:text-[var(--green)] transition-colors disabled:opacity-50"
                              >
                                <RotateCcw size={14} />
                              </button>
                            </Tooltip>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
