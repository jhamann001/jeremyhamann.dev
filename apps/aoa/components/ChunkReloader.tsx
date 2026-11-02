"use client";

import { useEffect } from "react";

// Self-heal for post-deploy chunk skew. Static chunks are baked into each
// Cloud Run revision under build-fingerprinted names, so a tab loaded before
// a deploy asks the NEW revision for OLD chunk files → 404 → ChunkLoadError
// on the next soft navigation (hit live on go-live day: the deals modal
// chunk). One transparent reload re-syncs the tab with the current build.
// A session flag + 30s window prevents reload loops if the failure persists.
const KEY = "aoa-chunk-reload-at";

function isChunkError(msg: unknown): boolean {
  return (
    typeof msg === "string" &&
    (msg.includes("ChunkLoadError") || msg.includes("Loading chunk"))
  );
}

function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return; // already tried recently — don't loop
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable — still better to reload than stay broken
  }
  window.location.reload();
}

export function ChunkReloader() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isChunkError(e.message) || isChunkError(e.error?.message)) {
        reloadOnce();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { name?: string; message?: string } | undefined;
      if (r?.name === "ChunkLoadError" || isChunkError(r?.message)) {
        reloadOnce();
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
