import { ListBackLink } from "@/components/navigation/ListBackLink";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDeal } from "@/lib/data/deals";
import { canViewCedarRidgeUserId } from "@/lib/data/client-field-authz";
import { Card, CardBody } from "@/components/ui";
import { DealDetail } from "@/components/deals/DealDetail";
import { crmIdentityIdForSource, crmRouteSource } from "@/lib/crm/resolve";
import { canViewCrmId } from "@/lib/crm/visibility";

// Full-page /deals/[id] — the hard-refresh / deep-link fallback for the
// intercepted detail modal (scope change, the owner 2026-07-01). Same RLS-scoped
// `getDeal` read; unknown id → notFound (no leak, households-detail idiom).

export default async function DealDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;
  const identity = { role, email };

  const { id } = await params;
  const deal = await getDeal(identity, id);
  if (!deal) notFound();
  const crmId = canViewCrmId(role)
    ? await crmIdentityIdForSource(
        identity,
        "DEAL",
        crmRouteSource("DEAL"),
        deal.id,
      )
    : null;

  return (
    <>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>
        <ListBackLink scope={session.navigationScope ?? ""} detailHref={`/deals/${id}`}
          canonicalHref={`/deals/${deal.id}`} fallback="/deals" />
      </div>
      <div style={{ maxWidth: 760 }}>
        <Card>
          <CardBody>
            <DealDetail
              deal={deal}
              canWrite={role !== "VIEWER"}
              canViewCedarRidge={canViewCedarRidgeUserId(role)}
              crmId={crmId}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
