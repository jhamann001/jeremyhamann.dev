import { redirect } from "next/navigation";
import { getRequestSession } from "@/lib/auth/request-session";
import { getClientDirectory } from "@/lib/data/clients";
import { PageHeader } from "@/components/ui";
import { ClientsTable } from "@/components/client-portrait";
import { parseClientDirectoryQuery, clientDirectorySearchParams } from "@/lib/navigation/client-query";

const DIRECTORY_PAGE_SIZE = 100;

const firstParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

// Client Portrait entry: a REAL, RLS-scoped list of every client the caller can
// see. Pick any client directly (no household hop first); each Household cell
// links back out to the household detail. `getClientDirectory` filters and
// paginates inside the same RLS-scoped transaction — Ops/Admin see the firm, an
// advisor sees only their own book.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getRequestSession();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;

  const params = await searchParams;
  const queryParams = new URLSearchParams();
  for (const key of ["q", "stage", "sort", "dir", "page"]) {
    const value = firstParam(params[key]); if (value !== undefined) queryParams.set(key, value);
  }
  let query;
  try { query = parseClientDirectoryQuery(queryParams); } catch { redirect("/client-portrait"); }
  const initialFilters = query.filters;
  const directory = await getClientDirectory(
    { role, email },
    initialFilters,
    query.page,
    DIRECTORY_PAGE_SIZE,
  );

  return (
    <>
      <PageHeader
        eyebrow="Client · Portrait"
        title="Clients"
        description="Pick any client to open their portrait. What you can see is enforced by Postgres row-level security from your role."
      />

      <div style={{ marginTop: 18 }}>
        <ClientsTable
          key={`${session.navigationScope ?? ""}:${clientDirectorySearchParams(initialFilters)}:${directory.page}:${directory.snapshot}`}
          initialDirectory={directory}
          scope={session.navigationScope ?? ""}
          initialFilters={initialFilters}
        />
      </div>
    </>
  );
}
