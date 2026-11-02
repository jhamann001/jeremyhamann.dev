import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardBody, SectionLabel } from "@/components/ui";
import { DealForm } from "@/components/deals/DealForm";
import type { DealFormValues } from "@/components/deals/deal-form";
import { canViewCedarRidgeUserId } from "@/lib/data/client-field-authz";

// /deals/new — AOA's first real write surface (WO ticket). A dedicated page
// (not the detail modal — there is no detail to show yet; noted scope-change
// pick). No owner inputs since D6 (WO ticket): the create action silently
// records owner_name = the signed-in user server-side. The VIEWER role has no
// affordance pointing here, but the page itself stays reachable: the DB write
// policies are the enforcement (ADR-4) — a viewer submit surfaces the clean
// RLS rejection, proving the posture.

export default async function NewDealPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const canViewCedarRidge = canViewCedarRidgeUserId(role);

  const initialValues: DealFormValues = {
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

  return (
    <>
      <SectionLabel>Firm · Pipeline</SectionLabel>
      <h1 style={{ marginTop: 4 }}>New deal</h1>
      <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
        Capture a deal the moment it materializes — every change lands on the
        audit record.
      </p>

      <div style={{ maxWidth: 760, marginTop: 18 }}>
        <Card>
          <CardBody>
            <DealForm
              mode="create"
              initialValues={initialValues}
              canViewCedarRidge={canViewCedarRidge}
              cedarRidgeMasked={false}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
