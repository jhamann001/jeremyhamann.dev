import type { ReactNode } from "react";
import Link from "next/link";
import type { WorkspaceView } from "@/lib/navigation/transfer-query";
import "./workspace.css";
import "./workspace-dark.css";

/** Names for the back link and tabs; each view's home is `viewPath` in view-helpers. */
export const WORKSPACE_PAGES: Record<WorkspaceView, string> = {
  household: "Households",
  transfers: "Asset Transfer",
  queue: "Tasks",
  activity: "Transfer activity",
  mailing: "Mailing report",
};

export type WorkspaceUser = { name: string; role: string };

export type WorkspaceTab = { key: string; label: string; href: string; current: boolean };

export function workspaceRoleLabel(role: string): string {
  switch (role) {
    case "OPERATIONS":
    case "ADMIN":
      return "Operations";
    case "CLIENT_SERVICE":
      return "Client Service";
    case "ADVISOR":
      return "Advisor";
    default:
      return "Viewer";
  }
}

/** The workspace's styled content area inside the AOA sidebar and topbar. */
export function WorkspaceShell({ label, tabs, children }: { label: string; tabs?: WorkspaceTab[]; children: ReactNode }) {
  return (
    <div className="atw atw-page" data-atw-workspace>
      <div className="shell embedded-shell">
        {tabs?.length ? (
          <nav className="workspace-tabs" aria-label={label}>
            {tabs.map(tab => (
              <Link key={tab.key} href={tab.href} prefetch={false} data-page={tab.key} aria-current={tab.current ? "page" : undefined}>{tab.label}</Link>
            ))}
          </nav>
        ) : null}
        <div id="main">{children}</div>
      </div>
    </div>
  );
}
