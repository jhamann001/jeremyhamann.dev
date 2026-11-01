"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffectiveRole } from "@/lib/use-effective-role";
import {
  ArrowLeft,
  UserPlus,
  Shield,
  Users,
  Loader2,
  Check,
  X,
  AlertTriangle,
  Search,
} from "lucide-react";
import UserCard, { type AllowedUserSummary } from "@/components/UserCard";
import { demoMode } from "@/lib/demo/mode";
import { isPersonaEmail } from "@/lib/demo/personas";

type Segment = "all" | "active" | "inactive" | "admin";
type McpAdminSummary = {
  connectorUrl: string;
  settings: { enabled: boolean };
  connections: Array<{
    id: string;
    userEmail: string;
    clientName: string | null;
    scopes: string[];
    expiresAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }>;
  auditLogs: Array<{
    id: string;
    userEmail: string | null;
    toolName: string;
    status: string;
    createdAt: string;
  }>;
};

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "admin", label: "Admins" },
];

function matchesSegment(user: AllowedUserSummary, seg: Segment): boolean {
  switch (seg) {
    case "active":
      return user.active;
    case "inactive":
      return !user.active;
    case "admin":
      return user.role === "ADMIN";
    default:
      return true;
  }
}

export default function AdminPage() {
  const { data: session, status } = useSession();
  const { role: effectiveRole } = useEffectiveRole();
  const router = useRouter();
  const [users, setUsers] = useState<AllowedUserSummary[]>([]);
  const [mcpSummary, setMcpSummary] = useState<McpAdminSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  // ticket: ADVISOR is the third role tier; UserCard / API both accept it.
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "USER" | "ADVISOR">(
    "USER"
  );
  const [inviting, setInviting] = useState(false);

  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("all");

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUsers(data);
      setError(null);
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMcpSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/mcp");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMcpSummary(await res.json());
    } catch {
      setError("Failed to load MCP settings");
    }
  }, []);

  const fetchUsersRef = useRef(fetchUsers);
  const fetchMcpSummaryRef = useRef(fetchMcpSummary);
  useEffect(() => {
    fetchUsersRef.current = fetchUsers;
    fetchMcpSummaryRef.current = fetchMcpSummary;
  }, [fetchUsers, fetchMcpSummary]);
  useEffect(() => {
    if (status === "loading") return;
    if (!session || session.user.role !== "ADMIN" || effectiveRole !== "ADMIN") {
      router.push("/");
      return;
    }
    void fetchUsersRef.current();
    void fetchMcpSummaryRef.current();
  }, [session, status, router, effectiveRole]);

  const flashSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail,
          name: inviteName || undefined,
          role: inviteRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to invite user");
      setInviteEmail("");
      setInviteName("");
      setInviteRole("USER");
      flashSuccess(`Invited ${data.email}`);
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite user");
    } finally {
      setInviting(false);
    }
  };

  const handleToggleActive = async (user: AllowedUserSummary) => {
    if (user.email === session?.user?.email) return;
    try {
      if (user.active) {
        const res = await fetch(`/api/admin/users?id=${user.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error);
        }
      } else {
        const res = await fetch("/api/admin/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: user.id, active: true }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error);
        }
      }
      flashSuccess(
        `${user.email} ${user.active ? "deactivated" : "reactivated"}`
      );
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user");
    }
  };

  const handleRoleChange = async (
    id: string,
    role: "ADMIN" | "USER" | "ADVISOR"
  ) => {
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, role }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      const target = users.find((u) => u.id === id);
      flashSuccess(`${target?.email ?? "User"} role changed to ${role}`);
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const handleNameChange = async (id: string, name: string | null) => {
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      flashSuccess(name ? `Name updated to ${name}` : "Name cleared");
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update name");
    }
  };

  const handleToggleMcp = async (user: AllowedUserSummary) => {
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, mcpEnabled: !user.mcpEnabled }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      flashSuccess(
        `${user.email} MCP access ${user.mcpEnabled ? "disabled" : "enabled"}`
      );
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update MCP access");
    }
  };

  const handleGlobalMcpToggle = async () => {
    if (!mcpSummary) return;
    try {
      const res = await fetch("/api/admin/mcp", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !mcpSummary.settings.enabled }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      flashSuccess(`MCP globally ${mcpSummary.settings.enabled ? "disabled" : "enabled"}`);
      fetchMcpSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update MCP settings");
    }
  };

  const handleRevokeConnection = async (connectionId: string) => {
    try {
      const res = await fetch(`/api/admin/mcp?connectionId=${connectionId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      flashSuccess("MCP connection revoked");
      fetchMcpSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke connection");
    }
  };

  const segmentCounts = useMemo(
    () => ({
      all: users.length,
      active: users.filter((u) => u.active).length,
      inactive: users.filter((u) => !u.active).length,
      admin: users.filter((u) => u.role === "ADMIN").length,
    }),
    [users]
  );

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (!matchesSegment(u, segment)) return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        (u.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [users, query, segment]);

  if (status === "loading" || loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center gap-4">
          <button
            onClick={() => router.push("/")}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--invert-bg)] text-[var(--invert-text)]">
              <Shield size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                User Management
              </h1>
              <p className="text-sm text-muted">
                Invite and manage who can access the Transfer Tracker
              </p>
            </div>
          </div>
        </div>

        {/* Status messages */}
        {error && (
          <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-3 text-sm text-[color:var(--danger)]">
            <AlertTriangle size={16} className="shrink-0" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto">
              <X size={14} />
            </button>
          </div>
        )}
        {success && (
          <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-[color:var(--success-border)] bg-[color:var(--success-bg)] px-4 py-3 text-sm text-[color:var(--success)]">
            <Check size={16} className="shrink-0" />
            {success}
          </div>
        )}

        {/* MCP access */}
        {mcpSummary && (
          <div className="mb-6 rounded-xl border border-card-border bg-[var(--bg-card)] p-6 shadow-sm">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="mb-1 text-sm font-semibold text-foreground">
                  Claude MCP Access
                </h2>
                {demoMode() ? (
                  <p className="text-xs text-muted">
                    Off in this demo. The MCP server isn&apos;t run, so connections and tokens are turned off.
                  </p>
                ) : (
                  <p className="text-xs text-muted">
                    Remote connector URL:{" "}
                    <code className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">
                      {mcpSummary.connectorUrl}
                    </code>
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => router.push("/mcp/connections")}
                  className="mt-2 text-xs text-accent hover:underline"
                >
                  Manage your personal access tokens →
                </button>
              </div>
              <button
                type="button"
                onClick={handleGlobalMcpToggle}
                disabled={demoMode()}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                  mcpSummary.settings.enabled
                    ? "bg-accent/10 text-accent"
                    : "bg-[var(--bg-hover)] text-muted"
                }`}
              >
                Global MCP {mcpSummary.settings.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                  Active Connections
                </h3>
                <div className="space-y-2">
                  {mcpSummary.connections.slice(0, 5).map((connection) => (
                    <div
                      key={connection.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-card-border px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {connection.userEmail}
                        </p>
                        <p className="text-muted">
                          {connection.revokedAt
                            ? "Revoked"
                            : `Expires ${new Date(connection.expiresAt).toLocaleDateString()}`}
                        </p>
                      </div>
                      {!connection.revokedAt && (
                        <button
                          type="button"
                          onClick={() => handleRevokeConnection(connection.id)}
                          className="rounded bg-[color:var(--danger-bg)] px-2 py-1 font-medium text-[color:var(--danger)]"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                  {mcpSummary.connections.length === 0 && (
                    <p className="rounded-lg border border-card-border px-3 py-4 text-center text-xs text-muted">
                      No Claude connections yet.
                    </p>
                  )}
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                  Recent Tool Calls
                </h3>
                <div className="space-y-2">
                  {mcpSummary.auditLogs.slice(0, 5).map((log) => (
                    <div
                      key={log.id}
                      className="rounded-lg border border-card-border px-3 py-2 text-xs"
                    >
                      <p className="font-medium text-foreground">{log.toolName}</p>
                      <p className="text-muted">
                        {log.userEmail ?? "Unknown user"} · {log.status} ·{" "}
                        {new Date(log.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))}
                  {mcpSummary.auditLogs.length === 0 && (
                    <p className="rounded-lg border border-card-border px-3 py-4 text-center text-xs text-muted">
                      No MCP tool calls logged yet.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Invite form */}
        <div className="mb-6 rounded-xl border border-card-border bg-[var(--bg-card)] p-6 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
            <UserPlus size={16} className="text-accent" />
            Invite New User
          </h2>
          <form
            onSubmit={handleInvite}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="flex-1 min-w-[220px]">
              <label className="mb-1 block text-xs font-medium text-muted">
                Email
              </label>
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
            <div className="min-w-[180px]">
              <label className="mb-1 block text-xs font-medium text-muted">
                Name (optional)
              </label>
              <input
                type="text"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Full name"
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
            <div className="min-w-[140px]">
              <label className="mb-1 block text-xs font-medium text-muted">
                Role
              </label>
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(
                    e.target.value as "ADMIN" | "USER" | "ADVISOR"
                  )
                }
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              >
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
                <option value="ADVISOR">Advisor</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-5 py-2 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 disabled:opacity-50"
            >
              {inviting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <UserPlus size={14} />
              )}
              Invite
            </button>
          </form>
        </div>

        {/* Toolbar: search + segmented filter */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-accent" />
            <h2 className="text-sm font-semibold text-foreground">
              Allowed Users
            </h2>
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-bold text-muted">
              {visibleUsers.length}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-faint"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or email"
                className="w-60 rounded-lg border border-card-border bg-[var(--bg-card)] py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
            <div
              role="tablist"
              aria-label="Filter users"
              className="flex items-center gap-1 rounded-lg border border-card-border bg-[var(--bg-card)] p-1"
            >
              {SEGMENTS.map((seg) => {
                const isActive = seg.key === segment;
                return (
                  <button
                    key={seg.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setSegment(seg.key)}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      isActive
                        ? "bg-[var(--invert-bg)] text-[var(--invert-text)]"
                        : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
                    }`}
                  >
                    {seg.label}
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                        isActive
                          ? "bg-[var(--invert-text)]/10 text-[var(--invert-text)]"
                          : "bg-[var(--bg-hover)] text-muted"
                      }`}
                    >
                      {segmentCounts[seg.key]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Card grid */}
        {visibleUsers.length === 0 ? (
          <div className="rounded-xl border border-card-border bg-[var(--bg-card)] px-6 py-12 text-center text-sm text-muted">
            {query || segment !== "all"
              ? "No users match that filter."
              : "No users found. Invite someone to get started."}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleUsers.map((user) => (
              <UserCard
                key={user.id}
                user={user}
                isSelf={user.email === session?.user?.email}
                locked={demoMode() && isPersonaEmail(user.email)}
                mcpLocked={demoMode()}
                onRoleChange={handleRoleChange}
                onToggleActive={handleToggleActive}
                onToggleMcp={handleToggleMcp}
                onNameChange={handleNameChange}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
