import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { AcatForm } from "@/components/forms/AcatForm";
import { SectionLabel } from "@/components/ui";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import { getClientWithHousehold } from "@/lib/data/clients";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  const client = await getClientWithHousehold(identity, id);
  if (!client) notFound();
  const rows = await apexAccountsForClient(identity, client.sf_id);
  const accounts = rows.filter(account => account.custodianAccountId?.trim() && account.apexAccountNumber?.trim()).map(account => ({
    accountId: account.custodianAccountId,
    maskedAccountNumber: `••••${(account.apexAccountNumber as string).replace(/\W/g, "").slice(-4)}`,
    accountType: account.accountType || "Account type unavailable",
    status: account.accountStatus || "",
  }));
  if (accounts.length === 0) notFound();
  return <>
    <div style={{ marginBottom: 10 }}>
      <Link href={`/client-portrait/${encodeURIComponent(id)}?portraitTab=financial`} style={{ color: "var(--muted)", fontSize: 13 }}>← {client.name}</Link>
    </div>
    <SectionLabel>Form Library · Internal Pilot</SectionLabel>
    <h1>ACAT Transfer</h1>
    <p style={{ color: "var(--muted)", marginTop: 7, maxWidth: 720, fontSize: 13 }}>
      Add receiving-account details, then complete and review the remaining transfer instructions using your existing process.
    </p>
    <AcatForm clientId={client.sf_id} clientName={client.name} accounts={accounts} />
  </>;
}
