import Link from "next/link";
import styles from "./ReportingTabs.module.css";

export type ReportingTab = "crm" | "transfer-activity";

/** Reporting's report switcher; each tab is listed only when the viewer can open it. */
export function ReportingTabs({ current, crm, transferActivity }: { current: ReportingTab | null; crm: boolean; transferActivity: boolean }) {
  const tabs = [
    crm ? { key: "crm" as const, label: "CRM reports", href: "/reporting" } : null,
    transferActivity ? { key: "transfer-activity" as const, label: "Transfer activity", href: "/reporting/transfer-activity" } : null,
  ].filter((tab) => tab !== null);
  if (tabs.length < 2) return null;
  return (
    <nav className={styles.tabs} aria-label="Reports">
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} prefetch={false} aria-current={tab.key === current ? "page" : undefined}>{tab.label}</Link>
      ))}
    </nav>
  );
}
