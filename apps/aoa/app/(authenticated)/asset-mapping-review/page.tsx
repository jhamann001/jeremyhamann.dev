import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { canReviewAssetMapLinks } from "@/lib/data/asset-map-review-authz";
import { SectionLabel } from "@/components/ui";
import { AssetMappingReviewData } from "@/components/asset-mapping/AssetMappingReviewData";
import { AssetMappingReviewSkeleton } from "@/components/asset-mapping/AssetMappingReviewSkeleton";

// /asset-mapping-review — the ops person-link review queue (Phase 2 slice P2.3,
// design §5). The primary human surface of the asset-mapping person link: for
// each mapping household the matcher couldn't auto-decide (NEEDS_REVIEW) OR
// auto-linked but that a human should spot-check (AUTO_LINKED), ops sees the
// household name + accounts and the ranked candidate clients (recomputed live),
// and CONFIRMS a client or REJECTS the link.
//
// ROLE GATE (design §6): the queue exposes free-text client names firm-wide
// before any book attribution exists, so it is ADMIN/OPERATIONS/HoA-only — the
// SAME predicate as the link table's ops RLS policies. A non-permitted role that
// guesses the URL gets a 404 (notFound), and the nav item is hidden for them.
// canReviewAssetMapLinks is the app-layer gate; the DB RLS policy is the real
// enforcement (a non-ops session reads zero links → an empty queue anyway).
//
// NON-BLOCKING (the acat-tracking idiom): the DB reads live inside
// <AssetMappingReviewData>, behind <Suspense> with a skeleton — the page head +
// shell paint instantly and the queue streams in when the reads resolve.

export default async function AssetMappingReviewPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canReviewAssetMapLinks(role)) notFound();

  const email = session.user.email ?? null;
  const identity = { role, email };

  return (
    <>
      <SectionLabel>Operations</SectionLabel>
      <h1 style={{ marginTop: 4 }}>Asset Mapping Review</h1>
      <p
        style={{
          color: "var(--muted)",
          marginTop: 6,
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        Attribute each account to its owner(s) — the person(s), an entity, or reject
        it. For an account whose household we haven&apos;t matched yet, pick the client
        right on the account: confirming binds the household and attributes the
        account in one step.
      </p>

      <Suspense fallback={<AssetMappingReviewSkeleton />}>
        <AssetMappingReviewData identity={identity} />
      </Suspense>
    </>
  );
}
