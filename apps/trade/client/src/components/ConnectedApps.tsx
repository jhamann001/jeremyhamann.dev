import { useState, useEffect, useCallback, useRef } from 'react';
import { LogOut, RefreshCw, Copy, Plus, AlertTriangle, Trash2 } from 'lucide-react';
import {
  fetchMcpSessions,
  revokeMcpSession,
  revokeAllMcpSessions,
  fetchMcpPats,
  createMcpPat,
  revokeMcpPat,
  extractApiError,
  type McpSession,
  type McpPatMetadata,
  type CreatedMcpPat,
} from '../api/client';

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ConnectedApps() {
  // OAuth-issued sessions
  const [sessions, setSessions] = useState<McpSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsLoadError, setSessionsLoadError] = useState<string | null>(null);

  // Personal Access Tokens (PATs)
  const [pats, setPats] = useState<McpPatMetadata[]>([]);
  const [patsLoading, setPatsLoading] = useState(true);
  const [patsLoadError, setPatsLoadError] = useState<string | null>(null);

  // Shared action state
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // PAT generate modal state
  const [showGenerate, setShowGenerate] = useState(false);
  const [generateName, setGenerateName] = useState('');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [createdPat, setCreatedPat] = useState<CreatedMcpPat | null>(null);
  const [copied, setCopied] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    // Set on mount too: React's development double-mount runs the cleanup once before the real mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsLoadError(null);
    try {
      const data = await fetchMcpSessions();
      if (!mountedRef.current) return;
      setSessions(data);
    } catch (err) {
      if (!mountedRef.current) return;
      setSessionsLoadError(extractApiError(err, 'Failed to load connected apps'));
    } finally {
      if (mountedRef.current) setSessionsLoading(false);
    }
  }, []);

  const loadPats = useCallback(async () => {
    setPatsLoading(true);
    setPatsLoadError(null);
    try {
      const data = await fetchMcpPats();
      if (!mountedRef.current) return;
      setPats(data);
    } catch (err) {
      if (!mountedRef.current) return;
      setPatsLoadError(extractApiError(err, 'Failed to load API tokens'));
    } finally {
      if (mountedRef.current) setPatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadPats();
  }, [loadSessions, loadPats]);

  const handleRevokeSession = async (familyId: string, clientName: string) => {
    if (!window.confirm(`Revoke access for "${clientName}"? This will sign that app out immediately.`)) return;
    setActionError(null);
    setBusyAction(`revoke-${familyId}`);
    try {
      await revokeMcpSession(familyId);
      if (!mountedRef.current) return;
      setSessions((prev) => prev.filter((s) => s.familyId !== familyId));
    } catch (err) {
      if (!mountedRef.current) return;
      setActionError(extractApiError(err, 'Failed to revoke session'));
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleRevokeAllSessions = async () => {
    if (sessions.length === 0) return;
    if (!window.confirm(`Revoke all ${sessions.length} connected apps? You'll need to sign in again from each.`))
      return;
    setActionError(null);
    setBusyAction('revoke-all-sessions');
    try {
      await revokeAllMcpSessions();
      if (!mountedRef.current) return;
      setSessions([]);
    } catch (err) {
      if (!mountedRef.current) return;
      setActionError(extractApiError(err, 'Failed to revoke all sessions'));
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleRevokePat = async (id: string, name: string) => {
    if (!window.confirm(`Revoke API token "${name}"? Any client using it will get a 401 immediately.`)) return;
    setActionError(null);
    setBusyAction(`revoke-pat-${id}`);
    try {
      await revokeMcpPat(id);
      if (!mountedRef.current) return;
      setPats((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      if (!mountedRef.current) return;
      setActionError(extractApiError(err, 'Failed to revoke token'));
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const openGenerate = () => {
    setGenerateName('');
    setGenerateError(null);
    setCreatedPat(null);
    setCopied(false);
    setShowGenerate(true);
  };

  const closeGenerate = () => {
    // Defensive: drop the cleartext token from memory when the modal closes.
    setCreatedPat(null);
    setShowGenerate(false);
    setGenerateName('');
    setGenerateError(null);
    setCopied(false);
    // Refresh the PAT list so the just-created token shows up.
    if (mountedRef.current) loadPats();
  };

  const handleGenerate = async () => {
    const name = generateName.trim();
    if (!name) {
      setGenerateError('Please give the token a name');
      return;
    }
    setGenerateError(null);
    setBusyAction('generate-pat');
    try {
      const result = await createMcpPat(name);
      if (!mountedRef.current) return;
      setCreatedPat(result);
    } catch (err) {
      if (!mountedRef.current) return;
      setGenerateError(extractApiError(err, 'Failed to generate token'));
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const handleCopyToken = async () => {
    if (!createdPat) return;
    try {
      await navigator.clipboard.writeText(createdPat.token);
      setCopied(true);
      window.setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 2000);
    } catch {
      setGenerateError('Could not copy to clipboard. Select and copy the token manually.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Connected apps</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          MCP clients you've authorized to query the trade request API on your behalf, plus API tokens you've generated
          for clients that don't speak OAuth (like Claude Desktop).
        </p>
      </div>

      {actionError && (
        <div className="mb-4 px-4 py-2 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md">
          {actionError}
        </div>
      )}

      {/* ─── API Tokens (PATs) ───────────────────────────────────────────── */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-3 gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">API tokens</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Long-lived tokens for clients that don't support OAuth. The token is shown once at generation and never
              again.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadPats()}
              disabled={patsLoading}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={patsLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              type="button"
              onClick={openGenerate}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-md hover:bg-[var(--bg-pill-hover)] transition-colors"
            >
              <Plus size={14} />
              Generate token
            </button>
          </div>
        </div>

        {patsLoadError && (
          <div className="mb-3 px-4 py-2 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md">
            {patsLoadError}
          </div>
        )}

        {patsLoading && pats.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm">Loading…</div>
        ) : pats.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm border border-dashed border-[var(--border)] rounded-lg">
            You haven't generated any API tokens yet.
          </div>
        ) : (
          <div className="border border-[var(--border)] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg-surface)]">
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Last used</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pats.map((p) => (
                  <tr key={p.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 text-[var(--text-primary)] font-medium">{p.name}</td>
                    <td className="px-4 py-3 text-[var(--text-muted)]" title={formatAbsolute(p.createdAt)}>
                      {formatRelative(p.createdAt)}
                    </td>
                    <td
                      className="px-4 py-3 text-[var(--text-muted)]"
                      title={p.lastUsedAt ? formatAbsolute(p.lastUsedAt) : 'Never used'}
                    >
                      {p.lastUsedAt ? formatRelative(p.lastUsedAt) : 'never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRevokePat(p.id, p.name)}
                        disabled={busyAction !== null}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                        {busyAction === `revoke-pat-${p.id}` ? 'Revoking…' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── OAuth-issued sessions ───────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3 gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">OAuth sessions</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              MCP clients you've signed into via Google OAuth. Each row is one Claude Code or Claude Desktop install.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadSessions()}
              disabled={sessionsLoading}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={sessionsLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
            {sessions.length > 1 && (
              <button
                type="button"
                onClick={handleRevokeAllSessions}
                disabled={busyAction !== null}
                className="px-3 py-1.5 text-sm font-medium border border-red-500 text-red-600 dark:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors"
              >
                Revoke all
              </button>
            )}
          </div>
        </div>

        {sessionsLoadError && (
          <div className="mb-3 px-4 py-2 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md">
            {sessionsLoadError}
          </div>
        )}

        {sessionsLoading && sessions.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm border border-dashed border-[var(--border)] rounded-lg">
            No active OAuth sessions.
            <div className="mt-2 text-xs">
              To connect Claude Code, run{' '}
              <code className="px-1.5 py-0.5 bg-[var(--bg-surface)] rounded">
                claude mcp add --transport http trade-request {window.location.origin}/mcp
              </code>
            </div>
          </div>
        ) : (
          <div className="border border-[var(--border)] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg-surface)]">
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="px-4 py-2.5 font-medium">App</th>
                  <th className="px-4 py-2.5 font-medium">Authorized</th>
                  <th className="px-4 py-2.5 font-medium">Last active</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const lastActive = s.lastAccessTokenAt ?? s.lastRefreshedAt;
                  return (
                    <tr key={s.familyId} className="border-t border-[var(--border)]">
                      <td className="px-4 py-3 text-[var(--text-primary)]">
                        <div className="font-medium">{s.clientName}</div>
                        <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{s.clientId}</div>
                      </td>
                      <td className="px-4 py-3 text-[var(--text-muted)]" title={formatAbsolute(s.registeredAt)}>
                        {formatRelative(s.registeredAt)}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-muted)]" title={formatAbsolute(lastActive)}>
                        {formatRelative(lastActive)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleRevokeSession(s.familyId, s.clientName)}
                          disabled={busyAction !== null}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded transition-colors disabled:opacity-50"
                        >
                          <LogOut size={12} />
                          {busyAction === `revoke-${s.familyId}` ? 'Revoking…' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Generate-PAT modal ──────────────────────────────────────────── */}
      {showGenerate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="generate-pat-title"
        >
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-xl w-full max-w-md">
            {!createdPat ? (
              <div className="p-6">
                <h3 id="generate-pat-title" className="text-lg font-semibold text-[var(--text-primary)]">
                  Generate API token
                </h3>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  Give the token a name you'll recognize so you can revoke it later if you lose the device.
                </p>
                <label className="block mt-4 text-sm font-medium text-[var(--text-primary)]">
                  Name
                  <input
                    type="text"
                    value={generateName}
                    onChange={(e) => setGenerateName(e.target.value)}
                    placeholder="e.g. Jeremy's MacBook"
                    maxLength={100}
                    autoFocus
                    className="mt-1 block w-full px-3 py-2 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
                  />
                </label>
                {generateError && (
                  <div className="mt-3 px-3 py-2 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md">
                    {generateError}
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={closeGenerate}
                    className="px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={busyAction === 'generate-pat'}
                    className="px-3 py-1.5 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-md hover:bg-[var(--bg-pill-hover)] disabled:opacity-50 transition-colors"
                  >
                    {busyAction === 'generate-pat' ? 'Generating…' : 'Generate'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-6">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-lg font-semibold text-[var(--text-primary)]">Copy your token now</h3>
                    <p className="text-sm text-[var(--text-muted)] mt-1">
                      This is the only time the token will be shown. Anyone with it can act as you against the trade
                      request API.
                    </p>
                  </div>
                </div>

                <div className="mt-4 px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-md flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-[var(--text-primary)] break-all select-all">
                    {createdPat.token}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-[var(--border)] rounded hover:bg-[var(--bg-card)] transition-colors"
                  >
                    <Copy size={12} />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <div className="mt-4 text-xs text-[var(--text-muted)]">
                  <p className="font-medium text-[var(--text-primary)] mb-1">For Claude Desktop, add to your config:</p>
                  <pre className="px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded text-[11px] overflow-auto">
                    {`"trade-request": {
  "type": "http",
  "url": "${window.location.origin}/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}`}
                  </pre>
                </div>

                {generateError && (
                  <div className="mt-3 px-3 py-2 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md">
                    {generateError}
                  </div>
                )}

                <div className="flex justify-end mt-6">
                  <button
                    type="button"
                    onClick={closeGenerate}
                    className="px-3 py-1.5 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-md hover:bg-[var(--bg-pill-hover)] transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
