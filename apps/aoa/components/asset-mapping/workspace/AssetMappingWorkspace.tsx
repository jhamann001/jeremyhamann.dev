"use client";

import { DemoRecordLink } from "@/components/demo/DemoRecordLink";
import { otherDemoLinks } from "@/lib/demo/links";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { usdCents } from "@/lib/format";
import {
  loadAssetMapHousehold,
  loadAssetMapHouseholdList,
  loadAssetMapHouseholdLiveExtras,
  loadAssetMapSchedule,
  runAssetMapOnDemandImport,
} from "@/app/(authenticated)/asset-mapping/actions";
import {
  COPY,
  emptyStateTitle,
  householdProcessedLabel,
  householdTotalValue,
  initialWorkspaceState,
  parseRunParam,
  runHref,
  workspaceReducer,
} from "./workspace-model";
import { HouseholdList } from "./HouseholdList";
import { RunSwitcher } from "./RunSwitcher";
import { ScheduleBadge } from "./ScheduleBadge";
import { ConnectionErrorCard } from "./ConnectionErrorCard";
import { OperationsReadView } from "./OperationsReadView";
import { ClientServiceReadView } from "./ClientServiceReadView";
import { pushAddress, replaceAddress } from "./history";
import { useAssetMapEdits } from "./edits/useAssetMapEdits";
import { importThenReload } from "./on-demand-import";
import { applyEdits, undoMessage } from "./edits/edit-model";
import { EditFailureText, UndoBar } from "./edits/EditFeedback";
import { useClientLinking } from "./client-linking/useClientLinking";
import { clientLinkCapabilities, openRunTarget } from "./client-linking/client-link-model";
import { WorkspaceSectionNav, type WorkspaceSection } from "./client-linking/WorkspaceSectionNav";
import { ClientLinkQueue } from "./client-linking/ClientLinkQueue";
import { ClientLinkReview } from "./client-linking/ClientLinkReview";
import { BatchPanel, ClientLinkPreview, ResultNotice } from "./client-linking/ClientLinkPreview";
import { HouseholdLinkCard } from "./client-linking/HouseholdLinkCard";
import { ClientLinkErrorNotice } from "./client-linking/ClientLinkNotices";
import { useAssetMapDestinations } from "./destinations/useAssetMapDestinations";
import { DestinationsPanel, ExportCsvButton, TransferTargetControl } from "./destinations/DestinationsPanel";
import { buildHouseholdSpreadsheet, downloadHouseholdSpreadsheet, householdSpreadsheetFilename } from "./export";
import {
  CompletionPill, DocumentAlert, DriveSavedNotice, ExportAllClientsButton, ExportPdfButton, HouseholdReviewAction, RunScanControl,
} from "./documents/DocumentControls";
import { useAssetMapDocuments, type DocumentsAccess } from "./documents/useAssetMapDocuments";
import styles from "./AssetMappingWorkspace.module.css";

const SCHEDULE_POLL_MS = 60_000;
const SHARE_COPIED_MS = 2000;
const DOCUMENTS_OFF: DocumentsAccess = { enabled: false, canOperate: false };

export const EXPORT_MENU_LABEL = "Export";

function ExportMenu({ children }: { children: ReactNode }) {
  return (
    <details className={styles.menu} data-menu="export">
      <summary className={styles.menuToggle}>{EXPORT_MENU_LABEL}</summary>
      <div className={styles.menuList}>{children}</div>
    </details>
  );
}

export function AssetMappingWorkspace({
  initialRunId,
  canOperate = true,
  canEdit,
  canLink,
  canEditDestinations,
  documents = DOCUMENTS_OFF,
  onDemandImport = false,
}: {
  initialRunId: string | null;
  /** False for Advisor and Client Service (ticket): the Client Service view only. */
  canOperate?: boolean;
  canEdit: boolean;
  canLink: boolean;
  canEditDestinations: boolean;
  documents?: DocumentsAccess;
  onDemandImport?: boolean;
}) {
  const [state, dispatch] = useReducer(workspaceReducer, initialRunId, initialWorkspaceState);
  const [copied, setCopied] = useState(false);
  const openRun = useRef(state.selectedId);
  openRun.current = state.selectedId;
  // Quiet refresh after an on-demand import (ticket): no loading state, the
  // open run stays selected, and the edit state is kept.
  const refreshInPlace = async () => {
    const id = openRun.current;
    const [list, household, extras] = await Promise.all([
      loadAssetMapHouseholdList().catch(() => null),
      id == null ? null : loadAssetMapHousehold(id).catch(() => null),
      id == null ? null : loadAssetMapHouseholdLiveExtras(id).catch(() => null),
    ]);
    if (list?.ok) dispatch({ type: "listRefreshed", runs: list.data });
    if (id != null && household?.ok && household.data != null) {
      dispatch({ type: "householdRefreshed", id, household: household.data, extras: extras?.ok ? extras.data : null });
    }
  };
  const importAndRefresh = () => void importThenReload({ runImport: runAssetMapOnDemandImport, reload: refreshInPlace });
  const edits = useAssetMapEdits(state.household?.id ?? null, onDemandImport ? importAndRefresh : undefined);
  const [section, setSection] = useState<WorkspaceSection>("households");
  const linking = useClientLinking({ canLink, selectedId: state.selectedId, section });
  const caps = clientLinkCapabilities(canLink, linking.state.config, canOperate);
  const activeView = canOperate ? state.view : "client-service";
  const destinations = useAssetMapDestinations(canEditDestinations ? (state.household?.id ?? null) : null);
  const docs = useAssetMapDocuments(state.household?.id ?? null, state.liveExtras?.review ?? null, documents);

  useEffect(() => {
    if (state.listStatus !== "loading") return;
    let cancelled = false;
    loadAssetMapHouseholdList().then(
      (res) => {
        if (cancelled) return;
        dispatch(res.ok ? { type: "listLoaded", runs: res.data } : { type: "listFailed" });
      },
      () => {
        if (!cancelled) dispatch({ type: "listFailed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.listStatus]);

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      loadAssetMapSchedule().then(
        (res) => {
          if (!cancelled) dispatch({ type: "scheduleLoaded", schedule: res.ok ? res.data : null });
        },
        () => {
          if (!cancelled) dispatch({ type: "scheduleLoaded", schedule: null });
        },
      );
    poll();
    const timer = setInterval(poll, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const id = state.selectedId;
    if (id == null) return;
    let cancelled = false;
    dispatch({ type: "householdLoading" });
    loadAssetMapHousehold(id).then(
      async (res) => {
        if (cancelled) return;
        if (!res.ok || res.data == null) {
          dispatch({ type: "householdFailed" });
          return;
        }
        dispatch({ type: "householdLoaded", household: res.data });
        const extras = await loadAssetMapHouseholdLiveExtras(id).catch(() => null);
        if (!cancelled) dispatch({ type: "liveExtrasLoaded", extras: extras?.ok ? extras.data : null });
      },
      () => {
        if (!cancelled) dispatch({ type: "householdFailed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.selectedId]);

  useEffect(() => {
    const onPop = () => dispatch({ type: "popState", runId: parseRunParam(window.location.search) });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const selectRun = (id: string) => {
    dispatch({ type: "selectRun", id });
    pushAddress(runHref(id));
  };

  const selectClient = (name: string) => {
    dispatch({ type: "selectClient", name });
    const latest = state.groups[name]?.[0];
    if (latest) pushAddress(runHref(latest.id));
  };

  const share = (id: string) => {
    void navigator.clipboard.writeText(window.location.origin + runHref(id)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), SHARE_COPIED_MS);
    });
  };

  if (state.listStatus === "failed" || state.householdStatus === "failed") {
    return (
      <ConnectionErrorCard
        onRetry={() => {
          dispatch({ type: "retry" });
          replaceAddress("/asset-mapping");
        }}
      />
    );
  }

  const showQueue = caps.visible && section === "linking";
  const viewRun = (id: string) => {
    const target = openRunTarget(state.runs, id);
    if (target === "select") {
      setSection("households");
      dispatch({ type: "popState", runId: id });
      pushAddress(runHref(id));
    }
    return target;
  };
  const linkPanels = caps.canReview ? (
    <>
      {linking.state.preview ? null : <ClientLinkErrorNotice failure={linking.state.failure} />}
      {linking.reviewRun && linking.draft ? (
        <ClientLinkReview
          run={linking.reviewRun}
          draft={linking.draft}
          directory={linking.directory}
          busy={linking.busy}
          onDraft={linking.onDraft}
          onQuery={linking.setDirectoryQuery}
          onPreview={linking.previewDraft}
          onClose={linking.closeReview}
        />
      ) : null}
      {linking.state.preview ? (
        <ClientLinkPreview
          key={linking.state.preview.preview_id}
          preview={linking.state.preview}
          now={linking.now}
          uncertain={linking.state.uncertain}
          failure={linking.state.failure}
          applying={linking.state.applying}
          onApply={linking.apply}
          onRefresh={linking.refresh}
          onClose={linking.dismiss}
        />
      ) : null}
      {linking.state.batch ? (
        <BatchPanel batch={linking.state.batch} busy={linking.busy} onReviewReversal={linking.reviewReversal} onClose={linking.dismiss} />
      ) : null}
      {linking.state.result ? (
        <ResultNotice result={linking.state.result} busy={linking.busy} onReviewReversal={linking.reviewReversal} />
      ) : null}
    </>
  ) : null;

  const selectedRuns = state.selectedClient != null ? (state.groups[state.selectedClient] ?? []) : [];
  const viewProps = state.household
    ? {
        household: canEdit ? applyEdits(state.household, edits.state) : state.household,
        liveExtras: state.liveExtras,
        collapsedAccounts: state.collapsedAccounts,
        expandedLots: state.expandedLots,
        onToggleAccount: (id: string) => dispatch({ type: "toggleAccount", id }),
        onToggleLots: (id: string) => dispatch({ type: "toggleLots", id }),
      }
    : null;
  const processedLabel = viewProps ? householdProcessedLabel(selectedRuns, viewProps.household.processedAt) : null;
  const exportSpreadsheet = () => {
    const view = destinations.state.view;
    if (!viewProps || !view) return;
    const overridden = new Set([...view.overriddenPositionIds, ...(canEdit ? Object.keys(edits.state.status) : [])]);
    const household = viewProps.household;
    downloadHouseholdSpreadsheet(buildHouseholdSpreadsheet(household, view, overridden), householdSpreadsheetFilename(household.clientName, new Date()));
  };
  const showSectionBar = caps.visible || state.schedule != null || (documents.enabled && documents.canOperate);
  const linkCard = caps.visible ? (
    <>
      <HouseholdLinkCard
        run={linking.cardRun}
        failure={linking.state.runFailure}
        canReview={caps.canReview}
        writesDisabled={caps.writesDisabled}
        busy={linking.busy}
        onRetryLoad={linking.retryRun}
        onRetryLookup={linking.retryLookup}
        onReview={() => {
          if (linking.cardRun) linking.openReview(linking.cardRun.run_id);
        }}
        onViewChange={linking.viewChange}
      />
      {linkPanels}
    </>
  ) : null;

  return (
    <div className={styles.workspace}>
      <HouseholdList
        groups={state.groups}
        search={state.search}
        selectedClient={state.selectedClient}
        railOpen={state.railOpen}
        onSearch={(query) => dispatch({ type: "setSearch", query })}
        onSelectClient={selectClient}
        onToggleRail={() => dispatch({ type: "toggleRail" })}
        footer={documents.enabled && state.runs.length > 0
          ? <ExportAllClientsButton busy={docs.state.busy.allPdf} onExport={docs.downloadAllPdf} />
          : null}
      />
      <div className={styles.main}>
        {showSectionBar ? (
          <div className={styles.sectionBar} data-section-bar="">
            <WorkspaceSectionNav visible={caps.visible} active={section} onSelect={setSection} />
            <div className={styles.sectionTools}>
              <ScheduleBadge schedule={state.schedule} />
              {documents.enabled && documents.canOperate ? (
                <RunScanControl
                  busy={docs.state.busy.scan}
                  message={docs.state.scanMessage}
                  onRun={() => docs.runScan(() => (onDemandImport ? importAndRefresh() : dispatch({ type: "listReload" })))}
                  onDismiss={docs.dismissScanMessage}
                />
              ) : null}
            </div>
          </div>
        ) : null}
        {documents.enabled && docs.alert ? <DocumentAlert text={docs.alert} onDismiss={docs.dismissAlert} /> : null}
        {documents.enabled && docs.notice && !showQueue ? <DriveSavedNotice notice={docs.notice} /> : null}
        {showQueue ? (
          <>
            <ClientLinkQueue
              page={linking.state.page}
              status={linking.state.queueStatus}
              failure={linking.state.queueFailure}
              reviewState={linking.reviewState}
              query={linking.query}
              selection={linking.selection}
              filterTotals={linking.filterTotals}
              canReview={caps.canReview}
              writesDisabled={caps.writesDisabled}
              onReviewState={linking.setReviewState}
              onQuery={linking.setQuery}
              onLoadMore={linking.loadMore}
              onRetry={linking.retryQueue}
              onToggle={linking.toggleFolder}
              onPreviewBackfill={linking.previewBackfill}
              onReview={linking.openReview}
              onViewRun={viewRun}
            />
            {linkPanels}
          </>
        ) : state.listStatus === "loading" || state.householdStatus === "loading" ? (
          <p className={styles.muted} aria-busy="true">Loading…</p>
        ) : viewProps == null ? (
          <div className={styles.empty}>
            <h2>{emptyStateTitle(state.runs.length)}</h2>
            <p>{state.runs.length === 0 ? COPY.emptyListBody : COPY.selectBody}</p>
          </div>
        ) : (
          <>
            <div className={styles.header} data-household-header="">
              <div className={styles.headerRow} data-header-row="identity">
                <h1>{viewProps.household.clientName}</h1>
                {processedLabel ? <span className={styles.muted} data-household-processed="">{processedLabel}</span> : null}
                <DemoRecordLink href={otherDemoLinks.statementRun(viewProps.household.id)} demo="Statement Analyzer" />
                {documents.enabled ? <CompletionPill review={docs.review} /> : null}
                <div className={styles.total}>
                  <span className={styles.muted}>Total Household Value</span>
                  <strong>{usdCents(householdTotalValue(viewProps.household))}</strong>
                </div>
              </div>
              <div className={styles.headerRow} data-header-row="actions">
                {canOperate ? (
                  <div className={styles.toggle}>
                    <Button
                      size="sm"
                      variant={activeView === "operations" ? "primary" : "ghost"}
                      aria-pressed={activeView === "operations"}
                      onClick={() => dispatch({ type: "setView", view: "operations" })}
                    >
                      {COPY.viewOperations}
                    </Button>
                    <Button
                      size="sm"
                      variant={activeView === "client-service" ? "primary" : "ghost"}
                      aria-pressed={activeView === "client-service"}
                      onClick={() => dispatch({ type: "setView", view: "client-service" })}
                    >
                      {COPY.viewClientService}
                    </Button>
                  </div>
                ) : (
                  <span className={styles.muted} data-view-label="client-service">{COPY.viewClientService}</span>
                )}
                <span className={styles.headerActions}>
                  <ExportMenu>
                    <Button variant="ghost" size="sm" onClick={() => share(viewProps.household.id)}>
                      {copied ? COPY.shareCopied : COPY.copyLink}
                    </Button>
                    {canEditDestinations && activeView === "operations" ? (
                      <ExportCsvButton ready={destinations.state.view != null} onExport={exportSpreadsheet} />
                    ) : null}
                    {documents.enabled ? (
                      <ExportPdfButton busy={docs.state.busy} onPdf={() => docs.downloadPdf(viewProps.household.id)} />
                    ) : null}
                  </ExportMenu>
                  {documents.enabled ? (
                    <HouseholdReviewAction
                      view={activeView}
                      canOperate={documents.canOperate}
                      busy={docs.state.busy}
                      review={docs.review}
                      onPdf={() => docs.downloadPdf(viewProps.household.id)}
                      onMarkCompleted={() => docs.saveToDrive("markCompleted", viewProps.household.id)}
                      onSaveToDrive={() => docs.saveToDrive("saveToDrive", viewProps.household.id)}
                    />
                  ) : null}
                </span>
              </div>
            </div>
            <RunSwitcher runs={selectedRuns} selectedId={state.selectedId} onSelect={selectRun} />
            {canEdit && edits.state.undo ? (
              <UndoBar
                message={undoMessage(edits.state.undo.kind, edits.state.undo.label)}
                onUndo={() => edits.undo(edits.state.undo!)}
              />
            ) : null}
            {canEdit && edits.state.failure?.key.startsWith("restore") ? (
              <EditFailureText text={edits.state.failure.text} />
            ) : null}
            {activeView === "operations" ? (
              <OperationsReadView
                {...viewProps}
                linkCard={linkCard}
                edits={canEdit ? {
                  state: edits.state,
                  onEdit: edits.edit,
                  onAskRemoveAccount: edits.askRemoveAccount,
                  onAskAccountType: edits.askAccountType,
                  onConfirm: edits.confirm,
                  onCancel: edits.cancel,
                } : null}
                destinations={canEditDestinations ? (
                  <DestinationsPanel key={viewProps.household.id} state={destinations.state} onSave={destinations.save} onRetry={destinations.retry} />
                ) : null}
                accountTransfer={canEditDestinations ? (acc) => (
                  <TransferTargetControl account={acc} state={destinations.state} onSave={destinations.save} />
                ) : undefined}
              />
            ) : (
              <>
                {linkCard}
                <ClientServiceReadView {...viewProps} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
