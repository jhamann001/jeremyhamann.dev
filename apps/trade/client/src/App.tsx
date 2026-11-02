import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AuthUser, ClientExclusion, RequestStatus, TradeRequest } from '@trade-request/shared';
import { useAuth } from './contexts/AuthContext';
import { useClients, useTradeRequests } from './hooks/useTradeRequests';
import { useNotifications } from './hooks/useNotifications';
import {
  fetchAllRequests,
  fetchBulkAccountExclusions,
  fetchBulkClientExclusions,
  fetchRequest,
  fetchAccountDriftHistory,
  extractApiError,
  fetchServiceMode,
  invalidateLastAllocCache,
  type AccountExclusion,
  type ServiceMode,
} from './api/client';
import { LoginPage } from './components/LoginPage';
import { TopNav } from './components/TopNav';
import { SessionBanner } from './components/SessionBanner';
import { DemoBanner } from './components/DemoBanner';
import { DemoRoleSwitcher } from './components/DemoRoleSwitcher';
import { QueueSkeleton, FormSkeleton, HomeSkeleton } from './components/ui/Skeleton';

const HomePage = lazy(() => import('./components/HomePage').then((m) => ({ default: m.HomePage })));
const RequestModal = lazy(() => import('./components/RequestModal').then((m) => ({ default: m.RequestModal })));
const AdvisorForm = lazy(() => import('./components/AdvisorForm').then((m) => ({ default: m.AdvisorForm })));
const TradingQueue = lazy(() => import('./components/TradingQueue').then((m) => ({ default: m.TradingQueue })));
const UsersTab = lazy(() => import('./components/UsersTab').then((m) => ({ default: m.UsersTab })));
const ConnectedApps = lazy(() => import('./components/ConnectedApps').then((m) => ({ default: m.ConnectedApps })));
const DriftTabV2 = lazy(() => import('./components/DriftTabV2').then((m) => ({ default: m.DriftTabV2 })));
const OutboxTab = lazy(() => import('./components/OutboxTab').then((m) => ({ default: m.OutboxTab })));

export default function App() {
  const { user, loading, error: authError, refresh: authRefresh } = useAuth();

  if (loading) {
    return (
      <div
        className="min-h-screen bg-[var(--bg-page)] flex items-center justify-center"
        role="status"
        aria-live="polite"
      >
        <div className="text-[var(--text-muted)] text-[14px]">Loading...</div>
      </div>
    );
  }

  if (!user && authError) {
    return (
      <div className="min-h-screen bg-[var(--bg-page)] flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="text-[var(--text-muted)] text-[14px]">
            Unable to connect. Please check your network and try again.
          </div>
          <button
            onClick={authRefresh}
            className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  // Render data-dependent UI in a sub-component so its hooks (useClients,
  // useTradeRequests, useNotifications) only mount once we have an authenticated
  // user. This prevents wasted /api/* fetches on every cold visit while loading
  // is true or when the user is on the login page.
  return <ModeAwareApp user={user} />;
}

const FROZEN_BANNER = 'Trade Requests is briefly read-only while it is being moved — try again in a few minutes.';
const MCP_ONLY_BANNER =
  'Trade Requests has moved to the advisor platform. Only MCP and Connected Apps remain on this site.';

// The server enforces the service mode (ticket); this only chooses what to show.
function ModeAwareApp({ user }: { user: AuthUser }) {
  const [mode, setMode] = useState<ServiceMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchServiceMode().then((m) => {
      if (!cancelled) setMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode === null) {
    return (
      <div
        className="min-h-screen bg-[var(--bg-page)] flex items-center justify-center"
        role="status"
        aria-live="polite"
      >
        <div className="text-[var(--text-muted)] text-[14px]">Loading...</div>
      </div>
    );
  }
  if (mode === 'mcp-only') return <McpOnlyApp user={user} />;
  return <AuthenticatedApp user={user} frozen={mode === 'frozen'} />;
}

function McpOnlyApp({ user }: { user: AuthUser }) {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.pathname !== '/connected-apps') navigate('/connected-apps', { replace: true });
  }, [location.pathname, navigate]);

  return (
    <div className="min-h-screen bg-[var(--bg-page)] font-sans flex flex-col">
      <TopNav
        user={user}
        activeView="connected-apps"
        onViewChange={() => navigate('/connected-apps')}
        notifications={[]}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
        connectedAppsOnly
      />
      <main className="flex-1 p-4 md:p-8 overflow-y-auto">
        <div role="status" className="mb-4 text-[13px] text-[var(--text-muted)]">
          {MCP_ONLY_BANNER}
        </div>
        <Suspense fallback={<div className="text-[var(--text-muted)] text-sm">Loading...</div>}>
          <ConnectedApps />
        </Suspense>
      </main>
    </div>
  );
}

function AuthenticatedApp({ user, frozen = false }: { user: AuthUser; frozen?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [formEverMounted, setFormEverMounted] = useState(() => location.pathname === '/new');

  const activeView = useMemo(() => {
    const path = location.pathname;
    if (path === '/new') return 'form';
    if (path === '/queue') return 'queue';
    if (path.startsWith('/queue/')) return `modal-${path.slice(7)}`;
    if (path.startsWith('/edit/')) return `edit-${path.slice(6)}`;
    if (path.startsWith('/clone/')) return `clone-${path.slice(7)}`;
    if (path === '/users') return 'users';
    if (path === '/drift') return 'drift';
    if (path === '/connected-apps') return 'connected-apps';
    if (path === '/outbox') return 'outbox';
    if (path === '/' || path === '') return 'home';
    return 'not-found';
  }, [location.pathname]);

  useEffect(() => {
    if (activeView === 'form') setFormEverMounted(true);
  }, [activeView]);

  // ─── Drift "new results today" indicator ────────────────────────────────────
  // Highlights the Drift nav tab when the latest run is newer than what this user
  // last looked at. The latest run date is fetched once on load; "last viewed" is
  // persisted in localStorage and advanced whenever the user opens the Drift tab.
  // Fully non-fatal — any fetch error just leaves the tab un-highlighted.
  const [latestDriftRunDate, setLatestDriftRunDate] = useState<string | null>(null);
  const [driftViewedDate, setDriftViewedDate] = useState<string | null>(() => {
    try {
      return localStorage.getItem('drift:lastViewedRunDate');
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    fetchAccountDriftHistory(7)
      .then((resp) => {
        if (cancelled) return;
        let max: string | null = null;
        for (const r of resp.runs) if (max === null || r.runDateLocal > max) max = r.runDateLocal;
        setLatestDriftRunDate(max);
      })
      .catch(() => {
        /* non-fatal — leave the tab un-highlighted */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeView === 'drift' && latestDriftRunDate && latestDriftRunDate !== driftViewedDate) {
      setDriftViewedDate(latestDriftRunDate);
      try {
        localStorage.setItem('drift:lastViewedRunDate', latestDriftRunDate);
      } catch {
        /* ignore storage failures */
      }
    }
  }, [activeView, latestDriftRunDate, driftViewedDate]);

  const driftHasNewResults =
    latestDriftRunDate !== null && (driftViewedDate === null || latestDriftRunDate > driftViewedDate);

  const { clients, clientMap, loading: clientsLoading, error: clientsError } = useClients();
  const {
    requests,
    loading: requestsLoading,
    error: requestsError,
    create,
    update,
    updateStatus,
    refresh,
    loadMore,
    loadingMore,
    hasMore,
    queueSearchInput,
    setQueueSearchInput,
  } = useTradeRequests();
  const notifs = useNotifications();

  const handleViewChange = useCallback(
    (view: string) => {
      setSubmitError(null);
      if (view === 'home') navigate('/');
      else if (view === 'form') navigate('/new');
      else if (view === 'queue') navigate('/queue');
      else if (view.startsWith('modal-')) navigate(`/queue/${view.replace('modal-', '')}`);
      else if (view.startsWith('edit-')) navigate(`/edit/${view.replace('edit-', '')}`);
      else if (view.startsWith('clone-')) navigate(`/clone/${view.replace('clone-', '')}`);
      else if (view === 'users') navigate('/users');
      else if (view === 'drift') navigate('/drift');
      else if (view === 'connected-apps') navigate('/connected-apps');
      else if (view === 'outbox') navigate('/outbox');
      else navigate('/');
    },
    [navigate],
  );

  const [modalDismissed, setModalDismissed] = useState(false);

  const handleModalClose = useCallback(() => {
    setSubmitError(null);
    setModalDismissed(true);
    navigate('/queue');
  }, [navigate]);
  const handleModalEdit = useCallback(
    (id: string) => {
      setModalDismissed(true);
      navigate(`/edit/${id}`);
    },
    [navigate],
  );
  const handleModalClone = useCallback(
    (id: string) => {
      setModalDismissed(true);
      navigate(`/clone/${id}`);
    },
    [navigate],
  );

  const modalId = activeView.startsWith('modal-') ? activeView.replace('modal-', '') : null;
  const editId = activeView.startsWith('edit-') ? activeView.replace('edit-', '') : null;
  const cloneId = activeView.startsWith('clone-') ? activeView.replace('clone-', '') : null;

  useEffect(() => {
    setModalDismissed(false);
  }, [modalId]);
  const deepLinkId = modalId ?? editId ?? cloneId;

  const [deepLinkRequest, setDeepLinkRequest] = useState<TradeRequest | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const deepLinkFetchedRef = useRef<string | null>(null);
  const [deepLinkRetry, setDeepLinkRetry] = useState(0);

  const foundInList = deepLinkId ? (requests.find((r) => r.id === deepLinkId) ?? null) : null;

  useEffect(() => {
    if (!deepLinkId || foundInList || requestsLoading) {
      if (!deepLinkId) {
        setDeepLinkRequest(null);
        setDeepLinkError(null);
        deepLinkFetchedRef.current = null;
      }
      return;
    }
    if (deepLinkFetchedRef.current === deepLinkId && deepLinkRetry === 0) return;
    deepLinkFetchedRef.current = deepLinkId;
    setDeepLinkError(null);
    let cancelled = false;
    fetchRequest(deepLinkId)
      .then((r) => {
        if (!cancelled) setDeepLinkRequest(r);
      })
      .catch((err) => {
        if (!cancelled) {
          setDeepLinkRequest(null);
          setDeepLinkError(extractApiError(err, 'Failed to load request. Please try again.'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deepLinkId, foundInList, requestsLoading, deepLinkRetry]);

  const role = user.role;

  const handleSubmit = async (payload: Parameters<typeof create>[0]) => {
    setSubmitError(null);
    try {
      let result: TradeRequest;
      if (payload.existingId) {
        result = await update(payload.existingId, payload);
      } else {
        result = await create(payload);
      }
      for (const cId of result.clientIds ?? [result.clientId]) {
        invalidateLastAllocCache(cId);
      }
      handleViewChange('queue');
    } catch (err: unknown) {
      setSubmitError(extractApiError(err, 'Failed to submit request. Please try again.'));
      // Rethrow so AdvisorForm can tell success from failure. It used to be
      // swallowed here, which made `await onSubmit(...)` resolve on failure and
      // rotate the idempotency key — every retry then looked like a brand-new
      // request to the server and created a duplicate row. AdvisorForm catches
      // this; the message is already on screen via `submitError`.
      throw err;
    }
  };

  const handleStatusChange = async (id: string, status: RequestStatus, note: string) => {
    const req = requests.find((r) => r.id === id) ?? (deepLinkRequest?.id === id ? deepLinkRequest : null);
    try {
      await updateStatus(id, { status, note, expectedUpdatedAt: req?.updatedAt });
    } catch (err: unknown) {
      notifs.pushEphemeral(`Status update failed: ${extractApiError(err)}`);
      throw err;
    }
  };

  /**
   * Fetch standing exclusions for every distinct client in the request set,
   * batched by `fetchBulkClientExclusions`. Failures degrade gracefully — the
   * export proceeds with an empty map and the per-request snapshot fields
   * still render (compliance-preserving). Plan §4G.
   */
  const loadStandingExclusionsForRequests = async (
    rows: TradeRequest[],
  ): Promise<Record<string, ClientExclusion[]>> => {
    const ids: string[] = [];
    for (const r of rows) {
      if (r.clientId) ids.push(r.clientId);
      if (r.clientIds) ids.push(...r.clientIds);
    }
    if (ids.length === 0) return {};
    try {
      return await fetchBulkClientExclusions(ids);
    } catch (err) {
      notifs.pushEphemeral(`Standing exclusions unavailable for export: ${extractApiError(err)}`);
      return {};
    }
  };

  type ExportAccountExclusion = {
    accountNumber: string;
    kind: 'advisor' | 'client';
    ticker: string;
    reason: string;
    noBuy: boolean;
    noSell: boolean;
  };

  /**
   * Resolve selected account numbers on each request to account ULIDs from the
   * current `clientMap`, then fetch standing account exclusions in bulk and
   * reshape them by request for export rendering.
   */
  const loadAccountExclusionsForRequests = async (
    rows: TradeRequest[],
  ): Promise<Record<string, ExportAccountExclusion[]>> => {
    const accountIdByClientAndNumber = new Map<string, string>();
    for (const client of Object.values(clientMap)) {
      for (const account of client.accounts ?? []) {
        accountIdByClientAndNumber.set(`${client.id}::${account.accountNumber}`, account.id);
      }
    }

    const requestAccountRefs = new Map<string, Array<{ accountNumber: string; accountId: string }>>();
    const accountIds = new Set<string>();
    let unresolvedAccountRefs = 0;

    for (const req of rows) {
      const clientIds = req.clientIds?.length ? req.clientIds : [req.clientId];
      const refs: Array<{ accountNumber: string; accountId: string }> = [];
      const seenAccountIds = new Set<string>();
      for (const accountNumber of req.selectedAccounts ?? []) {
        let accountId: string | null = null;
        for (const clientId of clientIds) {
          const resolved = accountIdByClientAndNumber.get(`${clientId}::${accountNumber}`);
          if (resolved) {
            accountId = resolved;
            break;
          }
        }
        if (!accountId) {
          unresolvedAccountRefs += 1;
          continue;
        }
        if (seenAccountIds.has(accountId)) continue;
        seenAccountIds.add(accountId);
        refs.push({ accountNumber, accountId });
        accountIds.add(accountId);
      }
      if (refs.length > 0) requestAccountRefs.set(req.id, refs);
    }

    if (accountIds.size === 0) return {};

    try {
      const accountExclusionsById = await fetchBulkAccountExclusions([...accountIds]);
      const byRequest: Record<string, ExportAccountExclusion[]> = {};
      for (const [requestId, refs] of requestAccountRefs.entries()) {
        const flattened: ExportAccountExclusion[] = [];
        for (const ref of refs) {
          const exclusions: AccountExclusion[] = accountExclusionsById[ref.accountId] ?? [];
          for (const exclusion of exclusions) {
            flattened.push({
              accountNumber: ref.accountNumber,
              kind: exclusion.kind,
              ticker: exclusion.ticker,
              reason: exclusion.reason,
              noBuy: exclusion.noBuy,
              noSell: exclusion.noSell,
            });
          }
        }
        if (flattened.length > 0) byRequest[requestId] = flattened;
      }
      if (unresolvedAccountRefs > 0) {
        notifs.pushEphemeral(
          `Some exported accounts could not be resolved to current account IDs (${unresolvedAccountRefs}). Account-level exclusions may be partial.`,
        );
      }
      return byRequest;
    } catch (err) {
      notifs.pushEphemeral(`Account exclusions unavailable for export: ${extractApiError(err)}`);
      return {};
    }
  };

  const handleExport = async (format: 'csv' | 'pdf' = 'csv') => {
    setExportLoading(true);
    try {
      const identity = { name: user.name, email: user.email };
      if (format === 'pdf') {
        const [{ data: allRequests, truncated }, { exportCompliancePdf }] = await Promise.all([
          fetchAllRequests(),
          import('./utils/pdfExport'),
        ]);
        if (truncated) {
          notifs.pushEphemeral(
            'Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.',
          );
        }
        const standing = await loadStandingExclusionsForRequests(allRequests);
        const accountStanding = await loadAccountExclusionsForRequests(allRequests);
        await exportCompliancePdf(allRequests, identity, standing, accountStanding);
      } else {
        const [{ data: allRequests, truncated }, { exportComplianceReport }] = await Promise.all([
          fetchAllRequests(),
          import('./components/TradingQueue'),
        ]);
        if (truncated) {
          notifs.pushEphemeral(
            'Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.',
          );
        }
        const standing = await loadStandingExclusionsForRequests(allRequests);
        const accountStanding = await loadAccountExclusionsForRequests(allRequests);
        await exportComplianceReport(allRequests, identity, standing, accountStanding);
      }
    } catch (err: unknown) {
      notifs.pushEphemeral(`Export failed: ${extractApiError(err)}`);
    } finally {
      setExportLoading(false);
    }
  };

  const resolveRequest = (id: string | null) => {
    if (!id) return null;
    return requests.find((r) => r.id === id) ?? (deepLinkRequest?.id === id ? deepLinkRequest : null);
  };

  const selectedRequest = resolveRequest(modalId);
  const editRequest = resolveRequest(editId);
  const cloneRequest = resolveRequest(cloneId);

  const deepLinkNotFound =
    !requestsLoading &&
    deepLinkId &&
    !resolveRequest(deepLinkId) &&
    deepLinkFetchedRef.current === deepLinkId &&
    !deepLinkError;

  return (
    <div className="min-h-screen bg-[var(--bg-page)] font-sans flex flex-col">
      <DemoBanner />
      <SessionBanner />
      {frozen && (
        <div
          role="status"
          className="bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-[13px] text-center px-4 py-2 border-b border-[var(--border)]"
        >
          {FROZEN_BANNER}
        </div>
      )}
      <TopNav
        user={user}
        activeView={activeView}
        onViewChange={handleViewChange}
        notifications={notifs.notifications}
        unreadCount={notifs.unreadCount}
        onMarkRead={notifs.markRead}
        onMarkAllRead={notifs.markAllRead}
        driftHasNewResults={driftHasNewResults}
      />

      <main className="flex-1 p-4 md:p-8 overflow-y-auto">
        <Suspense
          fallback={
            activeView === 'queue' || activeView.startsWith('modal-') ? (
              <QueueSkeleton />
            ) : activeView === 'form' || activeView.startsWith('edit-') || activeView.startsWith('clone-') ? (
              <FormSkeleton />
            ) : activeView === 'home' ? (
              <HomeSkeleton />
            ) : (
              <div className="flex items-center justify-center py-20">
                <div className="text-[var(--text-muted)] text-sm">Loading...</div>
              </div>
            )
          }
        >
          {activeView === 'home' && <HomePage user={user} onNavigate={handleViewChange} />}
          {formEverMounted && !editRequest && !cloneRequest && (
            <div className={activeView === 'form' ? '' : 'hidden'}>
              <AdvisorForm
                clientMap={clientMap}
                clients={clients}
                isLoading={clientsLoading}
                error={clientsError}
                submitError={submitError}
                active={activeView === 'form'}
                onSubmit={handleSubmit}
              />
            </div>
          )}
          {editRequest && (
            <AdvisorForm
              key={editRequest.id}
              clientMap={clientMap}
              clients={clients}
              isLoading={clientsLoading}
              error={clientsError}
              submitError={submitError}
              editRequest={editRequest}
              onSubmit={handleSubmit}
              onCancel={() => handleViewChange('queue')}
            />
          )}
          {cloneRequest && (
            <AdvisorForm
              key={`clone-${cloneRequest.id}`}
              clientMap={clientMap}
              clients={clients}
              isLoading={clientsLoading}
              error={clientsError}
              submitError={submitError}
              editRequest={cloneRequest}
              cloneMode
              onSubmit={handleSubmit}
              onCancel={() => handleViewChange('queue')}
            />
          )}
          {(activeView === 'queue' || modalId) && (
            <TradingQueue
              requests={requests}
              role={role}
              loading={requestsLoading}
              error={requestsError}
              loadingMore={loadingMore}
              hasMore={hasMore}
              exportLoading={exportLoading}
              onSelectRequest={(id) => handleViewChange(`modal-${id}`)}
              onExport={handleExport}
              onLoadMore={loadMore}
              onRetry={refresh}
              queueSearchInput={queueSearchInput}
              onQueueSearchChange={setQueueSearchInput}
            />
          )}
          {activeView === 'connected-apps' && <ConnectedApps />}
          {activeView === 'drift' && <DriftTabV2 />}
          {activeView === 'outbox' && <OutboxTab />}
          {activeView === 'users' && role === 'trader' && <UsersTab />}
          {activeView === 'users' && role !== 'trader' && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="text-[var(--text-muted)] text-sm">You don't have permission to view this page.</div>
              <button
                onClick={() => handleViewChange('home')}
                className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
              >
                Go Home
              </button>
            </div>
          )}
          {activeView === 'not-found' && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="text-[var(--text-primary)] text-lg font-semibold">Page Not Found</div>
              <div className="text-[var(--text-muted)] text-sm">The page you're looking for doesn't exist.</div>
              <button
                onClick={() => handleViewChange('home')}
                className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
              >
                Go Home
              </button>
            </div>
          )}
          {deepLinkError && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="text-[var(--red)] text-sm">{deepLinkError}</div>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    deepLinkFetchedRef.current = null;
                    setDeepLinkError(null);
                    setDeepLinkRetry((n) => n + 1);
                  }}
                  className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
                >
                  Retry
                </button>
                <button
                  onClick={() => handleViewChange('queue')}
                  className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Back to Queue
                </button>
              </div>
            </div>
          )}
          {deepLinkNotFound && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="text-[var(--text-muted)] text-sm">
                Request not found. It may have been removed or you may not have access.
              </div>
              <button
                onClick={() => handleViewChange('queue')}
                className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
              >
                Back to Queue
              </button>
            </div>
          )}
        </Suspense>
        {selectedRequest && !modalDismissed && (
          <Suspense fallback={null}>
            <RequestModal
              request={selectedRequest}
              role={role}
              clientMap={clientMap}
              identity={{ name: user.name, email: user.email }}
              onClose={handleModalClose}
              onStatusChange={handleStatusChange}
              onEdit={handleModalEdit}
              onClone={handleModalClone}
            />
          </Suspense>
        )}
      </main>
      <DemoRoleSwitcher />
    </div>
  );
}
