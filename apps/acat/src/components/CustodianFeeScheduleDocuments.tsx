"use client";

import { useRef, useState, type ChangeEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Download, Loader2, Paperclip, RefreshCw } from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { demoMode } from "@/lib/demo/mode";

interface FeeScheduleDocument {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  createdBy: string;
}

interface DocumentsResponse {
  documents: FeeScheduleDocument[];
  nextCursor: string | null;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileError(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const expectedType = CONTENT_TYPES[extension];
  if (!expectedType || (file.type && file.type !== "application/octet-stream" && file.type !== expectedType)) {
    return "Choose a PDF, PNG, or JPEG file.";
  }
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_FILE_BYTES) return "Choose a file no larger than 10 MB.";
  return null;
}

export default function CustodianFeeScheduleDocuments({
  custodianId,
  canUpload: canUploadForRole,
  onUploaded,
}: {
  custodianId: string;
  canUpload: boolean;
  onUploaded?: () => void;
}) {
  // Uploads are off in the demo; the seeded schedules can still be opened.
  const uploadsOff = demoMode();
  const canUpload = canUploadForRole && !uploadsOff;
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const base = `/api/custodians/${encodeURIComponent(custodianId)}/fee-schedules`;
  const { data, error, isLoading, mutate } = useSWR<DocumentsResponse>(
    cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base,
  );
  const { mutate: mutateCache } = useSWRConfig();

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSuccess(null);
    const validationError = fileError(file);
    setUploadError(validationError);
    setSelectedFile(validationError ? null : file);
  }

  function cancelSelection() {
    setSelectedFile(null);
    setUploadError(null);
    setSuccess(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function upload() {
    if (!canUpload || !selectedFile || uploading) return;
    setUploading(true);
    setUploadError(null);
    setSuccess(null);
    const body = new FormData();
    body.append("file", selectedFile);
    try {
      const response = await fetch(base, { method: "POST", body });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof result?.error === "string"
            ? result.error
            : `Upload failed (HTTP ${response.status}).`,
        );
      }
      setSelectedFile(null);
      setSuccess(result?.duplicate ? "This fee schedule is already attached." : "Fee schedule attached.");
      setCursor(null);
      onUploaded?.();
      try {
        // Fetch the latest page explicitly, even when an older page was open.
        await mutateCache(base, jsonFetcher<DocumentsResponse>(base), { revalidate: false });
      } catch (refreshError) {
        const message = refreshError instanceof Error ? refreshError.message : "Please refresh the list.";
        setUploadError(`The attachment was saved, but the list could not be refreshed. ${message}`);
      }
    } catch (requestError) {
      setUploadError(requestError instanceof Error ? requestError.message : "Could not upload the fee schedule.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section aria-label="Fee schedule documents" className="border-t border-card-border px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Paperclip size={15} className="text-accent" />Original fee schedules
        </h3>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Refresh fee schedules"
            onClick={() => void mutate()}
            disabled={uploading}
            className="rounded p-1 text-muted hover:text-accent disabled:opacity-50"
          >
            <RefreshCw size={14} />
          </button>
          {canUpload && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                aria-label="Choose fee schedule"
                onChange={selectFile}
                disabled={uploading}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-card-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                <Paperclip size={13} />Attach fee schedule
              </button>
            </>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Keep the original schedule here for reference.</p>
      {canUploadForRole && uploadsOff && (
        <p className="mt-1 text-xs text-muted">Uploads are off in this demo. The schedules on file can still be opened.</p>
      )}
      {canUpload && <p className="mt-1 text-xs text-muted">PDF, PNG, or JPEG · up to 10 MB</p>}

      {canUpload && selectedFile && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-card-border bg-[var(--bg-hover)] p-3">
          <div className="min-w-0">
            <p className="break-all text-sm font-medium text-foreground">{selectedFile.name}</p>
            <p className="mt-1 text-xs text-muted">{fileSize(selectedFile.size)} · Ready to upload</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void upload()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--invert-text)] disabled:opacity-50"
            >
              {uploading && <Loader2 size={13} className="animate-spin" />}
              {uploading ? "Uploading…" : "Upload"}
            </button>
            <button
              type="button"
              onClick={cancelSelection}
              disabled={uploading}
              className="rounded-lg border border-card-border px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {uploadError && <p role="alert" className="mt-3 text-sm text-[color:var(--danger)]">{uploadError}</p>}
      {success && <p role="status" className="mt-3 text-sm text-[color:var(--success)]">{success}</p>}
      {isLoading && <p className="mt-3 text-sm text-muted">Loading fee schedules…</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-[color:var(--danger)]">
          Could not load fee schedules. Try refreshing.
        </p>
      )}
      {!isLoading && !error && !data?.documents?.length && (
        <p className="mt-3 text-sm text-muted">No fee schedules attached yet.</p>
      )}
      <ul className="mt-3 divide-y divide-card-border">
        {(data?.documents ?? []).map((document) => (
          <li key={document.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="break-all text-sm font-medium text-foreground">{document.filename}</p>
              <p className="mt-1 text-xs text-muted">
                {new Date(document.createdAt).toLocaleString("en-US")} · {document.createdBy} · {fileSize(document.byteSize)}
              </p>
            </div>
            <a
              href={`${base}/${encodeURIComponent(document.id)}`}
              download
              aria-label={`Download ${document.filename}`}
              className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
            >
              <Download size={13} />Download
            </a>
          </li>
        ))}
      </ul>
      {(cursor || data?.nextCursor) && (
        <div className="mt-2 flex gap-4 text-xs font-semibold text-accent">
          {cursor && <button type="button" disabled={uploading} onClick={() => setCursor(null)}>Latest documents</button>}
          {data?.nextCursor && <button type="button" disabled={uploading} onClick={() => setCursor(data.nextCursor)}>Older documents</button>}
        </div>
      )}
    </section>
  );
}
