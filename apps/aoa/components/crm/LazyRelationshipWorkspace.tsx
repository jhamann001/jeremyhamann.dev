"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui";
import {
  RelationshipWorkspaceView,
  type RelationshipWorkspaceData,
} from "./RelationshipGraph";
import styles from "./CrmPreview.module.css";

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: RelationshipWorkspaceData }
  | { status: "failed" };

export function LazyRelationshipWorkspace({
  rootIdentityId,
  compact = false,
}: {
  rootIdentityId: string;
  compact?: boolean;
}) {
  const boundaryRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    const boundary = boundaryRef.current;
    if (!boundary || shouldLoad) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/crm/relationships?root=${encodeURIComponent(rootIdentityId)}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("relationship_workspace_unavailable");
        return response.json() as Promise<{ data: RelationshipWorkspaceData }>;
      })
      .then(({ data }) => setState({ status: "ready", data }))
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name !== "AbortError") {
          setState({ status: "failed" });
        }
      });
    return () => controller.abort();
  }, [rootIdentityId, shouldLoad]);

  return (
    <div ref={boundaryRef}>
      {state.status === "ready" ? (
        <RelationshipWorkspaceView data={state.data} compact={compact} />
      ) : state.status === "failed" ? (
        <Card>
          <CardHeader><h2>Relationships</h2></CardHeader>
          <CardBody><p className={styles.muted}>The relationship map could not be loaded. Try opening this tab again.</p></CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader><h2>Relationships</h2></CardHeader>
          <CardBody><p className={styles.muted}>{shouldLoad ? "Loading confirmed relationships…" : "Open this tab to load confirmed relationships."}</p></CardBody>
        </Card>
      )}
    </div>
  );
}
