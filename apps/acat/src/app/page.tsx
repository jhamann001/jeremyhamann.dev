"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import TransferDashboard from "@/components/TransferDashboard";
import TransferDetailsDrawer from "@/components/TransferDetailsDrawer";
import NavRail from "@/components/NavRail";
import NewAcatModal from "@/components/NewAcatModal";
import { useAcats } from "@/hooks/use-acats";
import { FileStack, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { DataQualityFocus } from "@/lib/data-quality-focus";

export default function Home() {
  const { acats, loading, error, refresh: refreshAcats } = useAcats();
  const router = useRouter();
  const [showNewAcatModal, setShowNewAcatModal] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [selectedFocus, setSelectedFocus] = useState<DataQualityFocus | undefined>();

  const handleSelectRecord = useCallback(
    (id: string, focus?: DataQualityFocus) => {
      setSelectedRecordId(id);
      setSelectedFocus(focus);
    },
    []
  );
  const selectedRecord = selectedRecordId
    ? acats.find((record) => record.id === selectedRecordId)
    : undefined;

  if (loading && acats.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-lg animate-pulse-glow">
            <FileStack size={24} />
          </div>
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-accent" />
            <p className="text-sm font-medium text-muted">
              Loading transfer records...
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error && acats.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--danger-bg)] text-[color:var(--danger)]">
            <WifiOff size={24} />
          </div>
          <div>
            <p className="text-lg font-semibold text-foreground">
              Failed to load records
            </p>
            <p className="mt-1 text-sm text-muted">{error}</p>
          </div>
          <button
            onClick={refreshAcats}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--invert-text)] shadow-sm transition hover:opacity-90"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      {error && (
        <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 bg-[color:var(--danger-bg)] border-b border-[color:var(--danger-border)] px-4 py-2 text-sm text-[color:var(--danger)]">
          <WifiOff size={14} />
          <span>Connection issue — showing cached data. {error}</span>
          <button
            onClick={refreshAcats}
            className="font-semibold underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      <NavRail
        onNewAcat={() => setShowNewAcatModal(true)}
        onRefresh={refreshAcats}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        <TransferDashboard acats={acats} onSelectRecord={handleSelectRecord} />
      </main>

      {showNewAcatModal && (
        <NewAcatModal
          onClose={() => setShowNewAcatModal(false)}
          onCreated={refreshAcats}
          existingRecords={acats}
        />
      )}

      {selectedRecord && (
        <TransferDetailsDrawer
          acat={selectedRecord}
          focus={selectedFocus}
          onClose={() => {
            setSelectedRecordId(null);
            setSelectedFocus(undefined);
          }}
          onMutate={refreshAcats}
          onOpenFullRecord={() => router.push(`/records?open=${encodeURIComponent(selectedRecord.id)}`)}
        />
      )}
    </div>
  );
}
