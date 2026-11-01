"use client";

import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";

// ticket: ADVISOR is a third role with read-only access to the new
// /advisor view; the dropdown below offers it as a choice.
export type AllowedUserRole = "ADMIN" | "USER" | "ADVISOR";

export interface AllowedUserSummary {
  id: string;
  email: string;
  name: string | null;
  role: AllowedUserRole;
  active: boolean;
  mcpEnabled: boolean;
  invitedBy: string | null;
  createdAt: string;
}

interface UserCardProps {
  user: AllowedUserSummary;
  isSelf: boolean;
  // Demo: a sign-in persona, which nobody can change.
  locked?: boolean;
  // Demo: MCP is off, so its access toggle is too.
  mcpLocked?: boolean;
  onRoleChange: (id: string, role: AllowedUserRole) => void | Promise<void>;
  onToggleActive: (user: AllowedUserSummary) => void | Promise<void>;
  onToggleMcp: (user: AllowedUserSummary) => void | Promise<void>;
  onNameChange: (id: string, name: string | null) => void | Promise<void>;
}

function getInitials(user: AllowedUserSummary): string {
  if (user.name) {
    const parts = user.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}

export default function UserCard({
  user,
  isSelf,
  locked = false,
  mcpLocked = false,
  onRoleChange,
  onToggleActive,
  onToggleMcp,
  onNameChange,
}: UserCardProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(user.name ?? "");
  const [savingName, setSavingName] = useState(false);

  const displayName = user.name || user.email.split("@")[0];

  const startEditName = () => {
    setNameDraft(user.name ?? "");
    setEditingName(true);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setNameDraft(user.name ?? "");
  };

  const commitName = async () => {
    if (savingName) return;
    const next = nameDraft.trim();
    const normalized = next.length === 0 ? null : next;
    if (normalized === (user.name ?? null)) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await onNameChange(user.id, normalized);
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div
      className={`rounded-xl border border-card-border bg-[var(--bg-card)] p-5 shadow-sm transition ${
        user.active ? "" : "opacity-70"
      }`}
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--bg-hover)] text-xs font-bold text-foreground">
          {getInitials(user)}
        </span>

        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") cancelEditName();
                }}
                placeholder={user.email.split("@")[0]}
                className="w-full rounded-md border border-accent bg-[var(--bg-card)] px-2 py-1 text-sm font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
              <button
                type="button"
                onClick={commitName}
                disabled={savingName}
                aria-label="Save name"
                className="rounded p-1 text-[color:var(--success)] hover:opacity-80 disabled:opacity-50"
              >
                {savingName ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
              </button>
              <button
                type="button"
                onClick={cancelEditName}
                aria-label="Cancel name edit"
                className="rounded p-1 text-muted hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startEditName}
              disabled={locked}
              className="group flex w-full items-center gap-1.5 text-left disabled:cursor-default"
              aria-label={`Edit name for ${displayName}`}
            >
              <span className="truncate text-sm font-semibold text-foreground">
                {displayName}
              </span>
              {isSelf && (
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
                  You
                </span>
              )}
              {!locked && (
                <Pencil
                  size={11}
                  className="shrink-0 text-muted opacity-0 transition group-hover:opacity-100"
                />
              )}
            </button>
          )}
          <p className="mt-0.5 truncate text-xs text-muted">{user.email}</p>
        </div>

        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            user.active
              ? "bg-[color:var(--success-bg)] text-[color:var(--success)]"
              : "bg-[color:var(--danger-bg)] text-[color:var(--danger)]"
          }`}
        >
          {user.active ? "Active" : "Inactive"}
        </span>
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="mb-1 font-semibold uppercase tracking-wider text-muted">
            Role
          </dt>
          <dd>
            <select
              value={user.role}
              onChange={(e) =>
                onRoleChange(user.id, e.target.value as AllowedUserRole)
              }
              disabled={isSelf || locked}
              className="w-full rounded-md border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="USER">User</option>
              <option value="ADMIN">Admin</option>
              <option value="ADVISOR">Advisor</option>
            </select>
          </dd>
        </div>
        <div>
          <dt className="mb-1 font-semibold uppercase tracking-wider text-muted">
            Added
          </dt>
          <dd className="pt-1.5 text-[11px] text-foreground">
            {new Date(user.createdAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="mb-1 font-semibold uppercase tracking-wider text-muted">
            Invited By
          </dt>
          <dd className="truncate text-[11px] text-foreground">
            {user.invitedBy || "—"}
          </dd>
        </div>
      </dl>

      <div className="flex items-center justify-between border-t border-card-border pt-3">
        <button
          type="button"
          onClick={() => onToggleMcp(user)}
          disabled={!user.active || locked || mcpLocked}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
            user.mcpEnabled
              ? "bg-accent/10 text-accent hover:opacity-90"
              : "bg-[var(--bg-hover)] text-muted hover:text-foreground"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          MCP {user.mcpEnabled ? "Enabled" : "Disabled"}
        </button>
        {locked ? (
          <span className="text-[11px] italic text-muted-faint">
            Demo sign-in · locked
          </span>
        ) : isSelf ? (
          <span className="text-[11px] italic text-muted-faint">
            Cannot deactivate your own account
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onToggleActive(user)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition ${
              user.active
                ? "bg-[color:var(--danger-bg)] text-[color:var(--danger)] hover:opacity-90"
                : "bg-[color:var(--success-bg)] text-[color:var(--success)] hover:opacity-90"
            }`}
          >
            {user.active ? "Deactivate" : "Reactivate"}
          </button>
        )}
      </div>
    </div>
  );
}
