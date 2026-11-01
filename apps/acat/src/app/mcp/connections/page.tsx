"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, Key, Link2, Loader2, Plus, Trash2, X } from "lucide-react";
import { demoMode } from "@/lib/demo/mode";

type ConnectionSummary = {
  id: string;
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

type PatSummary = {
  id: string;
  name: string;
  prefix: string;
  lastFour: string;
  scopes: string[];
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

// The read-only tools the MCP server offers (src/lib/mcp/tools.ts).
const DEMO_TOOL_SUMMARIES: [string, string][] = [
  ["search_acats", "Search active transfers by client, account, control number, custodian or status."],
  ["get_acat_record", "One transfer with its assets; account numbers are redacted."],
  ["list_acats_by_status", "Active transfers in one operational status."],
  ["get_reconciliation_summary", "Reconciliation status counts and open exceptions."],
  ["list_custodians", "Custodians with their SLA and observed completion timing."],
  ["get_custodian_profile", "One custodian's transfer playbook and fee rules, without client history."],
  ["get_custodian_fee_rules", "The fee rules used for fee reconciliation."],
];

export default function McpConnectionsPage() {
  return demoMode() ? <McpOffInDemo /> : <McpConnections />;
}

function McpOffInDemo() {
  const router = useRouter();
  return (
    <main className="min-h-screen bg-surface px-6 py-10 text-foreground">
      <div className="mx-auto max-w-3xl space-y-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            aria-label="Back"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="mb-1 text-2xl font-semibold">Claude MCP Access</h1>
            <p className="text-sm text-muted">Off in this demo.</p>
          </div>
        </div>
        <section className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Link2 size={14} className="text-muted" />
            What this page does in the real app
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            Staff generate a personal access token here for Claude Code, or connect claude.ai through OAuth, and Claude can
            then read the transfer queue through an MCP server. Every tool is read-only, and account numbers are redacted
            before anything leaves the app. The demo doesn&apos;t run that server, so tokens can&apos;t be created here.
          </p>
          <ul className="mt-4 divide-y divide-card-border rounded-lg border border-card-border">
            {DEMO_TOOL_SUMMARIES.map(([name, summary]) => (
              <li key={name} className="px-3 py-2.5 text-sm">
                <code className="font-mono text-xs text-foreground">{name}</code>
                <p className="mt-0.5 text-xs text-muted">{summary}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

function McpConnections() {
  const router = useRouter();
  const [connectorUrl, setConnectorUrl] = useState("");
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [pats, setPats] = useState<PatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // PAT creation state
  const [newTokenName, setNewTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [cmdCopied, setCmdCopied] = useState(false);

  const loadConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/connections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConnectorUrl(data.connectorUrl);
      setConnections(data.connections);
    } catch {
      setError("Failed to load connections");
    }
  }, []);

  const loadPats = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/pat");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPats(await res.json());
    } catch {
      setError("Failed to load tokens");
    }
  }, []);

  const loadConnectionsRef = useRef(loadConnections);
  const loadPatsRef = useRef(loadPats);
  useEffect(() => {
    loadConnectionsRef.current = loadConnections;
    loadPatsRef.current = loadPats;
  }, [loadConnections, loadPats]);
  useEffect(() => {
    void loadConnectionsRef.current();
    void loadPatsRef.current();
  }, []);

  const revokeConnection = async (connectionId: string) => {
    const res = await fetch(`/api/mcp/connections?connectionId=${connectionId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError("Failed to revoke connection");
      return;
    }
    await loadConnections();
  };

  const createToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/pat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create token");
      setNewToken({ token: data.token, name: data.name });
      setNewTokenName("");
      await loadPats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (id: string) => {
    const res = await fetch(`/api/mcp/pat?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Failed to revoke token");
      return;
    }
    await loadPats();
  };

  const copyToClipboard = async (text: string, onDone: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      onDone();
      setTimeout(onDone, 2000);
    } catch {
      setError("Failed to copy to clipboard");
    }
  };

  const activePats = pats.filter((t) => !t.revokedAt);
  const revokedPats = pats.filter((t) => t.revokedAt);

  return (
    <main className="min-h-screen bg-surface px-6 py-10 text-foreground">
      <div className="mx-auto max-w-3xl space-y-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="mb-1 text-2xl font-semibold">Claude MCP Access</h1>
            <p className="text-sm text-muted">
              Generate a personal access token and add the Transfer Tracker as an MCP server in Claude Code.
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2.5 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-3 text-sm text-[color:var(--danger)]">
            {error}
            <button onClick={() => setError(null)} className="ml-auto">
              <X size={14} />
            </button>
          </div>
        )}

        {/* One-time token reveal */}
        {newToken && (
          <div className="rounded-xl border border-[color:var(--success-border)] bg-[color:var(--success-bg)] p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-[color:var(--success)]">
                Token created — copy it now, it won&apos;t be shown again.
              </p>
              <button
                onClick={() => setNewToken(null)}
                className="text-muted hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            {/* Raw token */}
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 font-mono text-xs">
              <span className="flex-1 break-all text-foreground">{newToken.token}</span>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(newToken.token, () => setCopied((p) => !p))
                }
                className="shrink-0 text-muted hover:text-foreground"
                title="Copy token"
              >
                {copied ? <Check size={14} className="text-[color:var(--success)]" /> : <Copy size={14} />}
              </button>
            </div>

            {/* claude mcp add command */}
            <p className="mb-1 text-xs font-medium text-muted">Add to Claude Code:</p>
            <div className="flex items-center gap-2 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 font-mono text-xs">
              <span className="flex-1 break-all text-foreground">
                {`claude mcp add --transport http transfer-tracker ${connectorUrl} --header "Authorization: Bearer ${newToken.token}"`}
              </span>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(
                    `claude mcp add --transport http transfer-tracker ${connectorUrl} --header "Authorization: Bearer ${newToken.token}"`,
                    () => setCmdCopied((p) => !p)
                  )
                }
                className="shrink-0 text-muted hover:text-foreground"
                title="Copy command"
              >
                {cmdCopied ? <Check size={14} className="text-[color:var(--success)]" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}

        {/* Create token */}
        <section className="rounded-xl border border-card-border bg-[var(--bg-card)] p-6">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Key size={15} className="text-accent" />
            Personal Access Tokens
          </h2>
          <form onSubmit={createToken} className="mb-5 flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted">
                Token name
              </label>
              <input
                type="text"
                required
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g. My MacBook"
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
            <button
              type="submit"
              disabled={creating || !newTokenName.trim()}
              className="flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              Generate
            </button>
          </form>

          <div className="space-y-2">
            {activePats.map((token) => (
              <div
                key={token.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-card-border px-3 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{token.name}</p>
                  <p className="text-muted">
                    <span className="font-mono">{token.prefix}…{token.lastFour}</span>
                    {token.lastUsedAt
                      ? ` · Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : " · Never used"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revokeToken(token.id)}
                  className="flex shrink-0 items-center gap-1 rounded bg-[color:var(--danger-bg)] px-2 py-1 font-medium text-[color:var(--danger)]"
                >
                  <Trash2 size={12} />
                  Revoke
                </button>
              </div>
            ))}
            {activePats.length === 0 && (
              <p className="rounded-lg border border-card-border px-3 py-6 text-center text-xs text-muted">
                No active tokens. Generate one above.
              </p>
            )}
          </div>

          {revokedPats.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
                {revokedPats.length} revoked token{revokedPats.length !== 1 ? "s" : ""}
              </summary>
              <div className="mt-2 space-y-2">
                {revokedPats.map((token) => (
                  <div
                    key={token.id}
                    className="flex items-center gap-3 rounded-lg border border-card-border px-3 py-2.5 text-xs opacity-50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">{token.name}</p>
                      <p className="text-muted">
                        <span className="font-mono">{token.prefix}…{token.lastFour}</span>
                        {" · Revoked "}
                        {new Date(token.revokedAt!).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        {/* OAuth connections */}
        {connections.length > 0 && (
          <section className="rounded-xl border border-card-border bg-[var(--bg-card)] p-6">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Link2 size={15} className="text-accent" />
              OAuth Connections
            </h2>
            <div className="space-y-2">
              {connections.map((connection) => (
                <div
                  key={connection.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-card-border px-3 py-2.5"
                >
                  <div>
                    <p className="text-sm font-medium">{connection.clientName || "Claude"}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {connection.revokedAt
                        ? "Revoked"
                        : `Expires ${new Date(connection.expiresAt).toLocaleDateString()}`}
                      {connection.lastUsedAt
                        ? ` · Last used ${new Date(connection.lastUsedAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  {!connection.revokedAt && (
                    <button
                      type="button"
                      onClick={() => revokeConnection(connection.id)}
                      className="flex shrink-0 items-center gap-1 rounded bg-[color:var(--danger-bg)] px-2 py-1 text-xs font-medium text-[color:var(--danger)]"
                    >
                      <Trash2 size={12} />
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
