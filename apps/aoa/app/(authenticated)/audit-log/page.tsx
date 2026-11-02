import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listAuditLog } from "@/lib/data/audit-log";
import { listRowChangeWindow } from "@/lib/data/row-changes";
import { SectionLabel } from "@/components/ui";
import { TableEmptyState } from "@/components/tasks/TableEmptyState";
import { AuditDirectory } from "@/components/audit/AuditDirectory";
import { AuditEventsUnavailable } from "@/components/audit/AuditEventsUnavailable";
import { AuditFieldChangesDirectory, AuditFieldChangesUnavailable } from "@/components/audit/AuditFieldChangesDirectory";
import { parseAuditNavigationQuery } from "@/lib/navigation/audit-query";
import { listPageHref } from "@/lib/navigation/list-routes";

export default async function AuditLogPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value !== undefined) params.set(key, value);
  }
  let query;
  try { query = parseAuditNavigationQuery(params); } catch { redirect("/audit-log"); }
  const head = <>
    <SectionLabel>Admin · Oversight</SectionLabel>
    <h1 style={{ marginTop: 4 }}>Audit Log</h1>
    <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
      System events and field-level record changes. Visible to Operations and Admins only.
    </p>
  </>;
  if (query.view === "changes") {
    let window;
    try { window = await listRowChangeWindow(identity, { ...query, snapshot: null, loaded: 0 }); }
    catch { return <>{head}<AuditFieldChangesUnavailable scope={session.navigationScope ?? ""} /></>; }
    if (!window.ok) return <>{head}<TableEmptyState title="Access denied"
      hint="The audit log is visible to Operations and Admins only. Ask an admin if you believe you need access." /></>;
    const href = listPageHref(query.href, window.firstPage);
    return <>{head}<AuditFieldChangesDirectory key={`${session.navigationScope}:${href}:${window.snapshot}`}
      initialPage={window} initialFilters={query} href={href} scope={session.navigationScope ?? ""} /></>;
  }
  let result;
  try { result = await listAuditLog(identity, query); }
  catch { return <>{head}<AuditEventsUnavailable scope={session.navigationScope ?? ""} /></>; }
  if (!result.ok) return <>{head}<TableEmptyState title="Access denied"
    hint="The audit log is visible to Operations and Admins only. Ask an admin if you believe you need access." /></>;
  if (result.page > result.pageCount) redirect(listPageHref(query.href, result.pageCount));
  const href = listPageHref(query.href, result.page);
  const meta = { actions: result.actions, actors: result.actors, tables: [], ops: [] };
  return <>{head}<AuditDirectory key={`${session.navigationScope}:${href}:${result.snapshot}`}
    initialPage={{ ...result, meta }} initialFilters={query} view={query.view} href={href}
    scope={session.navigationScope ?? ""} /></>;
}
