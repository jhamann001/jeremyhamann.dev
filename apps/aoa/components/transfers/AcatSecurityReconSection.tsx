"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import {
  fetchRecon,
  fetchReconAccounts,
  postRecon,
} from "@/lib/data/acat-security-recon-api";
import {
  RECON_BUSY,
  RECON_DOWNLOAD_FAILURE,
  RECON_EDIT_STATUSES,
  RECON_SAVE_FAILURE,
  RECON_TEMPLATE_CSV,
  RECON_TEMPLATE_FILENAME,
  applyReconEdits,
  buildReconCsv,
  buildSaveRequest,
  buildUploadRequest,
  formatMappingSync,
  formatReconCash,
  isCashSymbol,
  isEditableRow,
  reconCsvFilename,
  reconStatusHue,
  reconVariance,
  rowHasIssue,
  type ReconAccount,
  type ReconAccountsResult,
  type ReconActionBody,
  type ReconCounts,
  type ReconEdit,
  type ReconMapping,
  type ReconPosition,
  type ReconPreview,
  type ReconResult,
  type ReconSaveBody,
  type ReconSnapshot,
  type ReconStatus,
} from "@/lib/data/acat-security-recon-contract";
import {
  ArrowRightLeft,
  Check,
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  CloudDownload,
  Database,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Upload,
  X,
} from "./acat-recon-icons";
import styles from "./AcatSecurityRecon.module.css";

// Security Recon section of the transfer drawer (ticket). Looks and behaves
// like the tracker's Security Recon slide-out: the GCP mapping card, the Apex
// activities drop zone, the reconciliation bar, and the position grid with row
// overrides, Save Recon Results, and Download CSV. The tracker owns every
// position and every matching rule; this component shows what the tracker
// returns and sends what the user chose.

type Notice = { message: string; retry: (() => void) | null };
type Draft = { actualQty: string; status: ReconStatus; issue: string; notes: string };

const EMPTY_COUNTS: ReconCounts = { total: 0, matched: 0, issues: 0, reconRate: 0 };
const APEX_FORMAT_LABEL = { acat: "ACAT Output", activities: "Activities export" } as const;
const SYNC_DONE = "Sync Complete — Asset mapping refreshed from GCP";
const SAVE_DONE = "Recon Saved — Reconciliation results persisted to database";
const REVALIDATE_MIN_MS = 5_000;
const PICKER_OPEN_ON_MISSING = "Add the statement account number or choose";

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

function saveTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function failureMessage(result: ReconResult): string {
  if (result.ok) return "";
  return result.refused ? result.message : result.reason;
}

function ErrorBox({ notice, label }: { notice: Notice | null; label?: string }) {
  if (!notice) return null;
  return (
    <div role="alert" className={styles.alert} data-alert={label}>
      <CircleAlert size={12} className={styles.alertIcon} />
      <p>{notice.message}</p>
      {notice.retry && (
        <button type="button" className={styles.retry} onClick={notice.retry}>Retry</button>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: ReconStatus }) {
  const hue = reconStatusHue(status);
  const hueClass = { emerald: styles.hueEmerald, amber: styles.hueAmber, blue: styles.hueBlue, violet: styles.hueViolet }[hue];
  return (
    <span data-status={status} data-hue={hue} className={`${styles.badge} ${hueClass}`}>
      <span className={styles.badgeDot} />
      {status}
    </span>
  );
}

function StatementFreshness({ mapping }: { mapping: ReconMapping }) {
  if (!mapping.mappingSyncedAt) return <span className={styles.dash}>—</span>;
  return (
    <div className={styles.freshness}>
      <p className={styles.freshnessDate}>{mapping.mappingStatementDate || "Date not provided"}</p>
      <p className={styles.muted}>
        Reported age: {mapping.mappingStatementAgeDays == null ? "unknown" : `${mapping.mappingStatementAgeDays} days`}
      </p>
      <p className={mapping.mappingStatementIsStale ? styles.freshnessStale : styles.muted}>
        {mapping.mappingStatementIsStale === true
          ? "Flagged stale"
          : mapping.mappingStatementIsStale === false ? "Not flagged stale" : "Freshness unknown"}
      </p>
      <p className={styles.freshnessSynced}>Synced {formatMappingSync(mapping.mappingSyncedAt)}</p>
    </div>
  );
}

function AccountPicker({ recordId, clientName, accountType, syncing, onSelect, onClose }: {
  recordId: string;
  clientName: string;
  accountType: string;
  syncing: boolean;
  onSelect: (accountId: string) => void;
  onClose: () => void;
}) {
  const initialSearch = clientName.trim().split(/\s+/).at(-1) ?? "";
  const [input, setInput] = useState(initialSearch);
  const [query, setQuery] = useState(initialSearch);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<ReconAccountsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    if (query.length < 2) return;
    const current = ++request.current;
    setLoading(true);
    setResult(null);
    void fetchReconAccounts(recordId, query).then((next) => {
      if (request.current !== current) return;
      setResult(next);
      setLoading(false);
    });
    return () => { request.current += 1; };
  }, [recordId, query]);

  const accounts: ReconAccount[] = result?.ok ? result.accounts : [];
  const chosen = accounts.find((account) => account.id === selected);
  return (
    <section aria-label="Choose mapping account" className={styles.picker}>
      <h4>Choose mapping account</h4>
      <p className={styles.help}>
        Link holdings for {clientName}{accountType ? ` — ${accountType}` : ""}. Check the holder and registration before syncing.
      </p>
      <form className={styles.pickerForm}
        onSubmit={(event) => { event.preventDefault(); setSelected(null); setQuery(input.trim()); }}>
        <input aria-label="Search mapping accounts" className={styles.pickerInput} value={input}
          onChange={(event) => setInput(event.target.value)} minLength={2} maxLength={100} required disabled={syncing}
          placeholder="Client name or account number" />
        <button type="submit" className={styles.pickerButton} disabled={syncing || input.trim().length < 2}>Search</button>
      </form>
      {loading && <p className={styles.help}>Searching mapping accounts…</p>}
      {result && !result.ok && <p role="alert" className={styles.alert}>{result.reason}</p>}
      {result?.ok && accounts.length === 0 && (
        <p className={styles.help}>No source accounts found. Try another name or add the statement to asset mapping.</p>
      )}
      {result?.ok && result.truncated && (
        <p className={styles.help}>More accounts match. Narrow your search to find the right registration.</p>
      )}
      <div className={styles.pickerList}>
        {accounts.map((account) => (
          <label key={account.id} className={selected === account.id ? `${styles.pickerOption} ${styles.pickerOptionOn}` : styles.pickerOption}>
            <input type="radio" name={`mapping-account-${recordId}`} value={account.id} checked={selected === account.id}
              onChange={() => setSelected(account.id)} disabled={syncing} />
            <span className={styles.pickerText}>
              <span className={styles.pickerName}>{account.holder || account.clientName} — {account.registration || "Registration not provided"}</span>
              <span>{account.custodian || "Custodian not provided"} · {account.accountNumberLast4 ? `Account …${account.accountNumberLast4}` : "No account number"}{account.investorNumberLast4 ? ` · Investor …${account.investorNumberLast4}` : ""}</span>
              <span className={styles.muted}>{account.positionCount} positions · Statement: {account.statementDate || "Not provided"}</span>
              {account.isHistorical && <span className={styles.warn}>Latest available account data is from an earlier household run.</span>}
            </span>
          </label>
        ))}
      </div>
      {chosen && (
        <p className={styles.help}>
          Sync will replace expected holdings with this registration’s positions. Received quantities and reconciliation notes are retained.
        </p>
      )}
      <div className={styles.pickerActions}>
        <button type="button" className={styles.pickerPrimary}
          disabled={!chosen || syncing || loading || (result !== null && !result.ok)}
          onClick={() => chosen && onSelect(chosen.id)}>
          {syncing ? "Syncing…" : "Link and sync"}
        </button>
        <button type="button" className={styles.pickerButton} disabled={syncing} onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

export function AcatSecurityReconSection({ recordId, clientName, controlNumber, accountType, readOnly }: {
  recordId: string;
  clientName: string;
  controlNumber: string;
  accountType: string;
  type?: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [stored, setStored] = useState<ReconSnapshot | null>(null);
  const [loadAlert, setLoadAlert] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<ReconPreview | null>(null);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [edits, setEdits] = useState<Map<string, ReconEdit>>(new Map());
  const [overridden, setOverridden] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ actualQty: "", status: "Matched", issue: "", notes: "" });
  // Position Details starts open; collapsing hides the note and the table, never the header actions.
  const [gridOpen, setGridOpen] = useState(true);
  const gridBodyId = useId();
  const [syncing, setSyncing] = useState(false);
  const [mappingUploading, setMappingUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncAlert, setSyncAlert] = useState<Notice | null>(null);
  const [mappingAlert, setMappingAlert] = useState<Notice | null>(null);
  const [apexAlert, setApexAlert] = useState<Notice | null>(null);
  const [saveAlert, setSaveAlert] = useState<Notice | null>(null);
  const [downloadAlert, setDownloadAlert] = useState<Notice | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const lastRevalidate = useRef(0);

  const load = useCallback(async () => {
    const current = ++loadRequest.current;
    lastRevalidate.current = Date.now();
    setLoadAlert(null);
    const result = await fetchRecon(recordId);
    if (!mounted.current || loadRequest.current !== current) return;
    if (result.ok) setStored(result.snapshot);
    else setLoadAlert({ message: failureMessage(result), retry: () => void load() });
  }, [recordId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; loadRequest.current += 1; };
  }, [load]);

  // The tracker tab revalidates on window focus; so does this section. A failed
  // revalidation keeps the grid on screen and shows a retryable failure.
  useEffect(() => {
    function onFocus() {
      if (busy.current || Date.now() - lastRevalidate.current < REVALIDATE_MIN_MS) return;
      void load();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  function beginAction(retry: () => void, slot: (notice: Notice | null) => void): boolean {
    if (busy.current) {
      slot({ message: RECON_BUSY, retry });
      return false;
    }
    busy.current = true;
    setNotice(null);
    return true;
  }

  function endAction() {
    busy.current = false;
  }

  /** A write the tracker stored: the returned positions replace the grid and
   *  every unsaved upload, edit, and file goes away (WO-AC-3, WO-AC-7). */
  function adopt(snapshot: ReconSnapshot) {
    setStored(snapshot);
    setPreview(null);
    setFile(null);
    setEdits(new Map());
    setOverridden(new Set());
    setEditingId(null);
    setLoadAlert(null);
    setSyncAlert(null);
    setMappingAlert(null);
    setApexAlert(null);
    setSaveAlert(null);
    router.refresh();
  }

  async function sync(sourceAccountId?: string) {
    if (!beginAction(() => void sync(sourceAccountId), setSyncAlert)) return;
    setSyncAlert(null);
    setSyncing(true);
    const body: ReconActionBody = { action: "refresh", ...(sourceAccountId ? { sourceAccountId } : {}) };
    const result = await postRecon(recordId, body);
    if (!mounted.current) return;
    setSyncing(false);
    endAction();
    if (result.ok) {
      adopt(result.snapshot);
      setPickerOpen(false);
      setNotice(SYNC_DONE);
      return;
    }
    if (result.refused) {
      setStored(result.snapshot);
      if (result.status === 404 || result.status === 409 || (result.status === 422 && result.message.startsWith(PICKER_OPEN_ON_MISSING))) {
        setPickerOpen(true);
      }
    }
    setSyncAlert({ message: failureMessage(result), retry: () => void sync(sourceAccountId) });
  }

  async function uploadMapping(picked: File) {
    const early = buildUploadRequest({
      kind: "mapping", filename: picked.name, text: "", size: picked.size,
      hasStatementAccount: stored?.hasStatementAccount === true,
    });
    if (!early.ok) {
      setMappingAlert({ message: early.reason, retry: null });
      return;
    }
    if (!beginAction(() => void uploadMapping(picked), setMappingAlert)) return;
    setMappingAlert(null);
    setMappingUploading(true);
    let text: string;
    try {
      text = await readFileText(picked);
    } catch {
      setMappingUploading(false);
      endAction();
      setMappingAlert({ message: "The mapping CSV could not be read.", retry: () => void uploadMapping(picked) });
      return;
    }
    const built = buildUploadRequest({
      kind: "mapping", filename: picked.name, text, size: picked.size,
      hasStatementAccount: stored?.hasStatementAccount === true,
    });
    if (!built.ok) {
      setMappingUploading(false);
      endAction();
      setMappingAlert({ message: built.reason, retry: null });
      return;
    }
    const result = await postRecon(recordId, built.body);
    if (!mounted.current) return;
    setMappingUploading(false);
    endAction();
    if (result.ok) {
      adopt(result.snapshot);
      setNotice(`Mapping Imported — ${result.snapshot.positions.length} positions saved to this transfer.`);
      return;
    }
    if (result.refused) setStored(result.snapshot);
    setMappingAlert({ message: failureMessage(result), retry: () => void uploadMapping(picked) });
  }

  async function uploadApex(picked: File) {
    const early = buildUploadRequest({
      kind: "apex", filename: picked.name, text: "", size: picked.size,
      hasStatementAccount: stored?.hasStatementAccount === true,
    });
    if (!early.ok) {
      setApexAlert({ message: early.reason, retry: null });
      return;
    }
    if (!beginAction(() => void uploadApex(picked), setApexAlert)) return;
    setApexAlert(null);
    let text: string;
    try {
      text = await readFileText(picked);
    } catch {
      endAction();
      setApexAlert({ message: "The file could not be read.", retry: () => void uploadApex(picked) });
      return;
    }
    const built = buildUploadRequest({
      kind: "apex", filename: picked.name, text, size: picked.size,
      hasStatementAccount: stored?.hasStatementAccount === true,
    });
    if (!built.ok) {
      endAction();
      setApexAlert({ message: built.reason, retry: null });
      return;
    }
    const result = await postRecon(recordId, built.body);
    if (!mounted.current) return;
    endAction();
    if (result.ok && result.preview) {
      setStored(result.snapshot);
      setPreview(result.preview);
      setFile({ name: picked.name, size: picked.size });
      setEdits(new Map());
      setOverridden(new Set());
      setEditingId(null);
      return;
    }
    // A file the tracker cannot read never replaces the saved positions.
    setPreview(null);
    setFile(null);
    setEdits(new Map());
    setOverridden(new Set());
    if (!result.ok && result.refused) setStored(result.snapshot);
    setApexAlert({
      message: result.ok ? "The tracker did not return a preview — try again." : failureMessage(result),
      retry: () => void uploadApex(picked),
    });
  }

  const rows = useMemo(
    () => applyReconEdits(preview?.positions ?? stored?.positions ?? [], edits),
    [preview, stored, edits],
  );
  const counts: ReconCounts = preview?.counts ?? stored?.counts ?? EMPTY_COUNTS;

  async function submitSave(body: ReconSaveBody) {
    if (!beginAction(() => void submitSave(body), setSaveAlert)) return;
    setSaveAlert(null);
    setSaving(true);
    const result = await postRecon(recordId, body);
    if (!mounted.current) return;
    setSaving(false);
    endAction();
    if (result.ok) {
      adopt(result.snapshot);
      setNotice(SAVE_DONE);
      return;
    }
    // The grid goes back to the last saved positions; the draft stays in this
    // closure so Retry re-sends exactly what the user was looking at.
    if (result.refused) setStored(result.snapshot);
    setPreview(null);
    setFile(null);
    setEdits(new Map());
    setOverridden(new Set());
    setEditingId(null);
    setSaveAlert({
      message: `${RECON_SAVE_FAILURE} ${failureMessage(result)}`.trim(),
      retry: () => void submitSave(body),
    });
  }

  function save() {
    const built = buildSaveRequest({ rows, apexUploaded: preview !== null, overriddenIds: overridden });
    if (!built.ok) {
      setSaveAlert({ message: built.reason, retry: null });
      return;
    }
    void submitSave(built.body);
  }

  function startRowEdit(row: ReconPosition) {
    setEditingId(row.id);
    setDraft({
      actualQty: String(row.actualQty ?? 0),
      status: row.status === "Info" ? "Matched" : row.status,
      issue: row.issue ?? "",
      notes: row.notes ?? "",
    });
  }

  function saveRowEdit() {
    if (!editingId) return;
    const parsed = parseFloat(draft.actualQty);
    const id = editingId;
    setEdits((prev) => {
      const next = new Map(prev);
      next.set(id, {
        actualQty: Number.isFinite(parsed) ? parsed : 0,
        status: draft.status,
        issue: draft.issue.trim() || null,
        notes: draft.notes.trim() || null,
      });
      return next;
    });
    setOverridden((prev) => new Set(prev).add(id));
    setEditingId(null);
  }

  function runDownload(text: string, filename: string) {
    try {
      saveTextFile(text, filename);
      setDownloadAlert(null);
    } catch {
      setDownloadAlert({ message: RECON_DOWNLOAD_FAILURE, retry: () => runDownload(text, filename) });
    }
  }

  function downloadGrid() {
    try {
      const csv = buildReconCsv(rows);
      runDownload(csv, reconCsvFilename({ controlNumber, clientName }, new Date()));
    } catch {
      setDownloadAlert({ message: RECON_DOWNLOAD_FAILURE, retry: downloadGrid });
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (readOnly) return;
    const dropped = event.dataTransfer.files[0];
    if (!dropped) return;
    void uploadApex(dropped);
  }

  const loading = stored === null && loadAlert === null;
  const rate = counts.reconRate;
  const showSave = !readOnly && (preview !== null || overridden.size > 0);
  const apexFormat = preview ? APEX_FORMAT_LABEL[preview.apexFormat] : null;
  const source = stored?.mappingSource ?? null;

  return (
    <section aria-label="Security reconciliation" data-testid="acat-security-recon" className={styles.section}>
      <h3 className={styles.heading}>Security Recon</h3>
      <ErrorBox notice={loadAlert} label="load" />
      {notice && <p role="status" className={styles.status}>{notice}</p>}

      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h4 className={styles.cardTitle}>
              <span className={`${styles.iconBox} ${styles.iconBlue}`}><Database size={16} /></span>
              Asset Mapping (Internal DB)
            </h4>
            {!readOnly && (
              <button type="button" className={styles.iconButton} title="Sync from GCP" aria-label="Sync from GCP"
                disabled={syncing || mappingUploading || saving} onClick={() => void sync()}>
                <RefreshCw size={13} className={syncing ? styles.spin : undefined} />
              </button>
            )}
          </div>
          <ErrorBox notice={syncAlert} label="sync" />
          {loading ? (
            <p className={styles.help}><LoaderCircle size={14} className={styles.spin} /> Loading mapping data...</p>
          ) : (
            <>
              <InfoRow label="Source" value={source ?? "—"} />
              <InfoRow label="Assets loaded" value={`${stored?.positions.length ?? 0} positions`} />
              <InfoRow label="Last GCP sync" value={formatMappingSync(stored?.lastSynced)} />
              {stored?.sourceAccount && (
                <>
                  <InfoRow label="Linked account"
                    value={`${stored.sourceAccount.holder || stored.sourceAccount.clientName} — ${stored.sourceAccount.registration || "Registration not provided"}`} />
                  <InfoRow label="Statement" value={stored.sourceAccount.statementDate || "Not provided"} />
                  {stored.sourceAccount.isHistorical && (
                    <p className={styles.warn}>Using the latest available account data from an earlier household run.</p>
                  )}
                </>
              )}
              <div className={styles.banner}>
                <CloudDownload size={13} />
                {source === "GCP Project API"
                  ? "Connected to GCP statement-pipeline"
                  : `Source: ${source ?? "Unknown"}`}
              </div>
            </>
          )}
          {!readOnly && (
            <button type="button" className={styles.linkButton} disabled={syncing}
              onClick={() => setPickerOpen(true)}>
              {stored?.sourceAccount ? "Change mapping account" : "Choose mapping account"}
            </button>
          )}
          {!readOnly && pickerOpen && (
            <AccountPicker key={recordId} recordId={recordId} clientName={clientName} accountType={accountType}
              syncing={syncing} onSelect={(id) => void sync(id)} onClose={() => setPickerOpen(false)} />
          )}
          <div className={styles.uploadRow}>
            {!readOnly && (
              <label className={styles.outlineButton}>
                {mappingUploading ? <LoaderCircle size={13} className={styles.spin} /> : <Upload size={13} />}
                {mappingUploading ? "Importing…" : "Upload CSV"}
                <input type="file" accept=".csv" className={styles.fileInput} disabled={mappingUploading || saving}
                  aria-label="Upload asset mapping CSV"
                  onChange={(event) => {
                    const picked = event.target.files?.[0];
                    if (picked) void uploadMapping(picked);
                    event.target.value = "";
                  }} />
              </label>
            )}
            <button type="button" className={styles.outlineButton}
              onClick={() => runDownload(RECON_TEMPLATE_CSV, RECON_TEMPLATE_FILENAME)}>
              <Download size={13} />
              Download template
            </button>
          </div>
          <p className={styles.help}>
            Uses the matching statement account only. For partial transfers, add an{" "}
            <strong>Include in Partial Transfer</strong> column with Yes or No before upload, or edit the saved
            choices in transfer paperwork afterward.
          </p>
          <p className={styles.help}>
            Saved CSVs and generated PDFs are under Saved inputs &amp; paperwork in Transfer Details.
          </p>
          <ErrorBox notice={mappingAlert} label="mapping" />
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h4 className={styles.cardTitle}>
              <span className={`${styles.iconBox} ${styles.iconViolet}`}><FileSpreadsheet size={16} /></span>
              Apex Output / Activities
            </h4>
            {preview && (
              <div className={styles.pills}>
                {apexFormat && <span className={styles.pill}>{apexFormat}</span>}
                <span className={`${styles.pill} ${styles.pillOk}`}>{preview.positions.length} positions parsed</span>
              </div>
            )}
          </div>
          <div
            className={[styles.dropZone, readOnly ? styles.dropZoneOff : "", dragOver ? styles.dropZoneOver : "", file ? styles.dropZoneDone : ""].filter(Boolean).join(" ")}
            onDragOver={(event) => { event.preventDefault(); if (!readOnly) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <input type="file" accept=".csv" aria-label="Upload Apex output CSV" className={styles.fileInput}
              disabled={readOnly || saving || syncing}
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) void uploadApex(picked);
                event.target.value = "";
              }} />
            {file ? (
              <>
                <CircleCheck size={22} className={styles.dropIconOk} />
                <p className={styles.dropFile}>{file.name}</p>
                <p className={styles.dropSub}>
                  {(file.size / 1024).toFixed(1)} KB{preview ? ` · ${preview.positions.length} positions` : ""}
                </p>
                <button type="button" className={styles.removeButton}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFile(null);
                    setPreview(null);
                    setEdits(new Map());
                    setOverridden(new Set());
                    setApexAlert(null);
                  }}>
                  <Trash2 size={10} />
                  Remove
                </button>
              </>
            ) : (
              <>
                <Upload size={22} className={styles.dropIcon} />
                <p className={styles.dropTitle}>Drop Apex CSV here</p>
                <p className={styles.dropSub}>ACAT Output or Activities export · .csv only</p>
              </>
            )}
          </div>
          <ErrorBox notice={apexAlert} label="apex" />
        </div>
      </div>

      <div className={styles.bar}>
        <div className={styles.barTitle}>
          <ArrowRightLeft size={14} />
          Reconciliation
        </div>
        <div className={styles.barRule} />
        <div className={styles.barStats}>
          <span><strong>{counts.total}</strong> positions</span>
          <span><strong className={styles.good}>{counts.matched}</strong> matched</span>
          <span>
            <strong className={counts.issues > 0 ? styles.bad : styles.good}>{counts.issues}</strong>{" "}
            {counts.issues === 1 ? "issue" : "issues"}
          </span>
        </div>
        <div className={styles.barRate}>
          <div className={styles.track}>
            <div className={`${styles.fill} ${rate === 100 ? styles.fillFull : rate > 50 ? styles.fillMid : styles.fillLow}`}
              style={{ width: `${rate}%` }} />
          </div>
          <span className={styles.rate}>{rate}%</span>
        </div>
      </div>

      {showSave && (
        <div className={styles.saveRow}>
          <button type="button" className={styles.saveButton} disabled={saving} onClick={save}>
            {saving ? <LoaderCircle size={14} className={styles.spin} /> : <Save size={14} />}
            {saving ? "Saving..." : "Save Recon Results"}
          </button>
        </div>
      )}
      <ErrorBox notice={saveAlert} label="save" />

      <div className={styles.gridCard}>
        <div className={gridOpen ? styles.gridHead : `${styles.gridHead} ${styles.gridHeadClosed}`}>
          <h4 className={styles.gridTitle}>
            <button type="button" className={styles.gridToggle} aria-expanded={gridOpen} aria-controls={gridBodyId}
              onClick={() => setGridOpen((open) => !open)}>
              <span className={styles.gridChevron} aria-hidden>{gridOpen ? "▾" : "▸"}</span>
              Position Details
            </button>
          </h4>
          <div className={styles.gridActions}>
            {counts.issues > 0 && (
              <div className={styles.discrepancy}>
                <TriangleAlert size={12} />
                {counts.issues} discrepanc{counts.issues === 1 ? "y" : "ies"} detected
              </div>
            )}
            <button type="button" className={styles.outlineButton} disabled={rows.length === 0}
              title="Download reconciliation as CSV" onClick={downloadGrid}>
              <Download size={12} />
              Download CSV
            </button>
          </div>
        </div>
        <ErrorBox notice={downloadAlert} label="download" />
        <div id={gridBodyId} hidden={!gridOpen}>
        <p className={styles.gridNote}>
          Transfer eligibility, Transferring?, and statement freshness come from asset mapping.
          Reported statement age and stale flags may reflect the original processing date.
        </p>
        <div className={styles.scroll} role="region" aria-label="Position details" tabIndex={0}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Asset / Symbol</th>
                <th scope="col">Transfer eligibility</th>
                <th scope="col">Transferring?</th>
                <th scope="col">Statement freshness</th>
                <th scope="col" className={styles.right}>Expected (DB)</th>
                <th scope="col" className={styles.right}>Actual (Apex)</th>
                <th scope="col" className={styles.right}>Variance</th>
                <th scope="col">Status</th>
                <th scope="col">Issue</th>
                <th scope="col">Notes</th>
                <th scope="col"><span className={styles.srOnly}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const hasIssue = rowHasIssue(row);
                const variance = reconVariance(row);
                const cash = isCashSymbol(row.symbol);
                const editing = editingId === row.id;
                const manual = overridden.has(row.id);
                const rowClass = row.status === "Unexpected" ? styles.rowUnexpected : hasIssue ? styles.rowIssue : styles.rowOk;
                const badgeClass = row.status === "Unexpected" ? styles.symbolBadgeUnexpected : hasIssue ? styles.symbolBadgeIssue : "";
                const onKey = (event: KeyboardEvent) => {
                  if (event.key === "Enter") saveRowEdit();
                  if (event.key === "Escape") { event.stopPropagation(); setEditingId(null); }
                };
                return (
                  <tr key={row.id} data-row-id={row.id} className={rowClass}>
                    <td>
                      <div className={styles.symbolCell}>
                        <div className={`${styles.symbolBadge} ${badgeClass}`}>{row.symbol.slice(0, 3)}</div>
                        <div>
                          <span className={`${styles.mono} ${styles.symbol}`}>{row.symbol}</span>
                          <p className={styles.desc}>{row.description}</p>
                          {row.cusip && <p className={`${styles.mono} ${styles.cusip}`}>{row.cusip}</p>}
                        </div>
                      </div>
                    </td>
                    <td className={styles.cell}>
                      <span className={styles.cellStrong}>
                        {row.mapping.mappingTransferStatus || (row.mapping.mappingSyncedAt ? "Not provided" : "—")}
                      </span>
                      {row.mapping.mappingTransferNotes && <p className={styles.cellNote}>{row.mapping.mappingTransferNotes}</p>}
                    </td>
                    <td className={styles.small}>
                      {row.mapping.mappingTransferring === true
                        ? "Yes"
                        : row.mapping.mappingTransferring === false
                          ? "No"
                          : row.mapping.mappingSyncedAt ? "Not set" : "—"}
                    </td>
                    <td><StatementFreshness mapping={row.mapping} /></td>
                    <td className={`${styles.right} ${styles.mono}`}>
                      {row.expectedQty === 0 ? "—" : cash ? formatReconCash(row.expectedQty) : row.expectedQty.toLocaleString("en-US")}
                    </td>
                    <td className={`${styles.right} ${styles.mono} ${hasIssue ? styles.qtyBad : ""}`}>
                      {editing ? (
                        <input type="number" step="any" aria-label="Actual quantity" className={`${styles.editInput} ${styles.editQty}`}
                          value={draft.actualQty} autoFocus
                          onChange={(event) => setDraft((d) => ({ ...d, actualQty: event.target.value }))} onKeyDown={onKey} />
                      ) : row.actualQty === 0 ? "—" : cash ? formatReconCash(row.actualQty) : row.actualQty.toLocaleString("en-US")}
                    </td>
                    <td className={styles.right}>
                      {row.actualQty === 0 && row.expectedQty === 0 ? (
                        <span className={`${styles.small} ${styles.muted}`}>N/A</span>
                      ) : row.actualQty === 0 || row.expectedQty === 0 ? (
                        <span className={`${styles.variance} ${styles.varianceWarn}`}><CircleQuestionMark size={11} />N/A</span>
                      ) : variance === 0 ? (
                        <span className={`${styles.variance} ${styles.varianceZero}`}><CircleCheck size={11} />0</span>
                      ) : (
                        <span className={`${styles.variance} ${styles.mono} ${variance > 0 ? styles.varianceUp : styles.varianceDown}`}>
                          {variance > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                          {cash ? formatReconCash(variance, true) : `${variance > 0 ? "+" : ""}${variance.toLocaleString("en-US")}`}
                        </span>
                      )}
                    </td>
                    <td>
                      {editing ? (
                        <select aria-label="Status" className={styles.editSelect} value={draft.status}
                          onChange={(event) => setDraft((d) => ({ ...d, status: event.target.value as ReconStatus }))}>
                          {RECON_EDIT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                      ) : (
                        <div className={styles.statusCell}>
                          <StatusBadge status={row.status} />
                          {manual && <span className={styles.manual} title="Manually set by ops">Manual</span>}
                        </div>
                      )}
                    </td>
                    <td className={styles.cell}>
                      {editing ? (
                        <input type="text" aria-label="Issue" className={styles.editInput} value={draft.issue}
                          placeholder="Issue (e.g. fractional shortfall)"
                          onChange={(event) => setDraft((d) => ({ ...d, issue: event.target.value }))} onKeyDown={onKey} />
                      ) : row.issue ? (
                        <span className={hasIssue ? `${styles.issueText} ${styles.issueTextBad}` : styles.issueText}>
                          <TriangleAlert size={11} />
                          {row.issue}
                        </span>
                      ) : <span className={styles.dash}>—</span>}
                    </td>
                    <td className={styles.cell}>
                      {editing ? (
                        <input type="text" aria-label="Notes" className={styles.editInput} value={draft.notes}
                          placeholder="Note (e.g. verified against PDF)"
                          onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))} onKeyDown={onKey} />
                      ) : row.notes ? (
                        <span className={styles.issueText}>{row.notes}</span>
                      ) : <span className={styles.dash}>—</span>}
                    </td>
                    <td className={styles.right}>
                      {!readOnly && isEditableRow(row) && (editing ? (
                        <div className={styles.rowActions}>
                          <button type="button" className={`${styles.rowButton} ${styles.rowButtonOk}`} title="Save override"
                            aria-label="Save override" onClick={saveRowEdit}><Check size={14} /></button>
                          <button type="button" className={styles.rowButton} title="Cancel" aria-label="Cancel override"
                            onClick={() => setEditingId(null)}><X size={14} /></button>
                        </div>
                      ) : (
                        <button type="button" className={`${styles.rowButton} ${styles.pencil}`}
                          title="Manually override this row" aria-label={`Manually override ${row.symbol}`}
                          onClick={() => startRowEdit(row)}><Pencil size={12} /></button>
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
    </section>
  );
}
