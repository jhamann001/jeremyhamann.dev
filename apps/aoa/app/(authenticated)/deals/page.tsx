import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  getDealDirectory,
  getDealSuggestions,
  getDeal,
} from "@/lib/data/deals";
import { canSeeArchivedDeals } from "@/lib/data/deal-archive";
import { canViewCedarRidgeUserId } from "@/lib/data/client-field-authz";
import { SectionLabel } from "@/components/ui";
import { DealsTable } from "@/components/deals/DealsTable";
import { DealModal } from "@/components/deals/DealModal";
import { DealDetail } from "@/components/deals/DealDetail";
import { DealForm } from "@/components/deals/DealForm";
import {
  type DealFormValues,
} from "@/components/deals/deal-form";
import { dealsHref, parseDealsQuery } from "@/lib/navigation/deals-query";
import { crmIdentityIdForSource, crmRouteSource } from "@/lib/crm/resolve";
import { canViewCrmId } from "@/lib/crm/visibility";

// /deals — the firm pipeline (Phase Deals D2, WO ticket). REAL, RLS-scoped
// reads: both seam calls run inside `withUserScope`, and today's locked posture
// (TDD ADR-4, all-roles-read) means EVERY app role — VIEWER included — sees the
// identical full pipeline, unassigned deals and all. No role branching here;
// when book scoping is tightened later, only the DB policies change. KPIs are
// SQL-aggregated in the same scope as the table rows, so the tiles always equal
// the table's sums by construction. ("New deal" button arrives with D3 — the
// declared one-line overlap; deliberately absent here.)

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;
  const identity = { role, email };
  const canViewCedarRidge = canViewCedarRidgeUserId(role);

  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value !== undefined) params.set(key, value);
  }
  let query;
  try { query = parseDealsQuery(params); } catch { redirect("/deals"); }
  if (query.filters.archived && !canSeeArchivedDeals(role)) redirect("/deals");
  const directory = await getDealDirectory(identity, query.filters, query.page, 100);
  if (directory.page > directory.pageCount) redirect(dealsHref(query.filters, directory.pageCount));

  // Search-param-driven modal (replaced the @modal intercepting route,
  // 2026-07-02 — its special-character chunk path was un-servable on the
  // Cloud Run front-end). ?deal=<id> → detail/edit modal; ?new=1 → create
  // modal (write roles). Unknown ids render no modal. Archived ids DO render
  // — the labeled read-only "Removed" state, for every role (D7 posture) —
  // but the removal reason is nulled at the seam for non-ADMIN/OPERATIONS
  // (getDeal, QC MEDIUM-2).
  const modalDeal = query.modalDealId ? await getDeal(identity, query.modalDealId) : null;
  const modalDealCrmId =
    modalDeal && canViewCrmId(role)
      ? await crmIdentityIdForSource(
          identity,
          "DEAL",
          crmRouteSource("DEAL"),
          modalDeal.id,
        )
      : null;
  const wantsNew = query.wantsNew && role !== "VIEWER";
  const newInitialValues: DealFormValues = {
    client_first_name: "",
    client_last_name: "",
    household_name: "",
    household_sf_id: "",
    amount: "",
    stage: "POTENTIAL",
    close_date: "",
    cedar_ridge_user_id: "",
    statements: true,
    account_type: "",
    funding_other: "",
    employer: "",
    rolling_into: "",
    account_last4: "",
    transferring_firm: "",
  };

  // Suggestions are their own full-scope projection, loaded only for an
  // explicit form request. They must never be inferred from the first page.
  const suggestions = (modalDeal && role !== "VIEWER") || wantsNew
    ? await getDealSuggestions(identity) : undefined;
  const newHref = `${query.href}${query.href.includes("?") ? "&" : "?"}new=1`;

  return (
    <>
      <SectionLabel>Firm · Pipeline</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ marginTop: 4 }}>Deals</h1>
        {/* D3's declared one-line overlap: the New-deal affordance (write
            roles only — VIEWER gets none; the DB policies enforce regardless). */}
        {role !== "VIEWER" && (
          <Link
            href={newHref}
            prefetch={false}
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              padding: "9px 15px",
              borderRadius: 9999,
              background: "var(--ink)",
              color: "var(--bg)",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            + New deal
          </Link>
        )}
      </div>
      <p
        style={{
          color: "var(--muted)",
          marginTop: 6,
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        The whole firm&apos;s pipeline — every role sees every deal (locked posture).
      </p>

      <DealsTable key={`${session.navigationScope}:${query.href}:${directory.snapshot}`}
        initialPage={directory} initialFilters={query.filters} scope={session.navigationScope ?? ""}
        canWrite={role !== "VIEWER"} />

      {modalDeal && (
        <DealModal fallbackHref={query.href}>
          <DealDetail
            deal={modalDeal}
            canWrite={role !== "VIEWER"}
            canViewCedarRidge={canViewCedarRidge}
            crmId={modalDealCrmId}
            suggestions={suggestions}
          />
        </DealModal>
      )}
      {!modalDeal && wantsNew && (
        <DealModal fallbackHref={query.href}>
          <h2 style={{ marginTop: 0 }}>New deal</h2>
          <DealForm
            mode="create"
            initialValues={newInitialValues}
            suggestions={suggestions}
            canViewCedarRidge={canViewCedarRidge}
            cedarRidgeMasked={false}
          />
        </DealModal>
      )}
    </>
  );
}
