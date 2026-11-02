"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import { loadAssetMapDriveSaveReviewer } from "@/app/(authenticated)/asset-mapping/actions";
import type { AssetMapReviewState } from "@/lib/data/asset-map";
import { requestAllClientsPdf, requestHouseholdPdf, requestSaveToDrive, requestScan } from "./documents-client";
import { documentsReducer, effectiveReview, initialDocumentsState, visibleAlert, visibleNotice } from "./documents-model";
import { performDriveSave, performPdf, performScan, type DocumentsDeps } from "./run-documents";

export type DocumentsAccess = { enabled: boolean; canOperate: boolean };

function browserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function useAssetMapDocuments(householdId: string | null, liveReview: AssetMapReviewState | null, access: DocumentsAccess) {
  const [state, dispatch] = useReducer(documentsReducer, undefined, initialDocumentsState);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const deps = useMemo<DocumentsDeps>(() => ({
    client: { householdPdf: requestHouseholdPdf, allClientsPdf: requestAllClientsPdf, saveToDrive: requestSaveToDrive, scan: requestScan },
    dispatch,
    schedule: (fn, ms) => {
      const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
      timers.current.add(t);
      return () => { clearTimeout(t); timers.current.delete(t); };
    },
    scanClear: { cancel: null },
    download: browserDownload,
  }), []);

  useEffect(() => { dispatch({ type: "reset" }); }, [householdId]);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  const reviewedAt = liveReview?.reviewedAt ?? null;
  useEffect(() => {
    if (!access.enabled || !access.canOperate || householdId == null || reviewedAt == null) return;
    let cancelled = false;
    loadAssetMapDriveSaveReviewer(householdId).then(
      (audit) => { if (!cancelled) dispatch({ type: "auditLoaded", audit }); },
      () => { if (!cancelled) dispatch({ type: "auditLoaded", audit: null }); },
    );
    return () => { cancelled = true; };
  }, [access.enabled, access.canOperate, householdId, reviewedAt]);

  return {
    state,
    alert: visibleAlert(state, householdId),
    notice: visibleNotice(state, householdId),
    review: effectiveReview(householdId, liveReview, state.saved, state.audit),
    downloadPdf: (id: string) => void performPdf("pdf", id, deps),
    downloadAllPdf: () => void performPdf("allPdf", null, deps),
    saveToDrive: (kind: "markCompleted" | "saveToDrive", id: string) => void performDriveSave(kind, id, deps),
    runScan: (onFinished: () => void) => void performScan(onFinished, deps),
    dismissAlert: () => dispatch({ type: "dismissAlert" }),
    dismissScanMessage: () => dispatch({ type: "clearScanMessage" }),
  };
}
