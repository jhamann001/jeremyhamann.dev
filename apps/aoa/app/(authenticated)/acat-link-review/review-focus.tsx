"use client";

import { useEffect } from "react";

/** Next server-action navigation can discard URL fragments. The server page
 * only supplies a decision present in its authorized, bounded result set. */
export default function ReviewFocus({ decisionId, revision }: { decisionId: string; revision: string }) {
  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(decisionId)) return;
    const card = document.getElementById(`decision-${decisionId}`);
    if (!card) return;
    card.scrollIntoView({ block: "start", behavior: "instant" });
    card.focus({ preventScroll: true });
  }, [decisionId, revision]);
  return null;
}
