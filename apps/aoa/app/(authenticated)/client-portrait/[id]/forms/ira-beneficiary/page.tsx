import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { IraBeneficiaryForm } from "@/components/forms/IraBeneficiaryForm";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import { getClientWithHousehold } from "@/lib/data/clients";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";
import { SectionLabel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
  const client = await getClientWithHousehold(identity, id);
  if (!client) notFound();
  // The route may use a canonical CRM key; account ownership uses the resolved
  // source contact key returned by the authorized client loader.
  const accountRows = await apexAccountsForClient(identity, client.sf_id);

  const accounts = accountRows
    .filter(
      (account) =>
        account.apexAccountNumber &&
        isDefinitionEligibleForAccountType(IRA_BENEFICIARY_DEFINITION, account.accountType),
    )
    .map((account) => ({
      accountId: account.custodianAccountId,
      maskedAccountNumber: `••••${(account.apexAccountNumber as string)
        .replace(/\W/g, "")
        .slice(-4)}`,
      accountType: account.accountType ?? "IRA",
      status: account.accountStatus ?? "",
    }));
  if (accounts.length === 0) notFound();

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <Link href={`/client-portrait/${encodeURIComponent(id)}`} style={{ color: "var(--muted)", fontSize: 13 }}>
          ← {client.name}
        </Link>
      </div>
      <SectionLabel>Form Library · Internal Pilot</SectionLabel>
      <h1>IRA Beneficiary Designation</h1>
      <p style={{ color: "var(--muted)", marginTop: 7, maxWidth: 720, fontSize: 13 }}>
        Confirm the account-holder information and add any known beneficiary details. Leave missing information blank for the client to complete.
      </p>
      <IraBeneficiaryForm clientId={client.sf_id} clientName={client.name} accounts={accounts} />
    </>
  );
}
