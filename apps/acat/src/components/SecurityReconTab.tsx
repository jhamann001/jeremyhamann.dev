"use client";

import { csvCell } from "@/lib/csv-cell";
import { useCallback, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Database,
  Upload,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  CloudDownload,
  Download,
  FileSpreadsheet,
  RefreshCw,
  ArrowRightLeft,
  Trash2,
  TrendingDown,
  TrendingUp,
  HelpCircle,
  Loader2,
  Save,
  Check,
  X,
  Pencil,
} from "lucide-react";
import { AcatRecord, ApexPosition, Asset, AssetMappingContext } from "@/lib/types";
import { parseApexFile, ApexFileFormat } from "@/lib/parse-apex-csv";
import { parseAssetMappingCsv } from "@/lib/parse-asset-mapping-csv";
import StatusBadge from "./StatusBadge";
import { useToast } from "./Toast";
import MappingAccountPicker from "./MappingAccountPicker";
import { demoMode } from "@/lib/demo/mode";
import type { MappingAccount } from "@/lib/mapping-account";
import {
  type ReconRow,
  formatReconCash,
  normalizeTicker,
  isCashSymbol,
  aggregateApexPositions,
  reconcile,
  previewReconCounts,
  storedReconCounts,
  storedReconRows,
  toMapStatus,
} from "@/lib/security-recon";

// The reconciliation engine lives in `@/lib/security-recon` so the machine
// route and this tab share one implementation. Existing imports of these
// names from this module keep resolving.
export { formatReconCash, normalizeTicker, aggregateApexPositions, reconcile };

interface SecurityReconTabProps {
  acat: AcatRecord;
  // Accept Promise-returning refreshers so the save flow can await the
  // parent's list revalidation. Without this, the button's "Saving…" state
  // can clear before `/api/acats` has been refetched, letting a fast
  // close-and-reopen of the drawer hydrate from the pre-save SWR cache.
  onMutate?: () => void | Promise<void>;
}

interface MappingData {
  acatId: string;
  mappingSource: string;
  apexSource: string;
  assets: Asset[];
  lastSynced: string | null;
  sourceAccount?: MappingAccount | null;
}

export default function SecurityReconTab({ acat, onMutate }: SecurityReconTabProps) {
  const { mutate: mutateCache } = useSWRConfig();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [apexPositions, setApexPositions] = useState<ApexPosition[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [mappingUploading, setMappingUploading] = useState(false);
  const [mappingUploadError, setMappingUploadError] = useState<string | null>(null);
  const [savingRecon, setSavingRecon] = useState(false);
  const [apexFormat, setApexFormat] = useState<ApexFileFormat | null>(null);
  // Row-level manual overrides. `rowEdits` layers field changes on top of the
  // computed recon rows so the user can key in actualQty / status / note for
  // edge cases. `overriddenIds` tracks which rows were hand-edited so we can
  // surface a "manually set" indicator even after the computed values happen
  // to match the override.
  const [rowEdits, setRowEdits] = useState<Map<string, Partial<ReconRow>>>(new Map());
  const [overriddenIds, setOverriddenIds] = useState<Set<string>>(new Set());
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    actualQty: string;
    status: ReconRow["status"];
    issue: string;
    notes: string;
  }>({
    actualQty: "",
    status: "Matched",
    issue: "",
    notes: "",
  });
  const { toast } = useToast();
  const [sourcePickerFor, setSourcePickerFor] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<{ acatId: string; message: string } | null>(null);

  // SWR-backed mapping fetch. Revalidates on window focus / network reconnect
  // and on the global refreshInterval, so other users' GCP syncs surface
  // without requiring the current user to reopen the drawer.
  const {
    data: mappingData,
    error: mappingErrorObj,
    isLoading: mappingLoading,
    mutate: mutateMapping,
  } = useSWR<MappingData>(
    acat.id ? `/api/asset-mapping?acatId=${acat.id}` : null
  );
  const mappingError = mappingErrorObj
    ? mappingErrorObj instanceof Error
      ? mappingErrorObj.message
      : "Failed to load"
    : null;
  const expectedAssets = mappingData?.assets ?? acat.assets;

  const handleSyncFromGcp = useCallback(async (sourceAccountId?: string) => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/asset-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acatId: acat.id, ...(sourceAccountId ? { sourceAccountId } : {}) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (["SOURCE_ACCOUNT_NOT_FOUND", "SOURCE_ACCOUNT_SELECTION_REQUIRED", "MISSING_ACCOUNT_NUMBER"].includes(data.code)) setSourcePickerFor(acat.id);
        throw new Error(data.error ?? "Sync failed");
      }
      const updated: MappingData = await res.json();
      await mutateMapping(updated, { revalidate: false });
      await onMutate?.();
      await mutateCache((key) => typeof key === "string" && (
        key === `/api/acats/${encodeURIComponent(acat.id)}/manual-form-recommendation` ||
        key === `/api/acats/${encodeURIComponent(acat.id)}/paperwork-assets`
      ));
      setSourcePickerFor(null);
      toast("success", "Sync Complete", "Asset mapping refreshed from GCP");
    } catch (err) {
      setSyncError({ acatId: acat.id, message: err instanceof Error ? err.message : "Sync failed" });
      toast("error", "Sync Failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSyncing(false);
    }
  }, [acat.id, mutateMapping, mutateCache, onMutate, toast]);

  const handleMappingUpload = useCallback(
    (file: File) => {
      if (file.size > 2 * 1024 * 1024) {
        setMappingUploadError("Mapping CSV must be 2 MB or smaller.");
        return;
      }
      if (!acat.statementAccountNumber) {
        const message = "Add the statement account number before uploading a mapping CSV.";
        setMappingUploadError(message);
        toast("error", "Upload blocked", message);
        return;
      }
      setMappingUploading(true);
      setMappingUploadError(null);
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const parsed = parseAssetMappingCsv(
            String(event.target?.result ?? ""),
            acat.statementAccountNumber!
          );
          const response = await fetch("/api/asset-mapping", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              acatId: acat.id,
              source: "spreadsheet",
              filename: file.name,
              sourceAccountNumber: parsed.accountLabel,
              positions: parsed.positions,
            }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? "Mapping import failed");
          }
          const partial = acat.type?.toLowerCase().includes("partial");
          toast(
            parsed.undecidedCount > 0 && partial ? "warning" : "success",
            "Mapping Imported",
            parsed.undecidedCount > 0 && partial
              ? `${parsed.positions.length} positions saved. Review the undecided holdings under transfer paperwork; no re-upload is needed.`
              : `${parsed.positions.length} positions and a matching-account CSV saved to this transfer.`
          );
          await Promise.all([
            mutateMapping(), Promise.resolve(onMutate?.()),
            mutateCache((key) => typeof key === "string" && (
              key.startsWith(`/api/acats/${encodeURIComponent(acat.id)}/documents`) ||
              key === `/api/acats/${encodeURIComponent(acat.id)}/manual-form-recommendation` ||
              key === `/api/acats/${encodeURIComponent(acat.id)}/paperwork-assets`
            )),
          ]);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Mapping import failed";
          setMappingUploadError(message);
          toast("error", "Mapping Upload Failed", message);
        } finally {
          setMappingUploading(false);
        }
      };
      reader.onerror = () => {
        setMappingUploading(false);
        setMappingUploadError("The mapping CSV could not be read.");
      };
      reader.readAsText(file);
    },
    [acat.id, acat.statementAccountNumber, acat.type, mutateMapping, mutateCache, onMutate, toast]
  );

  const saveReconResults = useCallback(async (rows: ReconRow[]) => {
    setSavingRecon(true);
    try {
      const assetUpdates = rows
        .filter((r) => r.id && !r.id.startsWith("apex-extra-"))
        .map((r) => ({
          id: r.id,
          actualQty: r.actualQty,
          mapStatus: toMapStatus(r.status),
          issue: r.issue ?? null,
          notes: r.notes ?? null,
        }));

      // Apex-only "Unexpected" rows aren't real Asset rows yet — they exist
      // only in the recon output. Persist the ones the user actually
      // touched so they get a real DB id and pick up status/issue/notes
      // on the next render. Untouched apex-extras stay ephemeral so an
      // upload doesn't clutter the DB with positions ops never reviewed.
      const newAssets = rows
        .filter(
          (r) => r.id.startsWith("apex-extra-") && overriddenIds.has(r.id)
        )
        .map((r) => ({
          symbol: r.symbol,
          description: r.description,
          cusip: r.cusip ?? null,
          expectedQty: 0,
          actualQty: r.actualQty,
          mapStatus: toMapStatus(r.status),
          issue: r.issue ?? null,
          notes: r.notes ?? null,
          amount: r.amount ?? null,
          assetClass: r.assetClass ?? null,
        }));

      // Persist asset quantities + mark the Apex CSV as the source. The ACAT
      // record's workflow status is owned by the user — don't overwrite it
      // from the recon screen.
      // Only declare apexSource:Uploaded when this save was triggered by a
      // CSV upload. A bare "edit a row + save" flow shouldn't claim an
      // upload happened — that misleads the Transfer Details summary chip.
      const res = await fetch(`/api/acats/${acat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(apexPositions ? { apexSource: "Uploaded" } : {}),
          assets: assetUpdates,
          ...(newAssets.length > 0 ? { newAssets } : {}),
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast("success", "Recon Saved", "Reconciliation results persisted to database");
      // Wait for BOTH the asset-mapping and acat-list caches to refresh
      // before leaving the "Saving…" state. If the parent's refresh is
      // still in flight when the user closes and reopens the drawer,
      // `openRecord` resolves against the pre-save list snapshot and the
      // drawer hydrates with stale `acat.assets`. We keep the CSV state
      // populated during this wait so the spinner button stays visible
      // instead of vanishing mid-save.
      await Promise.all([
        mutateMapping(),
        Promise.resolve(onMutate?.()),
      ]);
      // Manual overrides are now the authoritative DB state — drop the
      // client-side layer so the "Manual" badge doesn't linger and the
      // next save starts from a clean slate derived from the refreshed
      // ACAT record. Also drop the in-memory CSV so the view collapses
      // onto the freshly-refetched DB assets instead of keeping a stale
      // `reconRows` shadow derived from the last upload.
      setRowEdits(new Map());
      setOverriddenIds(new Set());
      setCsvFile(null);
      setApexPositions(null);
      setApexFormat(null);
      setParseError(null);
    } catch (err) {
      toast("error", "Save Failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingRecon(false);
    }
  }, [acat.id, apexPositions, overriddenIds, mutateMapping, onMutate, toast]);

  const startRowEdit = useCallback((row: ReconRow) => {
    setEditingRowId(row.id);
    setDraft({
      actualQty: String(row.actualQty ?? 0),
      status: row.status === "Info" ? "Matched" : row.status,
      issue: row.issue ?? "",
      notes: row.notes ?? "",
    });
  }, []);

  const cancelRowEdit = useCallback(() => {
    setEditingRowId(null);
  }, []);

  const saveRowEdit = useCallback(() => {
    if (!editingRowId) return;
    const parsedQty = parseFloat(draft.actualQty);
    const qty = Number.isFinite(parsedQty) ? parsedQty : 0;
    setRowEdits((prev) => {
      const next = new Map(prev);
      next.set(editingRowId, {
        actualQty: qty,
        status: draft.status,
        // `|| undefined` (instead of `""`) keeps the override value
        // matching the optional ReconRow.issue / .notes shape so the
        // saveReconResults `?? null` mapping translates a cleared field
        // to a server-side null delete.
        issue: draft.issue.trim() || undefined,
        notes: draft.notes.trim() || undefined,
      });
      return next;
    });
    setOverriddenIds((prev) => {
      const next = new Set(prev);
      next.add(editingRowId);
      return next;
    });
    setEditingRowId(null);
  }, [editingRowId, draft]);

  const processFile = useCallback(
    (file: File) => {
      setCsvFile(file);
      setParseError(null);
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target?.result as string;
          const { format, positions } = parseApexFile(text);
          setApexPositions(positions);
          setApexFormat(format);
          const label = format === "acat" ? "ACAT Output" : "Activities export";
          toast(
            "success",
            "CSV Parsed",
            `${positions.length} positions loaded from ${file.name} (${label})`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to parse CSV";
          setParseError(msg);
          setApexPositions(null);
          setApexFormat(null);
          toast("error", "Parse Error", msg);
        }
      };
      reader.readAsText(file);
    },
    [toast]
  );

  // Demo: uploads are off, so the Apex report comes from the server, built for this transfer.
  const uploadsOff = demoMode();
  const [loadingSample, setLoadingSample] = useState(false);
  const loadSampleReport = useCallback(async () => {
    setLoadingSample(true);
    try {
      const res = await fetch(`/api/acats/${encodeURIComponent(acat.id)}/sample-recon-report`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not load the sample report");
      }
      processFile(new File([await res.text()], "apex-acat-output-sample.csv", { type: "text/csv" }));
    } catch (err) {
      toast("error", "Sample report", err instanceof Error ? err.message : "Could not load the sample report");
    } finally {
      setLoadingSample(false);
    }
  }, [acat.id, processFile, toast]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith(".csv") || file.name.endsWith(".CSV"))) {
        processFile(file);
      } else {
        toast("error", "Invalid file", "Please upload a .csv file.");
      }
    },
    [processFile, toast]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleClear = () => {
    setCsvFile(null);
    setApexPositions(null);
    setApexFormat(null);
    setParseError(null);
  };

  const reconRows = useMemo(() => {
    if (!apexPositions) return null;
    return reconcile(expectedAssets, apexPositions);
  }, [expectedAssets, apexPositions]);

  const reconStats = useMemo(() => {
    if (reconRows) {
      return { ...previewReconCounts(reconRows), source: "csv" as const };
    }
    // Static view: trust the persisted mapStatus, not the raw qty delta.
    return { ...storedReconCounts(expectedAssets), source: "static" as const };
  }, [reconRows, expectedAssets]);

  const displayRows: ReconRow[] = useMemo(() => {
    const base = reconRows ?? storedReconRows(expectedAssets);
    // Apply any manual overrides on top of the computed values.
    if (rowEdits.size === 0) return base;
    return base.map((r) => {
      const edit = rowEdits.get(r.id);
      return edit ? { ...r, ...edit } : r;
    });
  }, [reconRows, expectedAssets, rowEdits]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--status-blue-bg)]">
                <Database size={16} className="text-accent" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">
                Asset Mapping (Internal DB)
              </h3>
            </div>
            <button
              onClick={() => void handleSyncFromGcp()}
              disabled={syncing}
              className="rounded-md p-1.5 text-muted transition hover:bg-[var(--bg-hover)] hover:text-accent disabled:opacity-50"
              title="Sync from GCP"
            >
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
            </button>
          </div>
          <div className="space-y-2.5">
            {syncError?.acatId === acat.id && <p role="alert" className="rounded-md bg-[color:var(--danger-bg)] p-2 text-xs text-[color:var(--danger)]">{syncError.message}</p>}
            {mappingLoading ? (
              <div className="flex items-center gap-2 text-muted">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-xs">Loading mapping data...</span>
              </div>
            ) : mappingError ? (
              <>
                <InfoRow label="Source" value={acat.mappingSource} />
                <InfoRow label="Assets loaded" value={`${acat.assets.length} positions`} />
                <div className="flex items-center gap-1.5 rounded-lg bg-[color:var(--danger-bg)] px-3 py-2 text-xs font-medium text-[color:var(--danger)]">
                  <AlertCircle size={13} />
                  Failed to load mapping data
                </div>
              </>
            ) : (
              <>
                <InfoRow label="Source" value={mappingData?.mappingSource ?? acat.mappingSource} />
                <InfoRow label="Assets loaded" value={`${mappingData?.assets.length ?? acat.assets.length} positions`} />
                <InfoRow
                  label="Last GCP sync"
                  value={formatMappingSync(mappingData ? mappingData.lastSynced : acat.mappingSyncedAt)}
                />
                {mappingData?.sourceAccount && <>
                  <InfoRow label="Linked account" value={`${mappingData.sourceAccount.holder || mappingData.sourceAccount.clientName} — ${mappingData.sourceAccount.registration || "Registration not provided"}`} />
                  <InfoRow label="Statement" value={mappingData.sourceAccount.statementDate || "Not provided"} />
                  {mappingData.sourceAccount.isHistorical && <p className="text-xs text-[color:var(--warning)]">Using the latest available account data from an earlier household run.</p>}
                </>}
                <div className="flex items-center gap-1.5 rounded-lg bg-[color:var(--info-bg)] px-3 py-2 text-xs font-medium text-accent">
                  <CloudDownload size={13} />
                  {mappingData?.mappingSource === "GCP Project API"
                    ? "Connected to GCP statement-pipeline"
                    : `Source: ${mappingData?.mappingSource ?? "Unknown"}`}
                </div>
              </>
            )}
            <button type="button" onClick={() => setSourcePickerFor(acat.id)} disabled={syncing} className="text-xs font-semibold text-accent hover:underline disabled:opacity-50">{mappingData?.sourceAccount ? "Change mapping account" : "Choose mapping account"}</button>
            {sourcePickerFor === acat.id && <MappingAccountPicker key={acat.id} acatId={acat.id} clientName={acat.clientName} accountType={acat.accountType} syncing={syncing} onSelect={handleSyncFromGcp} onClose={() => setSourcePickerFor(null)} />}
            {uploadsOff ? (
              <p className="text-[11px] leading-relaxed text-muted">
                Uploads are off in this demo. Sync loads the positions from asset mapping.
              </p>
            ) : (<>
            <div className="grid grid-cols-2 gap-2">
              <label className="relative flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-card-border px-3 py-2 text-center text-xs font-semibold text-foreground transition hover:border-accent/50 hover:bg-accent-light/50">
                {mappingUploading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Upload size={13} />
                )}
                {mappingUploading ? "Importing…" : "Upload CSV"}
                <input
                  type="file"
                  accept=".csv"
                  disabled={mappingUploading}
                  className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  aria-label="Upload asset mapping CSV"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) handleMappingUpload(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <a
                href="/templates/asset-mapping-upload-template.csv"
                download="asset-mapping-upload-template.csv"
                className="flex items-center justify-center gap-1.5 rounded-lg border border-card-border px-3 py-2 text-center text-xs font-semibold text-foreground transition hover:border-accent/50 hover:bg-accent-light/50"
              >
                <Download size={13} />
                Download template
              </a>
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              Uses the matching statement account only. For partial transfers,
              add an <span className="font-semibold">Include in Partial Transfer</span>{" "}
              column with Yes or No before upload, or edit the saved choices
              in transfer paperwork afterward.
            </p>
            </>)}
            <p className="text-[11px] leading-relaxed text-muted">
              Saved CSVs and generated PDFs are under Saved inputs &amp; paperwork
              in Transfer Details.
            </p>
            {mappingUploadError && (
              <div className="flex items-start gap-1.5 rounded-lg bg-[color:var(--danger-bg)] px-3 py-2 text-xs text-[color:var(--danger)]">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                {mappingUploadError}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--status-violet-bg)]">
                <FileSpreadsheet size={16} className="text-[color:var(--status-violet-fg)]" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">
                Apex Output / Activities
              </h3>
            </div>
            {apexPositions && (
              <div className="flex items-center gap-2">
                {apexFormat && (
                  <span className="rounded-full border border-card-border bg-[var(--bg-hover)] px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {apexFormat === "acat" ? "ACAT Output" : "Activities export"}
                  </span>
                )}
                <span className="rounded-full bg-[color:var(--status-emerald-bg)] px-2 py-0.5 text-[11px] font-semibold text-[color:var(--status-emerald-fg)]">
                  {apexPositions.length} positions parsed
                </span>
              </div>
            )}
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={uploadsOff ? (e) => e.preventDefault() : handleDrop}
            className={`relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-all ${
              isDragOver
                ? "border-accent bg-accent-light scale-[1.01]"
                : csvFile
                  ? "border-[color:var(--status-emerald-edge)] bg-[color:var(--status-emerald-bg)]"
                  : "border-card-border bg-[var(--bg-hover)] hover:border-accent/50 hover:bg-accent-light/50"
            }`}
          >
            {!uploadsOff && (
              <input
                type="file"
                accept=".csv"
                aria-label="Upload Apex output CSV"
                onChange={handleFileInput}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            )}
            {csvFile ? (
              <div className="flex flex-col items-center gap-1">
                <CheckCircle2 size={22} className="text-[color:var(--success)]" />
                <p className="text-sm font-semibold text-[color:var(--status-emerald-fg)]">
                  {csvFile.name}
                </p>
                <p className="text-[11px] text-muted">
                  {(csvFile.size / 1024).toFixed(1)} KB
                  {apexPositions
                    ? ` · ${apexPositions.length} positions`
                    : ""}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClear();
                  }}
                  className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-[color:var(--danger)] transition hover:bg-[color:var(--danger-bg)]"
                >
                  <Trash2 size={10} />
                  Remove
                </button>
              </div>
            ) : uploadsOff ? (
              <>
                <button
                  type="button"
                  onClick={() => void loadSampleReport()}
                  disabled={loadingSample}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-xs font-semibold text-foreground transition hover:border-accent/50 hover:bg-accent-light/50 disabled:opacity-50"
                >
                  {loadingSample ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />}
                  Use the sample report
                </button>
                <p className="mt-2 text-[11px] text-muted">
                  Uploads are off in this demo. The sample is Apex&rsquo;s ACAT Output for this transfer.
                </p>
              </>
            ) : (
              <>
                <Upload size={22} className="mb-1.5 text-muted-faint" />
                <p className="text-sm font-medium text-foreground">
                  Drop Apex CSV here
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  ACAT Output or Activities export &middot; .csv only
                </p>
              </>
            )}
          </div>

          {parseError && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-[color:var(--danger-bg)] px-3 py-2 text-xs text-[color:var(--danger)]">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              {parseError}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-[var(--bg-card)] px-5 py-3.5">
        <div className="flex items-center gap-2">
          <ArrowRightLeft size={14} className="text-accent" />
          <span className="text-sm font-semibold text-foreground">
            Reconciliation
          </span>
        </div>
        <div className="h-4 w-px bg-card-border" />
        <div className="flex items-center gap-5 text-xs">
          <span className="text-muted">
            <strong className="text-foreground">{reconStats.total}</strong> positions
          </span>
          <span className="text-muted">
            <strong className="text-[color:var(--success)]">{reconStats.matched}</strong> matched
          </span>
          <span className="text-muted">
            <strong className={reconStats.issues > 0 ? "text-[color:var(--danger)]" : "text-[color:var(--success)]"}>
              {reconStats.issues}
            </strong>{" "}
            {reconStats.issues === 1 ? "issue" : "issues"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="h-2 w-32 overflow-hidden rounded-full bg-[var(--fill-1)]">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                reconStats.reconRate === 100
                  ? "bg-[color:var(--success)]"
                  : reconStats.reconRate > 50
                    ? "bg-[color:var(--accent)]"
                    : "bg-[color:var(--warning)]"
              }`}
              style={{ width: `${reconStats.reconRate}%` }}
            />
          </div>
          <span className="text-xs font-bold text-foreground">
            {reconStats.reconRate}%
          </span>
        </div>
      </div>

      {(reconRows || overriddenIds.size > 0) && (
        <div className="flex items-center justify-end">
          <button
            onClick={() => saveReconResults(displayRows)}
            disabled={savingRecon}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--invert-text)] shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
          >
            {savingRecon ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {savingRecon ? "Saving..." : "Save Recon Results"}
          </button>
        </div>
      )}

      <div className="rounded-xl border border-card-border bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-card-border px-5 py-3.5">
          <h3 className="text-sm font-semibold text-foreground">
            Position Details
          </h3>
          <div className="flex items-center gap-2">
            {reconStats.issues > 0 && (
              <div className="flex items-center gap-1.5 rounded-md bg-[color:var(--danger-bg)] px-2.5 py-1 text-xs font-semibold text-[color:var(--danger)]">
                <AlertTriangle size={12} />
                {reconStats.issues} discrepanc{reconStats.issues === 1 ? "y" : "ies"} detected
              </div>
            )}
            <button
              onClick={() => exportReconCsv(displayRows, acat)}
              disabled={displayRows.length === 0}
              title="Download reconciliation as CSV"
              className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-xs font-medium text-foreground transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download size={12} />
              Download CSV
            </button>
          </div>
        </div>

        <p className="border-b border-card-border px-5 py-2.5 text-xs text-muted">
          Transfer eligibility, Transferring?, and statement freshness come from asset mapping.
          Reported statement age and stale flags may reflect the original processing date.
        </p>
        <div className="overflow-x-auto" role="region" aria-label="Position details" tabIndex={0}>
          <table className="w-full min-w-[1500px]">
            <thead>
              <tr className="border-b border-card-border bg-[var(--bg-hover)]">
                <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Asset / Symbol
                </th>
                <th scope="col" className="min-w-[230px] px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Transfer eligibility
                </th>
                <th scope="col" className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Transferring?
                </th>
                <th scope="col" className="min-w-[200px] px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Statement freshness
                </th>
                <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Expected (DB)
                </th>
                <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Actual (Apex)
                </th>
                <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Variance
                </th>
                <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Status
                </th>
                <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Issue
                </th>
                <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Notes
                </th>
                <th className="w-16 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted" />
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {displayRows.map((row) => {
                const hasIssue = row.status !== "Matched" && row.status !== "Pending" && row.status !== "Info";
                const variance = row.actualQty - row.expectedQty;
                // Fee rows ("Info") are auto-detected and not user-driven
                // — they have no DB row to update and no meaningful status
                // for ops to override, so leave them read-only. Every
                // other row (including apex-only "Unexpected" surprises)
                // is editable so ops can give it a status / issue / note
                // and persist it.
                const isEditable = row.status !== "Info";
                const isEditing = editingRowId === row.id;
                const isOverridden = overriddenIds.has(row.id);

                return (
                  <tr
                    key={row.id}
                    className={
                      row.status === "Unexpected"
                        ? "group bg-[color:var(--status-amber-bg)]"
                        : hasIssue
                          ? "group bg-[color:var(--danger-bg)]"
                          : "group hover:bg-[var(--bg-hover)]"
                    }
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={`flex h-8 w-8 items-center justify-center rounded-lg text-[10px] font-bold ${
                            row.status === "Unexpected"
                              ? "bg-[color:var(--status-amber-bg)] text-[color:var(--status-amber-fg)]"
                              : hasIssue
                                ? "bg-[color:var(--danger-bg)] text-[color:var(--danger)]"
                                : "bg-[var(--bg-hover)] text-foreground"
                          }`}
                        >
                          {row.symbol.slice(0, 3)}
                        </div>
                        <div>
                          <span className="font-mono text-sm font-semibold text-foreground">
                            {row.symbol}
                          </span>
                          <p className="text-[11px] text-muted leading-tight">
                            {row.description}
                          </p>
                          {row.cusip && (
                            <p className="font-mono text-[10px] text-muted-faint">
                              {row.cusip}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[300px] px-5 py-3 align-top">
                      <span className="text-xs font-semibold text-foreground">
                        {row.mapping?.mappingTransferStatus || (row.mapping?.mappingSyncedAt ? "Not provided" : "—")}
                      </span>
                      {row.mapping?.mappingTransferNotes && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
                          {row.mapping.mappingTransferNotes}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 align-top text-xs text-foreground">
                      {row.mapping?.mappingTransferring === true
                        ? "Yes"
                        : row.mapping?.mappingTransferring === false
                          ? "No"
                          : row.mapping?.mappingSyncedAt ? "Not set" : "—"}
                    </td>
                    <td className="px-5 py-3 align-top">
                      <StatementFreshness mapping={row.mapping} />
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-sm text-foreground">
                      {row.expectedQty === 0
                        ? "—"
                        : isCashSymbol(row.symbol)
                          ? formatReconCash(row.expectedQty)
                          : row.expectedQty.toLocaleString()}
                    </td>
                    <td
                      className={`px-5 py-3 text-right font-mono text-sm ${
                        hasIssue ? "font-bold text-[color:var(--danger)]" : "text-foreground"
                      }`}
                    >
                      {isEditing ? (
                        <input
                          type="number"
                          step="any"
                          value={draft.actualQty}
                          onChange={(e) => setDraft((d) => ({ ...d, actualQty: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRowEdit();
                            if (e.key === "Escape") cancelRowEdit();
                          }}
                          className="w-24 rounded-md border border-accent bg-[var(--bg-card)] px-2 py-1 text-right font-mono text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
                          autoFocus
                        />
                      ) : row.actualQty === 0 ? (
                        "—"
                      ) : isCashSymbol(row.symbol) ? (
                        formatReconCash(row.actualQty)
                      ) : (
                        row.actualQty.toLocaleString()
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {row.actualQty === 0 && row.expectedQty === 0 ? (
                        <span className="text-xs text-muted">N/A</span>
                      ) : row.actualQty === 0 || row.expectedQty === 0 ? (
                        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-[color:var(--warning)]">
                          <HelpCircle size={11} />
                          N/A
                        </span>
                      ) : variance === 0 ? (
                        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-[color:var(--success)]">
                          <CheckCircle2 size={11} />0
                        </span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-0.5 font-mono text-xs font-bold ${
                            variance > 0 ? "text-[color:var(--status-blue-fg)]" : "text-[color:var(--danger)]"
                          }`}
                        >
                          {variance > 0 ? (
                            <TrendingUp size={11} />
                          ) : (
                            <TrendingDown size={11} />
                          )}
                          {isCashSymbol(row.symbol)
                            ? formatReconCash(variance, true)
                            : `${variance > 0 ? "+" : ""}${variance.toLocaleString()}`}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {isEditing ? (
                        <select
                          value={draft.status}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, status: e.target.value as ReconRow["status"] }))
                          }
                          className="rounded-md border border-accent bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
                        >
                          <option value="Matched">Matched</option>
                          <option value="Mismatch">Mismatch</option>
                          <option value="Missing">Missing</option>
                          <option value="Pending">Pending</option>
                          <option value="Expected">Expected</option>
                          <option value="Unexpected">Unexpected</option>
                        </select>
                      ) : (
                        <div className="flex items-center gap-2">
                          <StatusBadge
                            status={
                              row.status === "Matched" || row.status === "Info"
                                ? "Mapped"
                                : row.status === "Pending"
                                  ? "Pending"
                                  : row.status === "Expected"
                                    ? "Expected"
                                    : "Unmapped"
                            }
                          />
                          {isOverridden && (
                            <span
                              className="inline-flex items-center rounded-full border border-card-border bg-[var(--bg-hover)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted"
                              title="Manually set by ops"
                            >
                              Manual
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="max-w-[200px] px-5 py-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={draft.issue}
                          onChange={(e) => setDraft((d) => ({ ...d, issue: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRowEdit();
                            if (e.key === "Escape") cancelRowEdit();
                          }}
                          placeholder="Issue (e.g. fractional shortfall)"
                          className="w-full rounded-md border border-accent bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
                        />
                      ) : row.issue ? (
                        <span
                          className={`flex items-start gap-1 text-xs leading-relaxed ${
                            hasIssue
                              ? "text-[color:var(--danger)]"
                              : "text-muted"
                          }`}
                        >
                          <AlertTriangle
                            size={11}
                            className="mt-0.5 shrink-0"
                          />
                          {row.issue}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-faint">—</span>
                      )}
                    </td>
                    <td className="max-w-[200px] px-5 py-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={draft.notes}
                          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRowEdit();
                            if (e.key === "Escape") cancelRowEdit();
                          }}
                          placeholder="Note (e.g. verified against PDF)"
                          className="w-full rounded-md border border-accent bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
                        />
                      ) : row.notes ? (
                        <span className="text-xs leading-relaxed text-muted">
                          {row.notes}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {isEditable &&
                        (isEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={saveRowEdit}
                              className="rounded p-1 text-[color:var(--success)] hover:opacity-80"
                              title="Save override"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              onClick={cancelRowEdit}
                              className="rounded p-1 text-muted hover:text-foreground"
                              title="Cancel"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => startRowEdit(row)}
                            className="rounded p-1 text-muted opacity-0 transition hover:text-accent group-hover:opacity-100"
                            title="Manually override this row"
                          >
                            <Pencil size={12} />
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function exportReconCsv(rows: ReconRow[], acat: AcatRecord): void {
  if (typeof document === "undefined") return;

  // Formula-safe: position descriptions and notes can be typed by other people.
  const csvEscape = csvCell;

  const header = [
    "Symbol",
    "Description",
    "CUSIP",
    "Expected Qty (DB)",
    "Actual Qty (Apex)",
    "Variance",
    "Status",
    "Issue",
    "Notes",
    "Transfer Eligibility",
    "Transfer Eligibility Notes",
    "Transferring? (Asset Mapping)",
    "Statement Date",
    "Reported Statement Age (Days)",
    "Reported Statement Stale",
    "Asset Mapping Synced At",
  ];

  const dataRows = rows.map((r) => [
    r.symbol,
    r.description,
    r.cusip ?? "",
    String(r.expectedQty),
    String(r.actualQty),
    String(r.actualQty - r.expectedQty),
    r.status,
    r.issue ?? "",
    r.notes ?? "",
    r.mapping?.mappingTransferStatus ?? "",
    r.mapping?.mappingTransferNotes ?? "",
    r.mapping?.mappingTransferring === true ? "Yes" : r.mapping?.mappingTransferring === false ? "No" : "",
    r.mapping?.mappingStatementDate ?? "",
    r.mapping?.mappingStatementAgeDays == null ? "" : String(r.mapping.mappingStatementAgeDays),
    r.mapping?.mappingStatementIsStale === true ? "Yes" : r.mapping?.mappingStatementIsStale === false ? "No" : "",
    r.mapping?.mappingSyncedAt ?? "",
  ]);

  const csv = [header, ...dataRows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");

  const slug =
    acat.controlNumber ||
    acat.clientName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const date = new Date().toISOString().slice(0, 10);

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `acat-${slug}-recon-${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatMappingSync(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Not yet recorded";
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function StatementFreshness({ mapping }: { mapping?: AssetMappingContext }) {
  if (!mapping?.mappingSyncedAt) return <span className="text-xs text-muted-faint">—</span>;
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium text-foreground">{mapping.mappingStatementDate || "Date not provided"}</p>
      <p className="text-muted">
        Reported age: {mapping.mappingStatementAgeDays == null ? "unknown" : `${mapping.mappingStatementAgeDays} days`}
      </p>
      <p className={mapping.mappingStatementIsStale ? "font-semibold text-[color:var(--warning)]" : "text-muted"}>
        {mapping.mappingStatementIsStale === true
          ? "Flagged stale"
          : mapping.mappingStatementIsStale === false ? "Not flagged stale" : "Freshness unknown"}
      </p>
      <p className="text-[10px] text-muted-faint">Synced {formatMappingSync(mapping.mappingSyncedAt)}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
