import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getTransfer } from "@/lib/data/transfer-detail";
import { Card, CardBody, SectionLabel } from "@/components/ui";
import { TransferForm } from "@/components/transfers/TransferForm";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import { assetTransferWorkspaceEnabled } from "@/lib/flags";

// /asset-transfer/[id]/edit — the shared form in edit mode (WO ticket).
// Same RLS-scoped read as the detail; unknown id → notFound. Everything is
// editable, FUNDED records included (no terminal lock — soft-gate posture);
// a stage change through this form resets stage_entered_at and lands
// transfer.stage_change alongside transfer.update (same tx).

export default async function EditTransferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const identity = { role, email: session.user.email ?? null };

  const { id } = await params;
  const detail = await getTransfer(identity, id);
  if (!detail) notFound();
  const { transfer } = detail;
  if (assetTransferWorkspaceEnabled()) redirect(`/asset-transfer/${encodeURIComponent(transfer.id)}`);

  // Deep-link from the detail page's "Link live ACAT status" CTA
  // (?focus=acat): the form focuses + highlights the ACAT field on mount.
  const { focus } = await searchParams;
  const focusAcat = focus === "acat";

  return (
    <>
      <Link
        href={`/asset-transfer/${transfer.id}`}
        style={{
          fontSize: 13,
          color: "var(--muted)",
          display: "inline-block",
          marginBottom: 12,
        }}
      >
        ‹ Back to record
      </Link>
      <SectionLabel>Operations · The ownership gap</SectionLabel>
      <h1 style={{ marginTop: 4 }}>
        Edit transfer — {transfer.client_first_name} {transfer.client_last_name}
      </h1>

      <div style={{ maxWidth: 760, marginTop: 18 }}>
        <Card>
          <CardBody>
            <TransferForm
              mode="edit"
              transferId={transfer.id}
              initialValues={transferToFormValues(transfer)}
              focusAcat={focusAcat}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
