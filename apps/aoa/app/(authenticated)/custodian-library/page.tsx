import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";

export const dynamic = "force-dynamic";

export default async function CustodianLibraryPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canReadCustodianLibrary(role)) notFound();

  // Keep saved bookmarks working without a second sidebar destination or read.
  redirect("/acat-tracking?view=library");
}
