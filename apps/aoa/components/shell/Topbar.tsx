import { signOut } from "@/auth";
import type { ReactNode } from "react";
import Link from "next/link";
import { Avatar, SectionLabel, ThemeToggle } from "@/components/ui";
import { IconSearch, IconBell } from "@/components/icons";
import { globalSearchEnabled } from "@/lib/flags";
import { BellOpenCount, BellSummary } from "@/components/trade-requests/bell/notifications";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationPanel } from "./NotificationPanel";
import styles from "./Topbar.module.css";

export type OperationalNotification = {
  id: string;
  title: string;
  body: string;
  href: string;
  tone: "amber" | "red";
};

export function Topbar({
  name,
  role,
  notifications = [],
  notificationContent,
}: {
  name: string;
  role: string;
  notifications?: OperationalNotification[];
  notificationContent?: ReactNode;
}) {
  return (
    <header className={styles.topbar}>
      {/* Flag GLOBAL_SEARCH: ON → the live cross-entity search; OFF → the
          original inert placeholder (byte-identical, the instant rollback). */}
      {globalSearchEnabled() ? (
        <GlobalSearch />
      ) : (
        <div className={styles.search}>
          <IconSearch />
          <input placeholder="Search…" aria-label="Search" />
        </div>
      )}
      <div className={styles.spacer} />
      <div className={styles.roleChip}>
        <Avatar name={name} />
        <div className={styles.who}>
          <div className={styles.name}>{name}</div>
          <div className={styles.role}>{role}</div>
        </div>
      </div>
      <ThemeToggle />
      {notificationContent ?? <NotificationsMenu notifications={notifications} />}
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button className={styles.iconBtn} type="submit">
          Sign out
        </button>
      </form>
    </header>
  );
}

/**
 * A failed optional read is unknown, not an empty/healthy notification list.
 * Without `tradeRequestGroup` this is today's roster-only bell, unchanged; with
 * it, the roster section gets its own heading and the group follows it, and
 * the badge, label and header count the open items of both (the group must be
 * rendered inside TradeRequestNotificationsProvider).
 */
export function NotificationsMenu({
  notifications = [],
  state = "ready",
  tradeRequestGroup,
}: {
  notifications?: OperationalNotification[];
  state?: "ready" | "loading" | "unavailable";
  tradeRequestGroup?: ReactNode;
}) {
  const ready = state === "ready";
  const roster = !ready ? (
    <p className={styles.notificationEmpty} role="status">
      {state === "loading" ? "Checking operations notifications…" : "Notifications could not be checked. Refresh to try again, or open Employee roster to review its status."}
      {state === "unavailable" && <> <Link href="/crm/employees">Employee roster →</Link></>}
    </p>
  ) : notifications.length === 0 ? (
    <p className={styles.notificationEmpty}>No operational actions need attention.</p>
  ) : notifications.map((notification) => (
    <Link
      className={`${styles.notificationItem} ${styles[notification.tone]}`}
      href={notification.href}
      key={notification.id}
    >
      <strong>{notification.title}</strong>
      <span>{notification.body}</span>
      <small>Open workflow →</small>
    </Link>
  ));
  const rosterOpen = ready ? notifications.length : 0;
  const summary = tradeRequestGroup ? <BellSummary rosterOpen={rosterOpen} /> : (
    <summary
      className={styles.iconBtn}
      aria-label={`Notifications${!ready ? `, ${state}` : notifications.length ? `, ${notifications.length} action needed` : ""}`}
    >
      <IconBell />
      {ready && notifications.length > 0 && <span className={styles.notificationCount}>{notifications.length}</span>}
    </summary>
  );
  const headerCount = tradeRequestGroup ? <BellOpenCount rosterOpen={rosterOpen} /> : (
    <span>{ready ? `${notifications.length} open` : state === "loading" ? "Loading…" : "Unavailable"}</span>
  );
  return (
      <details className={styles.notifications}>
        {summary}
        <NotificationPanel className={styles.notificationPanel}>
          <div className={styles.notificationHeader}>
            <strong>Operations notifications</strong>
            {headerCount}
          </div>
          {tradeRequestGroup ? (
            <div className={styles.notificationBody}>
              <section className={styles.notificationSection} aria-label="Operations">
                <SectionLabel className={styles.notificationHeading}>Operations</SectionLabel>
                {roster}
              </section>
              {tradeRequestGroup}
            </div>
          ) : roster}
        </NotificationPanel>
      </details>
  );
}
