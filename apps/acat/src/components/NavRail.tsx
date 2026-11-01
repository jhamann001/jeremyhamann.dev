"use client";

import {
  Building2,
  Inbox,
  LayoutDashboard,
  List,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  PlugZap,
  User,
  Eye,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import ThemeToggle from "./ThemeToggle";
import { useEffectiveRole, isDevOverrideEnabled } from "@/lib/use-effective-role";
import { usePresenceList } from "@/hooks/use-presence";
import type { PresenceUser } from "@/lib/presence";
import { useCustodianEditingRetired } from "./CustodianEditingRetirement";
import { demoMode } from "@/lib/demo/mode";
import { PortfolioRailLink } from "./PortfolioLink";

interface NavRailProps {
  onNewAcat: () => void;
  onRefresh?: () => void | Promise<void>;
}

export default function NavRail({ onNewAcat, onRefresh }: NavRailProps) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { role, actualRole, isOverridden, setOverride } = useEffectiveRole();
  const isAdmin = role === "ADMIN";
  const canShowDevToggle = isDevOverrideEnabled() && actualRole === "ADMIN";
  const custodianEditingRetired = useCustodianEditingRetired();

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const isRecordsRoute = pathname?.startsWith("/records") ?? false;
  const isDashboardRoute = pathname === "/";
  const isCustodiansRoute = pathname?.startsWith("/admin/custodians") ?? false;
  const isMcpConnectionsRoute = pathname?.startsWith("/mcp/connections") ?? false;
  const isOutboxRoute = pathname?.startsWith("/outbox") ?? false;
  // User Management is /admin exactly — not /admin/custodians.
  const isAdminRoute =
    (pathname?.startsWith("/admin") ?? false) && !isCustodiansRoute;

  const initials = (session?.user?.name ?? session?.user?.email ?? "U")
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <aside
      aria-label="Primary"
      className="flex h-full w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar-bg py-3"
    >
      <PortfolioRailLink />
      <button
        type="button"
        onClick={() => router.push("/")}
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-sm transition hover:opacity-90"
        aria-label="Go to Dashboard"
        title="Transfer Tracker"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <span className="text-lg font-semibold leading-none">C</span>
      </button>

      <div className="flex flex-col items-center gap-1">
        <RailButton
          label="Dashboard"
          active={isDashboardRoute}
          onClick={() => router.push("/")}
          icon={<LayoutDashboard size={16} />}
        />
        <RailButton
          label="All Records"
          active={isRecordsRoute}
          onClick={() => router.push("/records")}
          icon={<List size={16} />}
        />
        <RailButton
          label="New Transfer"
          onClick={onNewAcat}
          icon={<Plus size={17} strokeWidth={2.4} />}
          accent
        />
        {onRefresh && (
          <RailButton
            label="Refresh"
            onClick={handleRefresh}
            icon={
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            }
            disabled={refreshing}
          />
        )}
      </div>

      <div className="mt-auto flex flex-col items-center gap-1">
        {!custodianEditingRetired && (
          <RailButton
            label="Custodians &amp; Fees"
            active={isCustodiansRoute}
            onClick={() => router.push("/admin/custodians")}
            icon={<Building2 size={15} />}
          />
        )}
        {isAdmin && (
          <RailButton
            label="User Management"
            active={isAdminRoute}
            onClick={() => router.push("/admin")}
            icon={<Shield size={15} />}
          />
        )}
        <RailButton
          label="Claude MCP"
          active={isMcpConnectionsRoute}
          onClick={() => router.push("/mcp/connections")}
          icon={<PlugZap size={15} />}
        />
        {demoMode() && (
          <RailButton
            label="Outbox (demo)"
            active={isOutboxRoute}
            onClick={() => router.push("/outbox")}
            icon={<Inbox size={15} />}
          />
        )}
        <ThemeToggle className="h-9 w-9" size={15} />
        {canShowDevToggle && (
          <RailButton
            label={isOverridden ? "Dev: viewing as User · click to restore Admin" : "Dev: view as User"}
            active={isOverridden}
            onClick={() => setOverride(isOverridden ? null : "USER")}
            icon={<Eye size={15} />}
          />
        )}
        <PresenceAvatar
          initials={initials}
          email={session?.user?.email ?? null}
          name={session?.user?.name ?? null}
        />
        <RailButton
          label="Sign out"
          onClick={() => signOut()}
          icon={<LogOut size={14} />}
        />
      </div>
    </aside>
  );
}

function PresenceAvatar({
  initials,
  email,
  name,
}: {
  initials: string;
  email: string | null;
  name: string | null;
}) {
  const { users, activeCount, totalCount } = usePresenceList();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [popRect, setPopRect] = useState<DOMRect | null>(null);

  const self = email
    ? users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null
    : null;
  const isSelfActive = self?.status === "active";

  const dotColor = isSelfActive
    ? "var(--status-green-dot)"
    : "var(--muted-faint)";

  const tooltip = isSelfActive
    ? `${name ?? email ?? "You"} — Active now`
    : (name ?? email ?? "User");

  const show = () => {
    if (wrapRef.current) setPopRect(wrapRef.current.getBoundingClientRect());
  };
  const hide = () => setPopRect(null);

  return (
    <>
      <div
        ref={wrapRef}
        title={tooltip}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
        aria-label={`Team: ${activeCount} of ${totalCount} active`}
        className="relative mt-1 flex h-8 w-8 cursor-default items-center justify-center rounded-full border border-card-border bg-[var(--bg-card)] text-[10px] font-semibold text-muted outline-none focus-visible:ring-2 focus-visible:ring-[var(--invert-bg)]"
      >
        {initials || <User size={13} />}
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 block h-[10px] w-[10px] rounded-full"
          style={{
            background: dotColor,
            boxShadow: "0 0 0 2px var(--sidebar-bg)",
          }}
        />
      </div>
      {popRect &&
        typeof document !== "undefined" &&
        createPortal(
          <PresencePopover
            anchor={popRect}
            users={users}
            activeCount={activeCount}
            totalCount={totalCount}
            currentEmail={email}
            onMouseEnter={show}
            onMouseLeave={hide}
          />,
          document.body
        )}
    </>
  );
}

function PresencePopover({
  anchor,
  users,
  activeCount,
  totalCount,
  currentEmail,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor: DOMRect;
  users: PresenceUser[];
  activeCount: number;
  totalCount: number;
  currentEmail: string | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  // Server already orders by lastSeenAt desc with nulls last. Reorder so
  // active users always sit on top regardless of how recent their last
  // heartbeat is, then preserve the server order beneath.
  const sortedUsers = [...users].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return 0;
  });

  return (
    <div
      role="dialog"
      aria-label="Team"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 w-64 rounded-lg border border-card-border bg-[var(--bg-card)] p-2 shadow-xl"
      style={{
        top: anchor.top - 8,
        left: anchor.right + 12,
        transform: "translateY(-100%)",
      }}
    >
      <div className="flex items-center justify-between border-b border-card-border px-1.5 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Team
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--status-green-dot)" }}
          />
          {activeCount} of {totalCount} active
        </span>
      </div>
      <div className="mt-1 flex max-h-72 flex-col overflow-y-auto">
        {sortedUsers.length === 0 ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-faint">
            No teammates yet.
          </div>
        ) : (
          sortedUsers.map((u) => (
            <PresenceRow
              key={u.email}
              user={u}
              isSelf={
                currentEmail != null &&
                u.email.toLowerCase() === currentEmail.toLowerCase()
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function PresenceRow({ user, isSelf }: { user: PresenceUser; isSelf: boolean }) {
  const initials = (user.name ?? user.email)
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  const isActive = user.status === "active";
  const dotColor = isActive
    ? "var(--status-green-dot)"
    : "var(--muted-faint)";

  return (
    <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-[var(--bg-hover,var(--bg-raised))]">
      <div className="relative flex h-7 w-7 items-center justify-center rounded-full border border-card-border bg-[var(--bg-raised)] text-[9px] font-semibold text-muted">
        {initials || <User size={11} />}
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 block h-[8px] w-[8px] rounded-full"
          style={{
            background: dotColor,
            boxShadow: "0 0 0 2px var(--bg-card)",
          }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-foreground">
          {user.name ?? user.email.split("@")[0]}
          {isSelf && (
            <span className="ml-1 font-normal text-muted-faint">(you)</span>
          )}
        </div>
        <div className="text-[10px] text-muted-faint">
          {isActive ? "Active now" : formatLastSeen(user.lastSeenAt)}
        </div>
      </div>
    </div>
  );
}

// Last-seen label for a non-active user. Bucketed so the popover stays
// scannable: minutes → hours → days for the recent past, an absolute
// date once we're past a week. `null` covers users who have never sent
// a heartbeat (allowlisted but never signed in, or signed in only
// before this feature shipped).
function formatLastSeen(iso: string | null): string {
  if (!iso) return "Never signed in";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "Last seen just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `Last seen ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Last seen ${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `Last seen ${day}d ago`;
  return `Last seen ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function RailButton({
  label,
  icon,
  onClick,
  active,
  accent,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Position the tooltip via a document.body portal so the page-shell
  // `overflow-hidden` stacking context can't clip it.
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);

  const baseClasses =
    "relative flex h-9 w-9 items-center justify-center rounded-lg transition disabled:opacity-50";
  const stateClasses = accent
    ? "bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-md hover:opacity-90"
    : active
      ? "bg-[var(--invert-bg)] text-[var(--invert-text)]"
      : "text-muted hover:bg-[var(--bg-card)] hover:text-foreground hover:shadow-sm";

  const showTooltip = () => {
    if (buttonRef.current) setTooltipRect(buttonRef.current.getBoundingClientRect());
  };
  const hideTooltip = () => setTooltipRect(null);

  const canRenderTooltip =
    typeof document !== "undefined" && tooltipRect !== null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        onPointerEnter={showTooltip}
        onPointerLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        aria-label={label}
        title={label}
        aria-current={active ? "page" : undefined}
        data-active={active ? "true" : undefined}
        disabled={disabled}
        className={`${baseClasses} ${stateClasses}`}
      >
        {icon}
      </button>
      {canRenderTooltip &&
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md bg-[var(--invert-bg)] px-2 py-1 text-[10px] font-medium text-[var(--invert-text)] shadow-lg"
            style={{
              top: tooltipRect.top + tooltipRect.height / 2,
              left: tooltipRect.right + 8,
              transform: "translateY(-50%)",
            }}
          >
            {label}
          </span>,
          document.body
        )}
    </>
  );
}
