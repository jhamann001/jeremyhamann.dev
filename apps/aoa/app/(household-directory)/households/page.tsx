import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getRequestSession } from "@/lib/auth/request-session";
import { getHouseholdDirectory, getHouseholdDirectoryPreview } from "@/lib/data/households";
import { canSeeFirmHousehold } from "@/lib/data/firm-household";
import { householdDirectoryFastPathEnabled } from "@/lib/household-directory-fast-path";
import type { Identity } from "@/lib/rls";
import LoadingHouseholds from "@/app/(authenticated)/households/loading";
import { PageHeader } from "@/components/ui";
import { HouseholdsTable } from "@/components/households/HouseholdsTable";
import { DeferredHouseholdsDirectory } from "@/components/households/DeferredHouseholdsDirectory";
import {
  type HouseholdDirectoryFilters,
} from "@/components/households/directory-results";
import {
  householdDirectoryQueryKey,
  householdDirectorySearchParams,
  DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS,
  parseHouseholdDirectoryPageNumber,
  parseHouseholdDirectoryQuery,
} from "@/lib/navigation/household-query";

const DIRECTORY_PAGE_SIZE = 100;

// REAL, bounded, RLS-scoped screen. `getHouseholdDirectory` applies filters and
// pagination in PostgreSQL; row-level security still decides the visible book.

const firstParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

function HouseholdsHeader() {
  return <PageHeader
    eyebrow="Firm · Directory"
    title="Households"
    description="What you can see here is enforced by Postgres row-level security from your role — not filtered in app code."
  />;
}

/** Slow and fallback reads retain the existing loading and error boundaries. */
async function ExactHouseholdsDirectory({ identity, filters, page, scope, showFirm }: {
  identity: Identity;
  filters: HouseholdDirectoryFilters;
  page: number;
  scope: string;
  showFirm: boolean;
}) {
  const directory = await getHouseholdDirectory(identity, filters, page, DIRECTORY_PAGE_SIZE);
  return <>
    <HouseholdsHeader />
    <HouseholdsTable
      key={`${scope}:${householdDirectoryQueryKey(filters)}:${directory.page}:${directory.snapshot}`}
      initialDirectory={directory}
      initialFilters={filters}
      scope={scope}
      showFirm={showFirm}
    />
  </>;
}

export default async function HouseholdsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getRequestSession();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;

  // The summary uses the complete RLS-visible Apex account snapshot. Corporate
  // funds are always excluded from the displayed total; the employee switch
  // optionally excludes confirmed active employees' accounts. Household rows
  // and the firm's own detail remain available for operational inspection.
  const showFirm = canSeeFirmHousehold(role);
  const params = await searchParams;
  const filterParams = new URLSearchParams();
  for (const key of ["q", "stage", "advisor", "status", "sort", "dir"]) {
    const value = firstParam(params[key]);
    if (value !== undefined) filterParams.set(key, value);
  }
  let initialFilters: HouseholdDirectoryFilters;
  try { initialFilters = parseHouseholdDirectoryQuery(filterParams).filters; }
  catch { redirect("/households"); }
  let requestedPage: number;
  try { requestedPage = parseHouseholdDirectoryPageNumber(params.page); }
  catch {
    const canonicalQuery = householdDirectorySearchParams(initialFilters).toString();
    redirect(canonicalQuery ? `/households?${canonicalQuery}` : "/households");
  }
  const scope = session.navigationScope ?? "";
  const fastDefault = householdDirectoryFastPathEnabled() && requestedPage === 1 &&
    householdDirectoryQueryKey(initialFilters) === householdDirectoryQueryKey(DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS);
  // This route has no inherited loading boundary: successful bounded rows join
  // the initial shell instead of waiting for a streamed Suspense reveal.
  const preview = fastDefault ? await getHouseholdDirectoryPreview({ role, email }).catch(() => null) : null;
  if (preview === null) {
    return <Suspense fallback={<LoadingHouseholds />}>
      <ExactHouseholdsDirectory identity={{ role, email }} filters={initialFilters}
        page={requestedPage} scope={scope} showFirm={showFirm} />
    </Suspense>;
  }

  return (
    <>
      <HouseholdsHeader />
      <DeferredHouseholdsDirectory key={randomUUID()} preview={preview} filters={initialFilters} scope={scope} showFirm={showFirm} />
    </>
  );
}
