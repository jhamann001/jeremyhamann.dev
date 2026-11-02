import type { ReactNode } from "react";
import { employeeRosterReminder } from "@/lib/data/employee-roster";
import type { Identity } from "@/lib/rls";
import { NotificationsMenu } from "./Topbar";

/** Render under Suspense: optional shell metadata never gates page content. */
export async function RosterNotifications({ identity, tradeRequestGroup }: { identity: Identity; tradeRequestGroup?: ReactNode }) {
  try {
    const reminder = await employeeRosterReminder(identity);
    return <NotificationsMenu notifications={reminder?.notification ? [reminder.notification] : []} tradeRequestGroup={tradeRequestGroup} />;
  } catch {
    // Fixed marker only: database details, identities and credentials stay out
    // of both this log and the rendered fallback. Authentication is not caught.
    console.error("[roster-notifications] unavailable");
    return <NotificationsMenu state="unavailable" tradeRequestGroup={tradeRequestGroup} />;
  }
}
