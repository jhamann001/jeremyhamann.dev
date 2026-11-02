import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { MappedForm } from "@/components/forms/MappedForm";
import { SectionLabel } from "@/components/ui";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import { getClientWithHousehold } from "@/lib/data/clients";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { getMappedFormSpecBySlug } from "@/lib/forms/mapped-forms";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string; formSlug: string }> }) {
  const { id, formSlug } = await params;
  const session = await auth();
  if (!session?.user) redirect("/");
  const spec = getMappedFormSpecBySlug(formSlug);
  if (!spec || spec.definition.status === "retired") notFound();
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  const client = await getClientWithHousehold(identity, id);
  if (!client) notFound();
  const rows = await apexAccountsForClient(identity, client.sf_id);
  const accounts = rows.filter(account => account.custodianAccountId?.trim() && account.apexAccountNumber?.trim() && isDefinitionEligibleForAccountType(spec.definition, account.accountType)).map(account => ({
    accountId: account.custodianAccountId,
    maskedAccountNumber: `••••${(account.apexAccountNumber as string).replace(/\W/g, "").slice(-4)}`,
    accountType: account.accountType || "Account type unavailable",
    status: account.accountStatus || "",
  }));
  if (!accounts.length) notFound();
  return <>
    <div style={{ marginBottom: 10 }}><Link href={`/client-portrait/${encodeURIComponent(id)}?portraitTab=financial`} style={{ color: "var(--muted)", fontSize: 13 }}>← {client.name}</Link></div>
    <SectionLabel>Form Library · Internal Pilot</SectionLabel>
    <h1>{spec.definition.name}</h1>
    <p style={{ color: "var(--muted)", marginTop: 7, maxWidth: 800, fontSize: 13 }}>{spec.definition.summary}</p>
    <MappedForm key={`${client.sf_id}:${spec.definition.id}`} spec={spec} clientId={client.sf_id} clientName={client.name} accounts={accounts} />
  </>;
}
