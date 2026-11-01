"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, CircleAlert, LoaderCircle, Upload } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@/types/domain";
import { cn } from "@/lib/utils";
import { createUploadIntent, finalizeUpload } from "@/server/attachments.actions";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { SheetTitle } from "@/components/ui/sheet";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
} from "@/components/shell/responsive-sheet";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_LABEL,
  formatBytes,
  isAllowedMime,
} from "@/components/ticket/attachments/attachment-meta";

/**
 * Upload affordance for the attachments panel (the build record S4; docs/MOBILE_FIRST.md
 * R1–R5, R10).
 *
 * A button that opens a `ResponsiveSheet` — a bottom sheet on phones, a right sheet at md+ — with two
 * ways in: the file picker, and (phones only) the camera, which is `accept="image/*" capture`, the
 * one thing a service rep standing at a scanner actually needs.
 *
 * Three server round trips, in this order, and the middle one is not ours:
 *   1. `createUploadIntent` — RBAC, allowlist, cap; returns a short-lived SIGNED PUT URL.
 *   2. the browser PUTs the bytes AT THAT URL — straight to the bucket in a deployed environment, or
 *      to the app's own local receiver when `ATTACHMENTS_BUCKET` is unset. The content type and the
 *      byte range are part of the signature, so this step cannot store something other than what the
 *      intent declared. XHR rather than fetch, because only XHR reports upload progress.
 *   3. `finalizeUpload` — verifies the object and re-verifies the sha256 the browser computed
 *      wherever the backend can prove it (the local backend re-reads and hashes the bytes; GCS
 *      publishes no sha256, so there the digest column stays NULL and the browser's claim is recorded
 *      in the audit row only), flips PENDING → READY and writes the audit row. Only then is there an
 *      attachment.
 *
 * A failure between 1 and 3 leaves a PENDING row that no surface shows and nothing counts. That is
 * the deliberate shape: an abandoned intent is not an attachment.
 */
export type AttachmentUploadProps = {
  ticketId: string;
  /** Rendered full-width inside the panel; the caller only renders this when the viewer may upload. */
  className?: string;
};

type Phase = "idle" | "preparing" | "hashing" | "uploading" | "finalizing";

/** Shown after an abort, and after a cancel honoured at a checkpoint — the two are the same event here. */
const CANCELLED_NOTE = "The upload was cancelled. Nothing was attached.";

/** What Cancel will actually do, per phase — visible text, never a tooltip. */
const CANCEL_HINT: Record<Exclude<Phase, "idle">, string> = {
  preparing: "Cancel stops this upload as soon as the request comes back.",
  hashing: "Cancel stops this upload as soon as the checksum finishes.",
  uploading: "Cancel stops the transfer straight away.",
  finalizing: "The file is being recorded and can no longer be cancelled.",
};

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  preparing: "Preparing…",
  hashing: "Checksumming…",
  uploading: "Uploading…",
  finalizing: "Finishing…",
};

/** Lower-case hex SHA-256 of the file, or null where SubtleCrypto is unavailable (insecure origin). */
async function sha256Hex(file: File): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * The origin an upload URL points at, or `null` when it resolves to this same origin — which is
 * what the filesystem backend returns (`localUploadPath`). Used only to word a failure correctly.
 */
function crossOriginUploadTarget(url: string): string | null {
  try {
    const target = new URL(url, window.location.href);
    return target.origin === window.location.origin ? null : target.origin;
  } catch {
    return null;
  }
}

/**
 * PUT with progress. Resolves on 2xx; rejects with a readable message otherwise.
 *
 * `xhr.onerror` fires with `status === 0` for EVERY pre-response failure, so the naive message
 * ("could not reach storage") sends whoever debugs it at bucket IAM and CORS even when the request
 * never left the tab. The two causes that look identical from here are worth separating:
 *
 *   - this app's own `Content-Security-Policy` refusing the cross-origin XHR (`connect-src`), which
 *     is a header THIS REPO owns (`src/lib/security-headers.ts`); and
 *   - a genuine network/CORS failure between the browser and the bucket.
 *
 * The browser tells us which: a CSP refusal also fires `securitypolicyviolation` on the document.
 * Listening for it across the request turns an hour in the wrong console into one sentence.
 *
 * `onStart` receives the live `XMLHttpRequest` once the bytes are on the wire, which is what makes the
 * transfer abortable. A rep on a phone connection who picked the wrong 25 MiB file used
 * to have no way out of this sheet but to leave the page.
 */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void,
  onStart?: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const crossOrigin = crossOriginUploadTarget(url);
    let blockedByPolicy = false;

    const onViolation = (event: SecurityPolicyViolationEvent) => {
      const directive = event.effectiveDirective || event.violatedDirective || "";
      if (!directive.startsWith("connect-src") && !directive.startsWith("default-src")) return;
      // Don't claim OUR request was blocked because some other connect-src violation fired while it
      // was in flight. `blockedURI` is the request URL, or just its origin when the UA strips it.
      if (crossOrigin && event.blockedURI && !event.blockedURI.startsWith(crossOrigin)) return;
      blockedByPolicy = true;
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("securitypolicyviolation", onViolation);
      finish();
    };
    const fail = (message: string) => settle(() => reject(new Error(message)));

    const unreachable = (): string => {
      if (blockedByPolicy) {
        return crossOrigin
          ? `This desk's security policy blocked the upload before it was sent — uploads to ${crossOrigin} are not allowed by its Content-Security-Policy. Nothing is wrong with your file; report it.`
          : "This desk's security policy blocked the upload before it was sent. Nothing is wrong with your file; report it.";
      }
      return crossOrigin
        ? `The upload could not reach ${crossOrigin}. Check the connection and try again.`
        : "The upload could not reach storage.";
    };

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) settle(resolve);
      else if (xhr.status === 403) fail("The upload link expired. Try again.");
      else if (xhr.status === 413) fail(`The file is larger than ${ATTACHMENT_MAX_LABEL}.`);
      else fail(`The upload was refused (${xhr.status}).`);
    };
    xhr.onerror = () => fail(unreachable());
    xhr.onabort = () => fail("The upload was cancelled.");

    try {
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", contentType);
      // Signed into the upload URL alongside the content type: the storage backend, not the browser,
      // is what enforces the cap.
      xhr.setRequestHeader("x-goog-content-length-range", `0,${ATTACHMENT_MAX_BYTES}`);
      xhr.send(file);
      // After send(): abort() before it is a no-op, which would leave the request running.
      onStart?.(xhr);
    } catch {
      // A policy that blocks the request outright can make `send()` throw rather than fire `onerror`.
      fail(unreachable());
    }
  });
}

/** Turns any failed ActionResult into one sentence a service rep can act on. */
function actionErrorMessage(result: Extract<ActionResult<unknown>, { ok: false }>): string {
  if (result.code === "VALIDATION" && result.fieldErrors) {
    const first = Object.values(result.fieldErrors).flat()[0];
    if (first) return first;
  }
  switch (result.code) {
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again.";
    case "FORBIDDEN":
      return "You cannot attach files to this ticket.";
    case "NOT_FOUND":
      return "This ticket no longer exists.";
    case "CONFLICT":
      return "This file was already attached.";
    case "INTERNAL":
      return "The file could not be attached. Nothing was saved.";
    default:
      return result.message;
  }
}

export function AttachmentUpload({ ticketId, className }: AttachmentUploadProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Display mirror of `cancelRequested` — a ref alone would not re-render the progress line. */
  const [cancelling, setCancelling] = useState(false);
  const pickerId = useId();
  const cameraId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  /** The in-flight PUT, while there is one — the handle Cancel aborts. */
  const uploadXhr = useRef<XMLHttpRequest | null>(null);
  /** Set by Cancel; honoured at the next checkpoint for the steps that have no abort of their own. */
  const cancelRequested = useRef(false);

  const busy = phase !== "idle";
  /**
   * `finalizeUpload` is the step that flips PENDING → READY and writes the audit row. Interrupting the
   * client while the server is committing that would not un-write it, so this one step is honestly
   * uncancellable and says so rather than offering a button that lies.
   */
  const cancellable = busy && phase !== "finalizing";

  const reset = useCallback(() => {
    setFile(null);
    setPhase("idle");
    setPercent(0);
    setError(null);
    uploadXhr.current = null;
    cancelRequested.current = false;
    setCancelling(false);
    if (fileInput.current) fileInput.current.value = "";
    if (cameraInput.current) cameraInput.current.value = "";
  }, []);

  /**
   * Cancel while an upload is in flight. `uploading` aborts the transfer outright; `preparing` and
   * `hashing` have no abort, so the flag is honoured at the next checkpoint in `upload()` — the
   * intent that was already created is simply never finalized, and an unfinalized intent is not an
   * attachment (see the header comment).
   */
  const cancelUpload = useCallback(() => {
    cancelRequested.current = true;
    setCancelling(true);
    uploadXhr.current?.abort();
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      // An upload in flight owns the sheet: an overlay brush must not throw away a 25 MiB transfer.
      // The X is hidden while busy (`showCloseButton`) so no visible control is silently swallowed
      // here, and Cancel — which aborts for real — is the way out.
      if (busy && !next) return;
      setOpen(next);
      if (!next) reset();
    },
    [busy, reset],
  );

  const choose = useCallback((chosen: File | null) => {
    setError(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    if (chosen.size > ATTACHMENT_MAX_BYTES) {
      setFile(null);
      setError(`${chosen.name} is ${formatBytes(chosen.size)} — the limit is ${ATTACHMENT_MAX_LABEL}.`);
      return;
    }
    if (chosen.size === 0) {
      setFile(null);
      setError(`${chosen.name} is empty.`);
      return;
    }
    if (!isAllowedMime(chosen.type)) {
      setFile(null);
      setError(
        chosen.type === ""
          ? "This browser could not identify the file type. Rename it with its extension and try again."
          : `${chosen.type} files cannot be attached. PDF, images, CSV, text, Excel and Word only.`,
      );
      return;
    }
    setFile(chosen);
  }, []);

  const upload = useCallback(async () => {
    if (!file || busy) return;
    setError(null);
    setPercent(0);
    cancelRequested.current = false;
    setCancelling(false);
    uploadXhr.current = null;

    /** True when Cancel was pressed during a step that could not be aborted mid-flight. */
    const abandon = (): boolean => {
      if (!cancelRequested.current) return false;
      uploadXhr.current = null;
      cancelRequested.current = false;
      setCancelling(false);
      setPhase("idle");
      setError(CANCELLED_NOTE);
      return true;
    };

    try {
      setPhase("preparing");
      const intent = await createUploadIntent({
        ticketId,
        filename: file.name,
        mime: file.type,
        size: file.size,
      });
      if (!intent.ok) {
        setPhase("idle");
        setError(actionErrorMessage(intent));
        return;
      }
      // The intent is never finalized, so nothing was attached (see the header comment).
      if (abandon()) return;

      setPhase("hashing");
      const digest = await sha256Hex(file);
      if (abandon()) return;

      setPhase("uploading");
      await putWithProgress(intent.data.uploadUrl, file, file.type, setPercent, (xhr) => {
        uploadXhr.current = xhr;
        // Cancel pressed between the checkpoint above and send(): abort immediately.
        if (cancelRequested.current) xhr.abort();
      });
      uploadXhr.current = null;

      // Past this line the server is committing the record; cancelling is no longer offered.
      setPhase("finalizing");
      const finalized = await finalizeUpload({
        attachmentId: intent.data.attachmentId,
        ...(digest ? { sha256: digest } : {}),
      });
      if (!finalized.ok) {
        setPhase("idle");
        setError(actionErrorMessage(finalized));
        return;
      }

      toast.success(`${finalized.data.filename} attached`);
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      // An abort rejects here with "The upload was cancelled." from `xhr.onabort`.
      uploadXhr.current = null;
      const cancelled = cancelRequested.current;
      cancelRequested.current = false;
      setCancelling(false);
      setPhase("idle");
      setError(cancelled ? CANCELLED_NOTE : e instanceof Error ? e.message : "The file could not be attached.");
    }
  }, [busy, file, reset, router, ticketId]);

  return (
    <div className={cn("flex", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full sm:w-auto"
        onClick={() => setOpen(true)}
        data-testid="attachment-upload-open"
      >
        <Upload aria-hidden className="size-4" />
        Attach a file
      </Button>

      {/*
        `showCloseButton={!busy}`: while an upload is in flight `onOpenChange` refuses to close, so a
        visible X would be a 44 px control that does nothing (fix round 2). It is withdrawn instead,
        and the footer's Cancel — which really does abort — becomes the single way out.
      */}
      <ResponsiveSheet open={open} onOpenChange={onOpenChange} height="auto" size="md" showCloseButton={!busy}>
        <ResponsiveSheetHeader>
          <SheetTitle>Attach a file</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Internal only — attachments are never sent to the client and never appear in the client portal. PDF,
            images, CSV, text, Excel or Word, up to {ATTACHMENT_MAX_LABEL}.
          </p>
        </ResponsiveSheetHeader>

        <ResponsiveSheetBody className="space-y-3">
          <input
            ref={fileInput}
            id={pickerId}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 w-full justify-start"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Upload aria-hidden className="size-4" />
            Choose a file
          </Button>

          {/* Phones only: the camera path a rep uses at the scanner or with a paper form in hand. */}
          <input
            ref={cameraInput}
            id={cameraId}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={busy}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 w-full justify-start md:hidden"
            disabled={busy}
            onClick={() => cameraInput.current?.click()}
          >
            <Camera aria-hidden className="size-4" />
            Take a photo
          </Button>

          {file ? (
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="truncate text-sm font-medium" title={file.name}>
                {file.name}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{formatBytes(file.size)}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No file chosen yet.</p>
          )}

          {busy ? (
            <div aria-live="polite" className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                <span>{PHASE_LABEL[phase]}</span>
                {phase === "uploading" ? <span className="ml-auto tabular-nums">{percent}%</span> : null}
              </div>
              <Progress value={phase === "uploading" ? percent : phase === "finalizing" ? 100 : 5} />
              {/* What the controls will do, in words: the sheet cannot be dismissed from here. */}
              <p className="text-xs text-muted-foreground">
                {cancelling && cancellable ? "Cancelling…" : CANCEL_HINT[phase]}
              </p>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          {/*
            One control, two honest jobs: idle it closes the sheet, in flight it ABORTS the transfer
            (fix round 2 — it used to be `disabled={busy}`, which left no way out of a 25 MiB upload on
            a phone connection). It is disabled only while the server is committing the record.
          */}
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={(busy && !cancellable) || cancelling}
            onClick={() => (busy ? cancelUpload() : onOpenChange(false))}
          >
            {busy ? "Cancel upload" : "Cancel"}
          </Button>
          <Button type="button" className="ml-auto min-h-11" disabled={!file || busy} onClick={() => void upload()}>
            {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Upload aria-hidden className="size-4" />}
            Attach
          </Button>
        </ResponsiveSheetFooter>
      </ResponsiveSheet>
    </div>
  );
}
