"use client";

import { csvCell } from "@/lib/csv-cell";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { useEffectiveRole } from "@/lib/use-effective-role";
import {
  ArrowLeft,
  Building2,
  Download,
  Loader2,
  Plus,
  Search,
  AlertTriangle,
  Check,
  X,
} from "lucide-react";
import CustodianCard, {
  SEGMENTS,
  needsPlaybook,
  type CustodianSummary,
  type Segment,
} from "@/components/CustodianCard";

function matchesSegment(c: CustodianSummary, seg: Segment): boolean {
  switch (seg) {
    case "acat":
      return c.transferType === "ACAT_API";
    case "manual":
      return c.transferType === "MANUAL";
    case "mixed":
      return c.transferType === "MIXED";
    case "needsPlaybook":
      return needsPlaybook(c);
    default:
      return true;
  }
}

export default function CustodiansAdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const { data, error, isLoading, mutate } = useSWR<CustodianSummary[]>(
    "/api/custodians?includeFees=1&withInbound=1"
  );

  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("all");

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [adding, setAdding] = useState(false);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [flashSuccess, setFlashSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/");
    }
  }, [session, status, router]);

  const { role: effectiveRole } = useEffectiveRole();
  const isAdmin = effectiveRole === "ADMIN";
  const custodians = data ?? [];

  const segmentCounts = useMemo(
    () => ({
      all: custodians.length,
      acat: custodians.filter((c) => c.transferType === "ACAT_API").length,
      manual: custodians.filter((c) => c.transferType === "MANUAL").length,
      mixed: custodians.filter((c) => c.transferType === "MIXED").length,
      needsPlaybook: custodians.filter((c) => needsPlaybook(c)).length,
    }),
    [custodians]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return custodians
      .filter((c) => matchesSegment(c, segment))
      .filter((c) => (q ? c.name.toLowerCase().includes(q) : true));
  }, [custodians, query, segment]);

  const flash = (msg: string, kind: "success" | "error") => {
    if (kind === "success") {
      setFlashSuccess(msg);
      setTimeout(() => setFlashSuccess(null), 3000);
    } else {
      setFlashError(msg);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = addName.trim();
    if (!name) return;
    setAdding(true);
    setFlashError(null);
    try {
      const res = await fetch("/api/custodians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to create");
      flash(`Added ${json.name}`, "success");
      setAddName("");
      setShowAdd(false);
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to add", "error");
    } finally {
      setAdding(false);
    }
  };

  if (status === "loading" || isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center gap-4">
          <button
            onClick={() => router.push("/")}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--invert-bg)] text-[var(--invert-text)]">
              <Building2 size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                Custodians &amp; Fees
              </h1>
              <p className="text-sm text-muted">
                Manage delivering-custodian records and their ACAT fee schedules
              </p>
            </div>
          </div>
        </div>

        {/* Status messages */}
        {error && (
          <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-3 text-sm text-[color:var(--danger)]">
            <AlertTriangle size={16} className="shrink-0" />
            Failed to load custodians
          </div>
        )}
        {flashError && (
          <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-3 text-sm text-[color:var(--danger)]">
            <AlertTriangle size={16} className="shrink-0" />
            {flashError}
            <button onClick={() => setFlashError(null)} className="ml-auto">
              <X size={14} />
            </button>
          </div>
        )}
        {flashSuccess && (
          <div className="mb-6 flex items-center gap-2.5 rounded-lg border border-[color:var(--success-border)] bg-[color:var(--success-bg)] px-4 py-3 text-sm text-[color:var(--success)]">
            <Check size={16} className="shrink-0" />
            {flashSuccess}
          </div>
        )}

        {/* Add custodian — admin only */}
        {isAdmin && (
        <div className="mb-6 rounded-xl border border-card-border bg-[var(--bg-card)] p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Plus size={16} className="text-accent" />
              Add Custodian
            </h2>
            {!showAdd && (
              <button
                onClick={() => setShowAdd(true)}
                className="rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-1 text-xs font-medium text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
              >
                New
              </button>
            )}
          </div>
          {showAdd && (
            <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[240px]">
                <label className="mb-1 block text-xs font-medium text-muted">
                  Custodian name
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="e.g. Betterment"
                  className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
              <button
                type="submit"
                disabled={adding}
                className="flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-5 py-2 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 disabled:opacity-50"
              >
                {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Add
              </button>
              <button
                type="button"
                onClick={() => { setShowAdd(false); setAddName(""); }}
                className="rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-muted transition hover:text-foreground"
              >
                Cancel
              </button>
            </form>
          )}
        </div>
        )}

        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-accent" />
            <h2 className="text-sm font-semibold text-foreground">Custodians</h2>
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-bold text-muted">
              {visible.length}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-faint" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name"
                className="w-60 rounded-lg border border-card-border bg-[var(--bg-card)] py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
            <button
              type="button"
              onClick={() => exportCustodiansCsv(visible)}
              disabled={visible.length === 0}
              title="Export current view as CSV"
              className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download size={12} />
              Export CSV
            </button>
            <div role="tablist" className="flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-card-border bg-[var(--bg-card)] p-1">
              {SEGMENTS.map((seg) => {
                const isActive = seg.key === segment;
                return (
                  <button
                    key={seg.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setSegment(seg.key)}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      isActive
                        ? "bg-[var(--invert-bg)] text-[var(--invert-text)]"
                        : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
                    }`}
                  >
                    {seg.label}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                      isActive
                        ? "bg-[var(--invert-text)]/10 text-[var(--invert-text)]"
                        : "bg-[var(--bg-hover)] text-muted"
                    }`}>
                      {segmentCounts[seg.key]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Cards */}
        {visible.length === 0 ? (
          <div className="rounded-xl border border-card-border bg-[var(--bg-card)] px-6 py-12 text-center text-sm text-muted">
            No custodians match that filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((c) => (
              <CustodianCard key={c.id} custodian={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function exportCustodiansCsv(custodians: CustodianSummary[]) {
  if (typeof document === "undefined" || custodians.length === 0) return;
  const header = [
    "Custodian",
    "Observed Avg Processing Business Days",
    "Completed Timing Sample",
    "Contact Email",
    "Fee Type",
    "Account Type",
    "Transfer Type",
    "Amount",
    "Amount Text",
  ];
  const rows: string[][] = [];
  for (const c of custodians) {
    const base = [
      c.name,
      c.observedAvgProcessingBusinessDays == null
        ? ""
        : String(c.observedAvgProcessingBusinessDays),
      String(c.observedCompletedTransfers),
      c.contactEmail ?? "",
    ];
    if (c.fees.length === 0) {
      rows.push([...base, "", "", "", "", ""]);
      continue;
    }
    for (const f of c.fees) {
      rows.push([
        ...base,
        f.feeType,
        f.accountType,
        f.transferType,
        f.amount != null ? f.amount.toFixed(2) : "",
        f.amountText ?? "",
      ]);
    }
  }
  const csv = [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `custodians-fees-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Formula-safe: custodian names and notes in the export are typed by other people.
const csvEscape = csvCell;
