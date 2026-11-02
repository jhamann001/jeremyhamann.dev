import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardBody, SectionLabel } from "@/components/ui";
import { TransferForm } from "@/components/transfers/TransferForm";
import { EMPTY_TRANSFER_FORM } from "@/components/transfers/transfer-form";

// /asset-transfer/new — create a transfer record (WO ticket). A dedicated
// page (the deals /deals/new posture, verbatim): the VIEWER role has no
// affordance pointing here, but the page stays reachable — the DB write
// policies are the enforcement (ADR-4); a viewer submit surfaces the clean
// RLS rejection banner, proving the posture. Create seeds the chosen stage's
// DEFAULT_TASKS and lands transfer.create on the audit record (same tx).

export default async function NewTransferPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <>
      <SectionLabel>Operations · The ownership gap</SectionLabel>
      <h1 style={{ marginTop: 4 }}>New transfer</h1>
      <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
        One stateful record per in-flight transfer — the lifecycle, checklist
        and decisions live here, and every change lands on the audit record.
      </p>

      <div style={{ maxWidth: 760, marginTop: 18 }}>
        <Card>
          <CardBody>
            <TransferForm mode="create" initialValues={EMPTY_TRANSFER_FORM} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
