import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { AdvisorTransferList } from "@/components/transfers/AdvisorTransferList";
import { readAdvisorTransfers } from "@/lib/data/advisor-transfers";
import { acatAdvisorListEnabled } from "@/lib/flags";

export const dynamic = "force-dynamic";

// Client Transfers (ticket): the tracker's redacted advisor list. The tracker
// decides, by work email, whether the signed-in person is an advisor or admin;
// everyone else, and every flag-off request, gets a 404 and never a list.
export default async function ClientTransfersPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (!acatAdvisorListEnabled()) notFound();
  const email = session.user.email;
  if (!email) notFound();
  const result = await readAdvisorTransfers(email);
  if (!result.ok && result.reason !== "unavailable") notFound();
  return <AdvisorTransferList initial={result.ok ? { ok: true, rows: result.rows } : { ok: false }} />;
}
