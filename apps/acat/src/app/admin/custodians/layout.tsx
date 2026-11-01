import { trackerCustodianEditsRetired } from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";

export default function CustodiansAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (trackerCustodianEditsRetired()) {
    return <p>Custodian editing has been retired.</p>;
  }
  return children;
}
