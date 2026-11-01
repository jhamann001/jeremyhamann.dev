"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NavRail from "@/components/NavRail";
import RecordsView from "@/components/RecordsView";
import AcatDetailDrawer from "@/components/AcatDetailDrawer";
import NewAcatModal from "@/components/NewAcatModal";
import { useAcats } from "@/hooks/use-acats";
import { useEffectiveRole } from "@/lib/use-effective-role";
import { ACAT_STATUSES, TERMINAL_STATUSES } from "@/lib/types";
import { FileStack, Loader2 } from "lucide-react";

function RecordsPageInner() {
  const { role } = useEffectiveRole();
  const isAdmin = role === "ADMIN";
  const [showDeleted, setShowDeleted] = useState(false);
  const { acats, loading, error, refresh } = useAcats({
    includeDeleted: isAdmin && showDeleted,
  });
  const router = useRouter();
  const searchParams = useSearchParams();
  const openId = searchParams.get("open");
  const [showNewAcatModal, setShowNewAcatModal] = useState(false);

  const setOpenId = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("open", id);
      else params.delete("open");
      const qs = params.toString();
      router.replace(qs ? `/records?${qs}` : "/records", { scroll: false });
    },
    [router, searchParams]
  );

  // Ordered list of ids matching the records view order (by status group, newest first),
  // so the drawer can cycle through records with ←/→.
  const orderedIds = useMemo(() => {
    const byStatus = new Map<string, typeof acats>();
    for (const r of acats) {
      const list = byStatus.get(r.status) ?? [];
      list.push(r);
      byStatus.set(r.status, list);
    }
    for (const list of byStatus.values()) {
      list.sort(
        (a, b) =>
          new Date(b.acatDate).getTime() - new Date(a.acatDate).getTime()
      );
    }
    const ids: string[] = [];
    // Non-terminal statuses first, then terminal, matching the header ordering
    const nonTerminal = ACAT_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s));
    const terminal = ACAT_STATUSES.filter((s) => TERMINAL_STATUSES.has(s));
    for (const s of [...nonTerminal, ...terminal]) {
      for (const r of byStatus.get(s) ?? []) ids.push(r.id);
    }
    return ids;
  }, [acats]);

  const openRecord = openId ? acats.find((a) => a.id === openId) ?? null : null;

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <NavRail
        onNewAcat={() => setShowNewAcatModal(true)}
        onRefresh={refresh}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <RecordsView
          acats={acats}
          loading={loading}
          error={error}
          selectedId={openId}
          onOpenRecord={(id) => setOpenId(id)}
          onRefresh={refresh}
          showDeleted={showDeleted}
          onToggleShowDeleted={
            isAdmin ? () => setShowDeleted((v) => !v) : undefined
          }
        />
      </main>

      <AcatDetailDrawer
        record={openRecord}
        orderedIds={orderedIds}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        onNavigate={(id) => setOpenId(id)}
        onMutate={refresh}
      />

      {showNewAcatModal && (
        <NewAcatModal
          onClose={() => setShowNewAcatModal(false)}
          onCreated={refresh}
          existingRecords={acats}
        />
      )}
    </div>
  );
}

function RecordsFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-lg animate-pulse-glow">
          <FileStack size={22} />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin text-accent" />
          Loading records…
        </div>
      </div>
    </div>
  );
}

export default function RecordsPage() {
  return (
    <Suspense fallback={<RecordsFallback />}>
      <RecordsPageInner />
    </Suspense>
  );
}
