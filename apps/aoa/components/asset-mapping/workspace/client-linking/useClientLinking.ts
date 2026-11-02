"use client";

import { useEffect, useReducer, useState, type Dispatch } from "react";
import {
  applyClientLink,
  loadClientLinkBatch,
  loadClientLinkConfig,
  loadClientLinkQueue,
  loadRunClientLink,
  previewClientLink,
  previewClientLinkRevert,
  retryClientLinkLookup,
  searchClientDirectory,
  type ClientLinkResult,
} from "@/app/(authenticated)/asset-mapping/actions";
import {
  MIN_DIRECTORY_QUERY,
  type ClientLinkDraft,
  type ClientLinkQueueItem,
  type ClientLinkReviewState,
  type RunClientLink,
} from "@/lib/data/asset-map-client-link-contract";
import {
  CLIENT_LINK_COPY,
  QUEUE_PAGE_SIZE,
  REVIEW_STATES,
  buildBackfillDraft,
  buildLinkDraft,
  clientLinkReducer,
  draftReducer,
  failureView,
  initialClientLinkState,
  initialDraft,
  toggleFolder,
  type ClientLinkAction,
  type DraftAction,
  type FailureView,
  type FolderSelection,
  type LinkDraftState,
  type QueueFilterTotals,
} from "./client-link-model";
import type { DirectorySearchState } from "./ClientLinkReview";
import type { WorkspaceSection } from "./WorkspaceSectionNav";

const SEARCH_DEBOUNCE_MS = 250;
const TRANSPORT_FAILURE = failureView({ reason: "unavailable", message: null });
const EMPTY_SEARCH: DirectorySearchState = { query: "", result: null, searching: false, failure: null };

type Failed = Extract<ClientLinkResult<unknown>, { ok: false }>;

function routeFailure(dispatch: Dispatch<ClientLinkAction>, res: Failed): FailureView {
  if (res.reason === "writes_disabled") dispatch({ type: "writesDisabled" });
  if (res.reason === "disabled") dispatch({ type: "disabled" });
  return failureView(res);
}

export function useClientLinking({ canLink, selectedId, section }: { canLink: boolean; selectedId: string | null; section: WorkspaceSection }) {
  const [state, dispatch] = useReducer(clientLinkReducer, undefined, initialClientLinkState);
  const [reviewState, setReviewState] = useState<ClientLinkReviewState | null>(null);
  const [query, setQuery] = useState("");
  const [queueToken, setQueueToken] = useState(0);
  const [runToken, setRunToken] = useState(0);
  const [selection, setSelection] = useState<FolderSelection>(() => new Map());
  const [reviewRun, setReviewRun] = useState<RunClientLink | null>(null);
  const [draft, setDraft] = useState<LinkDraftState | null>(null);
  const [directory, setDirectory] = useState<DirectorySearchState>(EMPTY_SEARCH);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [filterTotals, setFilterTotals] = useState<QueueFilterTotals>({});

  const enabled = canLink && state.config?.enabled === true;
  const canReview = enabled && state.config?.writesEnabled === true;

  useEffect(() => {
    if (!canLink) return;
    let cancelled = false;
    loadClientLinkConfig().then(
      (res) => {
        if (!cancelled) dispatch({ type: "configLoaded", config: res.ok ? res.data : null });
      },
      () => {
        if (!cancelled) dispatch({ type: "configLoaded", config: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canLink]);

  useEffect(() => {
    if (!enabled || section !== "linking") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const request = Symbol("client-link-queue");
      dispatch({ type: "queueLoading", request });
      setSelection(new Map());
      loadClientLinkQueue({ q: query.trim(), reviewState, cursor: null, limit: QUEUE_PAGE_SIZE }).then(
        (res) => {
          if (cancelled) return;
          if (res.ok) dispatch({ type: "queueLoaded", request, page: res.data, append: false });
          else dispatch({ type: "queueFailed", request, failure: routeFailure(dispatch, res) });
        },
        () => {
          if (!cancelled) dispatch({ type: "queueFailed", request, failure: TRANSPORT_FAILURE });
        },
      );
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, section, query, reviewState, queueToken]);

  useEffect(() => {
    if (!enabled || section !== "linking") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setFilterTotals({});
      for (const state of REVIEW_STATES) {
        loadClientLinkQueue({ q: query.trim(), reviewState: state, cursor: null, limit: 1 }).then(
          (res) => {
            if (!cancelled && res.ok) setFilterTotals((t) => ({ ...t, [state]: res.data.total }));
          },
          () => {},
        );
      }
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, section, query, queueToken]);

  useEffect(() => {
    if (!enabled || selectedId == null) return;
    let cancelled = false;
    dispatch({ type: "runLoading" });
    loadRunClientLink(selectedId).then(
      (res) => {
        if (cancelled) return;
        if (res.ok) dispatch({ type: "runLoaded", run: res.data });
        else dispatch({ type: "runFailed", failure: routeFailure(dispatch, res) });
      },
      () => {
        if (!cancelled) dispatch({ type: "runFailed", failure: TRANSPORT_FAILURE });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, selectedId, runToken]);

  useEffect(() => {
    if (!state.reloadRun && !state.reloadQueue) return;
    dispatch({ type: "reloadsHandled" });
    if (state.reloadRun) setRunToken((t) => t + 1);
    if (state.reloadQueue) setQueueToken((t) => t + 1);
  }, [state.reloadRun, state.reloadQueue]);

  useEffect(() => {
    const q = directory.query.trim();
    if (!reviewRun || !canReview || q.length < MIN_DIRECTORY_QUERY) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setDirectory((d) => ({ ...d, searching: true, failure: null }));
      searchClientDirectory(q).then(
        (res) => {
          if (cancelled) return;
          setDirectory((d) => (res.ok
            ? { ...d, result: res.data, searching: false }
            : { ...d, result: null, searching: false, failure: routeFailure(dispatch, res) }));
        },
        () => {
          if (!cancelled) setDirectory((d) => ({ ...d, searching: false, failure: TRANSPORT_FAILURE }));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [directory.query, reviewRun, canReview]);

  useEffect(() => {
    if (!state.preview) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.preview]);

  const closeReview = () => {
    setReviewRun(null);
    setDraft(null);
    setDirectory(EMPTY_SEARCH);
  };

  const startReview = (run: RunClientLink) => {
    setReviewRun(run);
    setDraft(initialDraft(run));
    setDirectory(EMPTY_SEARCH);
  };

  const sendPreview = (linkDraft: ClientLinkDraft, onReady?: () => void) => {
    setBusy(true);
    previewClientLink(linkDraft).then(
      (res) => {
        setBusy(false);
        if (res.ok) {
          dispatch({ type: "previewReady", preview: res.data });
          onReady?.();
        } else {
          dispatch({ type: "failed", failure: routeFailure(dispatch, res) });
        }
      },
      () => {
        setBusy(false);
        dispatch({ type: "failed", failure: TRANSPORT_FAILURE });
      },
    );
  };

  return {
    state,
    enabled,
    canReview,
    cardRun: state.run?.run_id === selectedId ? state.run : null,
    reviewRun,
    draft,
    directory,
    busy,
    now,
    reviewState,
    query,
    selection,
    filterTotals,
    setReviewState,
    setQuery,
    retryQueue: () => setQueueToken((t) => t + 1),
    retryRun: () => setRunToken((t) => t + 1),
    loadMore: () => {
      const cursor = state.page.next_cursor;
      if (!cursor || state.queueStatus === "loading") return;
      const request = Symbol("client-link-queue");
      dispatch({ type: "queueLoading", request });
      loadClientLinkQueue({ q: query.trim(), reviewState, cursor, limit: QUEUE_PAGE_SIZE }).then(
        (res) => {
          if (res.ok) dispatch({ type: "queueLoaded", request, page: res.data, append: true });
          else dispatch({ type: "queueFailed", request, failure: routeFailure(dispatch, res) });
        },
        () => dispatch({ type: "queueFailed", request, failure: TRANSPORT_FAILURE }),
      );
    },
    toggleFolder: (item: ClientLinkQueueItem) => setSelection((s) => toggleFolder(s, item)),
    previewBackfill: () => {
      if (selection.size > 0) sendPreview(buildBackfillDraft(selection));
    },
    openReview: (runId: string) => {
      if (state.run?.run_id === runId) {
        startReview(state.run);
        return;
      }
      setBusy(true);
      loadRunClientLink(runId).then(
        (res) => {
          setBusy(false);
          if (res.ok) startReview(res.data);
          else dispatch({ type: "failed", failure: routeFailure(dispatch, res) });
        },
        () => {
          setBusy(false);
          dispatch({ type: "failed", failure: TRANSPORT_FAILURE });
        },
      );
    },
    closeReview,
    setDirectoryQuery: (q: string) => setDirectory({ ...EMPTY_SEARCH, query: q }),
    onDraft: (action: DraftAction) => setDraft((d) => (d ? draftReducer(d, action) : d)),
    previewDraft: () => {
      if (reviewRun && draft) sendPreview(buildLinkDraft(reviewRun, draft), closeReview);
    },
    apply: () => {
      const preview = state.preview;
      if (!preview || state.applying) return;
      dispatch({ type: "applyStarted" });
      applyClientLink(preview.preview_id, preview.payload_hash, true).then(
        (res) => {
          if (res.ok) {
            dispatch({ type: "applyConfirmed", result: res.data });
            setSelection(new Map());
          } else if (res.reason === "unavailable") {
            dispatch({ type: "applyUncertain" });
          } else {
            dispatch({ type: "applyRejected", failure: routeFailure(dispatch, res) });
          }
        },
        () => dispatch({ type: "applyUncertain" }),
      );
    },
    refresh: () => {
      dispatch({ type: "dismiss" });
      closeReview();
      setRunToken((t) => t + 1);
      setQueueToken((t) => t + 1);
    },
    dismiss: () => dispatch({ type: "dismiss" }),
    viewChange: (batchId: string) => {
      setBusy(true);
      loadClientLinkBatch(batchId).then(
        (res) => {
          setBusy(false);
          if (res.ok) dispatch({ type: "batchLoaded", batch: res.data });
          else dispatch({ type: "failed", failure: routeFailure(dispatch, res) });
        },
        () => {
          setBusy(false);
          dispatch({ type: "failed", failure: TRANSPORT_FAILURE });
        },
      );
    },
    reviewReversal: (batchId: string) => {
      setBusy(true);
      previewClientLinkRevert(batchId).then(
        (res) => {
          setBusy(false);
          if (res.ok) dispatch({ type: "previewReady", preview: res.data });
          else dispatch({ type: "failed", failure: routeFailure(dispatch, res) });
        },
        () => {
          setBusy(false);
          dispatch({ type: "failed", failure: TRANSPORT_FAILURE });
        },
      );
    },
    retryLookup: () => {
      const run = state.run;
      if (!run) return;
      setBusy(true);
      retryClientLinkLookup(run.run_id).then(
        (res) => {
          setBusy(false);
          if (!res.ok) {
            dispatch({ type: "failed", failure: routeFailure(dispatch, res) });
            return;
          }
          dispatch({ type: "runLoaded", run: res.data.run });
          if (!res.data.accepted) dispatch({ type: "failed", failure: failureView({ reason: "rejected", message: CLIENT_LINK_COPY.lookupSuperseded }) });
        },
        () => {
          setBusy(false);
          dispatch({ type: "failed", failure: TRANSPORT_FAILURE });
        },
      );
    },
  };
}
