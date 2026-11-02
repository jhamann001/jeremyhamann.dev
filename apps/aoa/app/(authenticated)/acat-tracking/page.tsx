import { Suspense } from "react";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { acatWorkspaceView } from "@/lib/data/acat-workspace-contract";
import { acatTrackingSurface } from "@/lib/data/acat-book";
import { acatAutoLinkReviewEnabled, acatBookColumnsEnabled, acatFeeReimbursementEnabled, acatOpsBookEnabled, acatOpsEditsEnabled, custodianAdminAllowed, epicAcatBookDayToDayActionsEnabled, showCustodianAuthorityLibraryEnabled } from "@/lib/flags";
import { SectionLabel } from "@/components/ui";
import { AcatSectionNav } from "@/components/custodians/AcatSectionNav";
import { AcatWorkspaceData } from "@/components/custodians/AcatWorkspaceData";
import { AcatTrackingSkeleton } from "@/components/transfers/AcatTrackingSkeleton";
import { AcatBookData } from "@/components/transfers/AcatBookData";
import styles from "@/components/custodians/AcatWorkspace.module.css";

export const dynamic = "force-dynamic";
const ACAT_RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

function initialRecordId(value: unknown): string | null {
  return typeof value === "string" && ACAT_RECORD_ID.test(value) ? value : null;
}

// Firm-wide source rows remain ADMIN/OPERATIONS-only. Stream the selected read
// behind the shell; source caching never replaces this session/role gate.
export default async function AcatTrackingPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) notFound();
  const scope = session.navigationScope;
  const sessionExpiresAt = Date.parse(session.expires);
  if (!scope || !Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) redirect("/");
  const params = await searchParams;
  const view = acatWorkspaceView(params.view);
  const surface = acatTrackingSurface(acatOpsBookEnabled(), view);
  const editsEnabled = surface === "book" && acatOpsEditsEnabled();
  const dayToDayEnabled = surface === "book" && epicAcatBookDayToDayActionsEnabled();
  const columnsEnabled = surface === "book" && acatBookColumnsEnabled();
  const feeEnabled = editsEnabled && acatFeeReimbursementEnabled();
  const showRemoved = surface === "book" && params.removed === "1";
  const custodianAdmin = surface !== "book" && custodianAdminAllowed(role);
  const authorityLibrary = showCustodianAuthorityLibraryEnabled() && surface !== "book";
  const requestedRecordId = surface === "book" ? initialRecordId(params.record) : null;
  const identity = { role, email: session.user.email ?? null };
  return <div className={styles.page}>
    <SectionLabel>Operations · Transfers &amp; custodians</SectionLabel>
    <h1 style={{ marginTop: 4 }}>ACAT Tracking</h1>
    <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
      Track transfers and look up custodian playbooks and fees in one place.
    </p>
    {acatAutoLinkReviewEnabled() && <p><Link href="/acat-link-review">Review links to asset transfers</Link></p>}
    <Suspense key={scope} fallback={<><AcatSectionNav current={view} /><AcatTrackingSkeleton /></>}>
      {surface !== "book" && <AcatWorkspaceData identity={identity} view={view} scope={scope} sessionExpiresAt={sessionExpiresAt} custodianAdmin={custodianAdmin} authorityLibrary={authorityLibrary} />}
      {surface === "book" && <AcatBookData identity={identity} userName={session.user.name ?? null} prefsScope={session.user.email ?? session.user.id ?? scope} editsEnabled={editsEnabled} dayToDayEnabled={dayToDayEnabled} columnsEnabled={columnsEnabled} showRemoved={showRemoved} initialRecordId={requestedRecordId} feeEnabled={feeEnabled} />}
    </Suspense>
  </div>;
}
