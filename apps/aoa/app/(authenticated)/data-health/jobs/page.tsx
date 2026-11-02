import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui";
import { JobsMonitor } from "@/components/data-jobs/JobsMonitor";
import { dataHealthEnabled, dataJobMonitoringEnabled } from "@/lib/flags";
import { canViewSourceHealth } from "@/lib/data/source-health";

export default async function DataJobsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!dataHealthEnabled() || !dataJobMonitoringEnabled() || !canViewSourceHealth(role)) notFound();

  return <>
    <PageHeader eyebrow="Admin · operations · data health" title="Data sources & jobs" description="Where data comes from, what runs it, and what happened last. Expand a job for its schedule, execution history, and monitoring evidence." actions={<Link href="/data-health" prefetch={false}>Source freshness →</Link>} />
    <JobsMonitor />
  </>;
}
