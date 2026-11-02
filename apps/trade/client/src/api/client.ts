import axios, { type AxiosInstance } from 'axios';
import { signInUrlFor } from '../utils/signInPath';
import type {
  AuthUser,
  Client,
  Holdings,
  HouseholdResolveResponse,
  HouseholdHoldingsResponse,
  TradeRequest,
  CreateTradeRequestPayload,
  UpdateStatusPayload,
  RunEnginePayload,
  LastAllocationData,
  UserRole,
  ThemePreference,
  Notification,
  ClientExclusion,
  CreateClientExclusionPayload,
  DriftOverrideReason,
  ExclusionExportRow,
  PreapprovalChecklist,
  ChecklistItemKey,
} from '@trade-request/shared';
import {
  authUserSchema,
  appConfigSchema,
  serviceModeSchema,
  classifiedHoldingsResponseSchema,
  householdHoldingsResponseSchema,
  lastAllocationSchema,
  clientsResponseSchema,
  usersResponseSchema,
  paginatedRequestsSchema,
  singleRequestResponseSchema,
  notificationsListResponseSchema,
  mcpSessionsResponseSchema,
  mcpPatsResponseSchema,
  createMcpPatResponseSchema,
  driftHistoryResponseSchema,
  driftAllowListResponseSchema,
  driftRunDetailResponseSchema,
  accountDriftHistoryResponseSchema,
  accountDriftRunResponseSchema,
  exclusionOverlapReportSchema,
  householdResolveResponseSchema,
  clientExclusionsListResponseSchema,
  clientExclusionResponseSchema,
  clientExclusionDeleteResponseSchema,
  bulkClientExclusionsResponseSchema,
  exclusionExportResponseSchema,
  clientExclusionsBatchResponseSchema,
  bulkAccountExclusionsResponseSchema,
  accountExclusionsBatchResponseSchema,
  setDriftOverrideResponseSchema,
  checklistResponseSchema,
  outboxResponseSchema,
  type OutboxMessage,
  signInOptionsSchema,
  type Persona,
  type SignInOptions,
} from './schemas';

let redirecting = false;

function getCsrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]*)/);
  return match?.[1];
}

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (axios.isCancel(err)) return false;
  if (!err.response) return true; // network error / timeout
  return RETRYABLE_STATUS_CODES.has(err.response.status);
}

function isIdempotent(method?: string): boolean {
  return !method || ['get', 'head', 'options', 'put', 'delete'].includes(method.toLowerCase());
}

type ApiErrorDetail = { path?: unknown; message?: unknown };

function formatValidationDetails(details: ApiErrorDetail[]): string[] {
  return details
    .map((d) => {
      const path = Array.isArray(d?.path)
        ? d.path
            .filter((p) => p !== '' && p != null)
            .map(String)
            .join('.')
        : '';
      const msg = typeof d?.message === 'string' ? d.message : '';
      if (path && msg) return `${path}: ${msg}`;
      return msg || path;
    })
    .filter(Boolean);
}

export function extractApiError(err: unknown, fallback = 'An unexpected error occurred'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: unknown; details?: unknown } | undefined;
    const serverMessage = typeof data?.error === 'string' ? data.error : '';
    if (serverMessage) {
      const details = Array.isArray(data?.details) ? (data.details as ApiErrorDetail[]) : [];
      const fieldErrors = formatValidationDetails(details).slice(0, 3);
      return fieldErrors.length > 0 ? `${serverMessage}: ${fieldErrors.join('; ')}` : serverMessage;
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function attachInterceptors(instance: AxiosInstance): void {
  instance.interceptors.request.use((config) => {
    const token = getCsrfToken();
    if (token) {
      config.headers['x-csrf-token'] = token;
    }
    return config;
  });

  instance.interceptors.response.use(
    (res) => {
      // Avoid dispatching for notification polling — useNotifications listens for
      // session-activity and would otherwise chain unbounded GET /notifications.
      const path = res.config.url ?? '';
      const isNotifications = typeof path === 'string' && path.includes('/notifications');
      if (!isNotifications) {
        window.dispatchEvent(new Event('session-activity'));
      }
      return res;
    },
    async (err) => {
      const config = err.config;
      const retryCount: number = config?.__retryCount ?? 0;

      if (config && retryCount < MAX_RETRIES && isRetryable(err) && isIdempotent(config.method)) {
        config.__retryCount = retryCount + 1;
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** retryCount));
        return instance.request(config);
      }

      const isAuthCheck = config?.url === '/me' && config?.baseURL === '/auth';
      if (
        err.response?.status === 401 &&
        !isAuthCheck &&
        !redirecting &&
        !window.location.pathname.startsWith('/login')
      ) {
        redirecting = true;
        // Keeps where the visitor was, so signing in brings them back (a request link from another demo, say).
        window.location.href = signInUrlFor(window.location);
      }
      return Promise.reject(err);
    },
  );
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Trade-request writes get a longer deadline than the 30s default.
 *
 * POST/PUT /requests fans out to Warehouse for account data and then runs the
 * asset-location engine before it commits, so it can outlive 30s on a cold
 * Cloud Run instance or a slow Warehouse. Cloud Run's own request timeout is the
 * 300s default (not set in .github/workflows/deploy-prod.yml), so at 30s the
 * browser was abandoning requests the server went on to commit — the advisor
 * saw a failure for a request that landed, retried, and produced a duplicate.
 *
 * Still bounded well under Cloud Run's 300s so a genuinely stuck request fails
 * rather than hanging. The idempotency key makes any retry safe regardless.
 */
const WRITE_TIMEOUT_MS = 120_000;

const api = axios.create({ baseURL: '/api', withCredentials: true, timeout: REQUEST_TIMEOUT_MS });
attachInterceptors(api);

const authApi = axios.create({ baseURL: '/auth', withCredentials: true, timeout: REQUEST_TIMEOUT_MS });
attachInterceptors(authApi);

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const { data } = await authApi.get('/me');
    return authUserSchema.parse(data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      return null;
    }
    throw err;
  }
}

let appConfigCache: { allowedDomains: string[]; sessionTtlMs: number } | null = null;

export async function fetchAppConfig(): Promise<{ allowedDomains: string[]; sessionTtlMs: number }> {
  if (appConfigCache) return appConfigCache;
  const { data } = await authApi.get('/config');
  const parsed = appConfigSchema.parse(data);
  appConfigCache = parsed;
  return parsed;
}

export type ServiceMode = 'active' | 'frozen' | 'mcp-only';

/**
 * The service mode (ticket): frozen shows a read-only banner, MCP-only shows only Connected Apps.
 * Display only — the server enforces both — so a failed read shows the full app.
 */
export async function fetchServiceMode(): Promise<ServiceMode> {
  try {
    const { data } = await api.get('/service-mode');
    return serviceModeSchema.parse(data).mode;
  } catch {
    return 'active';
  }
}

export type { Persona, SignInOptions };

/** What the sign-in page can offer. Public; it also sets the CSRF cookie the sign-in POST echoes back. */
export async function fetchSignInOptions(): Promise<SignInOptions> {
  const { data } = await authApi.get('/sign-in-options');
  return signInOptionsSchema.parse(data);
}

/**
 * Demo only: sign in as one of the firm's personas. With an MCP connection request's state, returns where
 * to send the browser next (the MCP client, carrying its authorization code).
 */
export async function signInAsPersona(email: string, mcpState?: string): Promise<{ redirect?: string }> {
  const { data } = await authApi.post('/persona', mcpState ? { email, mcpState } : { email });
  return { redirect: typeof data?.redirect === 'string' ? data.redirect : undefined };
}

export async function logout(): Promise<void> {
  await authApi.post('/logout');
  appConfigCache = null;
  holdingsCache.clear();
  lastAllocCache.clear();
  usersCache = null;
}

export async function extendSession(): Promise<void> {
  await authApi.post('/extend-session');
}

export async function toggleDemo(): Promise<{ demo: boolean }> {
  const { data } = await authApi.post('/demo');
  return data;
}

export async function fetchClients(signal?: AbortSignal): Promise<Client[]> {
  const { data } = await api.get('/clients', { signal });
  const parsed = clientsResponseSchema.parse(data);
  return parsed.data as Client[];
}

export async function fetchRequests(
  before?: string,
  signal?: AbortSignal,
  search?: string,
): Promise<{ data: TradeRequest[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (before) params.set('before', before);
  const q = search?.trim();
  if (q) params.set('q', q);
  const { data } = await api.get(`/requests${params.toString() ? `?${params}` : ''}`, { signal });
  const parsed = paginatedRequestsSchema.parse(data);
  return { data: parsed.data as TradeRequest[], nextCursor: parsed.nextCursor ?? null };
}

export async function fetchRequest(id: string): Promise<TradeRequest> {
  const { data } = await api.get(`/requests/${id}`);
  const parsed = singleRequestResponseSchema.parse(data);
  return parsed.data as TradeRequest;
}

export interface RequestCounts {
  total: number;
  pendingReview: number;
  needsInfo: number;
  approved: number;
}

export async function fetchRequestCounts(): Promise<RequestCounts> {
  const { data } = await api.get('/requests/counts');
  return data as RequestCounts;
}

export async function fetchNotifications(options?: {
  limit?: number;
  unreadOnly?: boolean;
}): Promise<{ data: Notification[]; unreadCount: number }> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.unreadOnly) params.set('unreadOnly', 'true');
  const qs = params.toString();
  const { data } = await api.get(`/notifications${qs ? `?${qs}` : ''}`);
  const parsed = notificationsListResponseSchema.parse(data);
  return { data: parsed.data as Notification[], unreadCount: parsed.unreadCount };
}

export async function markNotificationRead(id: string): Promise<void> {
  await api.patch(`/notifications/${id}/read`);
}

export async function markAllNotificationsRead(): Promise<void> {
  await api.post('/notifications/read-all');
}

export async function fetchAllRequests(): Promise<{ data: TradeRequest[]; truncated: boolean }> {
  const { data } = await api.get('/requests?all=true');
  const parsed = paginatedRequestsSchema.parse(data);
  return { data: parsed.data as TradeRequest[], truncated: parsed.truncated === true };
}

export async function createRequest(payload: CreateTradeRequestPayload): Promise<TradeRequest> {
  const { data } = await api.post('/requests', payload, { timeout: WRITE_TIMEOUT_MS });
  const parsed = singleRequestResponseSchema.parse(data);
  return parsed.data as TradeRequest;
}

export async function updateRequest(id: string, payload: CreateTradeRequestPayload): Promise<TradeRequest> {
  const { data } = await api.put(`/requests/${id}`, payload, { timeout: WRITE_TIMEOUT_MS });
  const parsed = singleRequestResponseSchema.parse(data);
  return parsed.data as TradeRequest;
}

export async function updateRequestStatus(id: string, payload: UpdateStatusPayload): Promise<TradeRequest> {
  const { data } = await api.put(`/requests/${id}/status`, payload);
  const parsed = singleRequestResponseSchema.parse(data);
  return parsed.data as TradeRequest;
}

export async function runEngine(id: string, payload: RunEnginePayload): Promise<TradeRequest> {
  const { data } = await api.post(`/requests/${id}/run-engine`, payload);
  const parsed = singleRequestResponseSchema.parse(data);
  return parsed.data as TradeRequest;
}

const holdingsCache = new Map<string, { data: Record<string, Holdings>; source: string }>();

export function invalidateHoldingsCache(requestId: string): void {
  holdingsCache.delete(requestId);
}

export async function fetchClassifiedHoldings(
  requestId: string,
): Promise<{ data: Record<string, Holdings>; source: string }> {
  const cached = holdingsCache.get(requestId);
  if (cached) return cached;

  const { data } = await api.get(`/requests/${requestId}/classified-holdings`);
  const parsed = classifiedHoldingsResponseSchema.parse(data);
  holdingsCache.set(requestId, parsed as { data: Record<string, Holdings>; source: string });
  return parsed as { data: Record<string, Holdings>; source: string };
}

const householdHoldingsCache = new Map<string, HouseholdHoldingsResponse>();

export function invalidateHouseholdHoldingsCache(requestId: string): void {
  householdHoldingsCache.delete(requestId);
}

export async function fetchHouseholdHoldings(requestId: string): Promise<HouseholdHoldingsResponse> {
  const cached = householdHoldingsCache.get(requestId);
  if (cached) return cached;

  const { data } = await api.get(`/requests/${requestId}/household-holdings`);
  const parsed = householdHoldingsResponseSchema.parse(data) as HouseholdHoldingsResponse;
  householdHoldingsCache.set(requestId, parsed);
  return parsed;
}

const lastAllocCache = new Map<string, { data: LastAllocationData | null; ts: number }>();
const LAST_ALLOC_TTL = 5 * 60 * 1000;

export async function fetchLastAllocation(clientId: string): Promise<LastAllocationData | null> {
  const cached = lastAllocCache.get(clientId);
  if (cached && Date.now() - cached.ts < LAST_ALLOC_TTL) return cached.data;

  const { data } = await api.get(`/requests/last-allocation/${clientId}`);
  const parsed = lastAllocationSchema.parse(data);
  lastAllocCache.set(clientId, { data: parsed as LastAllocationData | null, ts: Date.now() });
  return parsed as LastAllocationData | null;
}

export function invalidateLastAllocCache(clientId: string): void {
  lastAllocCache.delete(clientId);
}

let usersCache: { data: AuthUser[]; ts: number } | null = null;
const USERS_CACHE_TTL = 2 * 60 * 1000;

export async function fetchUsers(): Promise<AuthUser[]> {
  if (usersCache && Date.now() - usersCache.ts < USERS_CACHE_TTL) return usersCache.data;
  const { data } = await api.get('/users');
  const parsed = usersResponseSchema.parse(data);
  const users = parsed.data as AuthUser[];
  usersCache = { data: users, ts: Date.now() };
  return users;
}

export function invalidateUsersCache(): void {
  usersCache = null;
}

export async function inviteUser(payload: { email: string; name: string; role: UserRole }): Promise<AuthUser> {
  const { data } = await api.post('/users/invite', payload);
  return authUserSchema.parse(data);
}

export async function updateUserRole(id: string, role: UserRole): Promise<AuthUser> {
  const { data } = await api.patch(`/users/${id}/role`, { role });
  return authUserSchema.parse(data);
}

export async function deactivateUser(id: string): Promise<AuthUser> {
  const { data } = await api.patch(`/users/${id}/deactivate`);
  return authUserSchema.parse(data);
}

export async function reactivateUser(id: string): Promise<AuthUser> {
  const { data } = await api.patch(`/users/${id}/reactivate`);
  return authUserSchema.parse(data);
}

export async function updateSlackId(id: string, slackUserId: string): Promise<AuthUser> {
  const { data } = await api.patch(`/users/${id}/slack`, { slackUserId });
  return authUserSchema.parse(data);
}

export async function updateThemePreference(themePreference: ThemePreference): Promise<AuthUser> {
  const { data } = await authApi.patch('/preferences', { themePreference });
  return authUserSchema.parse(data);
}

// ─── MCP sessions (Connected Apps) ──────────────────────────────────────────

export interface McpSession {
  familyId: string;
  clientId: string;
  clientName: string;
  registeredAt: string;
  lastRefreshedAt: string;
  lastAccessTokenAt: string | null;
  refreshExpiresAt: string;
}

// ─── Demo outbox ─────────────────────────────────────────────────────

export type { OutboxMessage };

/** Slack messages and emails the demo would have delivered, newest first. */
export async function fetchOutbox(): Promise<OutboxMessage[]> {
  const { data } = await api.get('/outbox');
  return outboxResponseSchema.parse(data).data;
}

export async function fetchMcpSessions(): Promise<McpSession[]> {
  const { data } = await api.get('/me/mcp-sessions');
  const parsed = mcpSessionsResponseSchema.parse(data);
  return parsed.data;
}

export async function revokeMcpSession(familyId: string): Promise<void> {
  await api.delete(`/me/mcp-sessions/${familyId}`);
}

export async function revokeAllMcpSessions(): Promise<{ revokedFamilies: number }> {
  const { data } = await api.delete('/me/mcp-sessions');
  return data as { revokedFamilies: number };
}

// ─── MCP Personal Access Tokens (Connected Apps → API tokens) ───────────────

export interface McpPatMetadata {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedMcpPat {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export async function fetchMcpPats(): Promise<McpPatMetadata[]> {
  const { data } = await api.get('/me/mcp-tokens');
  return mcpPatsResponseSchema.parse(data).data;
}

export async function createMcpPat(name: string): Promise<CreatedMcpPat> {
  const { data } = await api.post('/me/mcp-tokens', { name });
  return createMcpPatResponseSchema.parse(data);
}

export async function revokeMcpPat(id: string): Promise<void> {
  await api.delete(`/me/mcp-tokens/${id}`);
}

// ─── Client exclusions (per-client standing list) ──────────────────────────

export async function fetchClientExclusions(clientId: string, signal?: AbortSignal): Promise<ClientExclusion[]> {
  const { data } = await api.get(`/clients/${encodeURIComponent(clientId)}/exclusions`, { signal });
  return clientExclusionsListResponseSchema.parse(data).data as ClientExclusion[];
}

export async function createClientExclusion(
  clientId: string,
  payload: CreateClientExclusionPayload,
): Promise<ClientExclusion> {
  const { data } = await api.post(`/clients/${encodeURIComponent(clientId)}/exclusions`, payload);
  return clientExclusionResponseSchema.parse(data).data as ClientExclusion;
}

export async function deleteClientExclusion(clientId: string, id: string): Promise<void> {
  const { data } = await api.delete(`/clients/${encodeURIComponent(clientId)}/exclusions/${encodeURIComponent(id)}`);
  clientExclusionDeleteResponseSchema.parse(data);
}

/**
 * v3.4: each add must carry explicit noBuy / noSell. The server's batch
 * Zod schema requires both fields (no defaults), forcing the modal to
 * stage an explicit side per row.
 */
export interface ApplyClientExclusionsBatchAddItem {
  ticker: string;
  kind: 'advisor' | 'client';
  reason: string;
  noBuy: boolean;
  noSell: boolean;
}

/**
 * v3.4: inline flag-only edit of an existing row. The server rejects
 * (false, false) at three layers (Zod, runtime, DB CHECK); the modal also
 * disables Apply for any pending edit that ends up with neither flag set.
 */
export interface ApplyClientExclusionsBatchEditItem {
  id: string;
  noBuy: boolean;
  noSell: boolean;
}

export interface ApplyClientExclusionsBatchPayload {
  add: ApplyClientExclusionsBatchAddItem[];
  remove: string[];
  edit: ApplyClientExclusionsBatchEditItem[];
}

export interface ApplyClientExclusionsBatchResult {
  exclusions: ClientExclusion[];
  added: number;
  removed: number;
  edited: number;
}

export interface AccountExclusion {
  id: string;
  accountId: string;
  ticker: string;
  kind: 'advisor' | 'client';
  reason: string;
  noBuy: boolean;
  noSell: boolean;
  createdByName: string;
  createdAt: string;
}

export type ApplyAccountExclusionsBatchAddItem = ApplyClientExclusionsBatchAddItem;
export type ApplyAccountExclusionsBatchEditItem = ApplyClientExclusionsBatchEditItem;

export interface ApplyAccountExclusionsBatchPayload {
  add: ApplyAccountExclusionsBatchAddItem[];
  remove: string[];
  edit: ApplyAccountExclusionsBatchEditItem[];
}

export interface ApplyAccountExclusionsBatchResult {
  exclusions: AccountExclusion[];
  added: number;
  removed: number;
  edited: number;
}

/**
 * Atomic apply for the v3.3 modal staging UX, extended in v3.4 to include
 * inline flag edits. Either the entire batch commits (one Slack message,
 * one in-app notification, returns full post-commit standing list) or the
 * entire batch rolls back (server returns 4xx).
 */
export async function applyClientExclusionsBatch(
  clientId: string,
  payload: ApplyClientExclusionsBatchPayload,
): Promise<ApplyClientExclusionsBatchResult> {
  const { data } = await api.post(`/clients/${encodeURIComponent(clientId)}/exclusions/batch`, payload);
  return clientExclusionsBatchResponseSchema.parse(data).data as ApplyClientExclusionsBatchResult;
}

const BULK_EXCLUSIONS_CHUNK = 1000;

/**
 * Every client- and account-level standing exclusion, firm-wide, for the CSV
 * export on the drift tab. Unpaginated by design — the whole point is a
 * complete file — so it gets the longer write-path deadline rather than the 30s
 * default.
 */
export async function fetchExclusionsExport(): Promise<ExclusionExportRow[]> {
  const { data } = await api.get('/clients/exclusions/export', { timeout: WRITE_TIMEOUT_MS });
  return exclusionExportResponseSchema.parse(data).data;
}

export async function fetchBulkClientExclusions(clientIds: string[]): Promise<Record<string, ClientExclusion[]>> {
  if (clientIds.length === 0) return {};
  const unique = [...new Set(clientIds)];
  const merged: Record<string, ClientExclusion[]> = {};
  for (let i = 0; i < unique.length; i += BULK_EXCLUSIONS_CHUNK) {
    const chunk = unique.slice(i, i + BULK_EXCLUSIONS_CHUNK);
    const { data } = await api.post('/clients/exclusions/bulk', { clientIds: chunk });
    const parsed = bulkClientExclusionsResponseSchema.parse(data);
    for (const [id, list] of Object.entries(parsed.data)) {
      merged[id] = list as ClientExclusion[];
    }
  }
  return merged;
}

export async function fetchAccountExclusions(accountId: string, signal?: AbortSignal): Promise<AccountExclusion[]> {
  const { data } = await api.post('/clients/account-exclusions/bulk', { accountIds: [accountId] }, { signal });
  const parsed = bulkAccountExclusionsResponseSchema.parse(data);
  return (parsed.data[accountId] ?? []) as AccountExclusion[];
}

export async function fetchBulkAccountExclusions(accountIds: string[]): Promise<Record<string, AccountExclusion[]>> {
  if (accountIds.length === 0) return {};
  const unique = [...new Set(accountIds)];
  const merged: Record<string, AccountExclusion[]> = {};
  for (let i = 0; i < unique.length; i += BULK_EXCLUSIONS_CHUNK) {
    const chunk = unique.slice(i, i + BULK_EXCLUSIONS_CHUNK);
    const { data } = await api.post('/clients/account-exclusions/bulk', { accountIds: chunk });
    const parsed = bulkAccountExclusionsResponseSchema.parse(data);
    for (const [id, list] of Object.entries(parsed.data)) {
      merged[id] = list as AccountExclusion[];
    }
  }
  return merged;
}

export async function applyAccountExclusionsBatch(
  accountId: string,
  payload: ApplyAccountExclusionsBatchPayload,
): Promise<ApplyAccountExclusionsBatchResult> {
  const { data } = await api.post(`/clients/account-exclusions/${encodeURIComponent(accountId)}/batch`, payload);
  return accountExclusionsBatchResponseSchema.parse(data).data as ApplyAccountExclusionsBatchResult;
}

// ─── Registry drift dashboard ────────────────────────────────────────────────

// 180 matches the server's HISTORY_MAX_DAYS and is what reaches the first
// drift runs (v1 2026-05-13, v2 2026-05-14).
export type DriftHistoryDays = 7 | 30 | 90 | 180;

export type DriftHistoryResponse = ReturnType<typeof driftHistoryResponseSchema.parse>;
export type DriftAllowListResponse = ReturnType<typeof driftAllowListResponseSchema.parse>;
export type DriftRunDetailResponse = ReturnType<typeof driftRunDetailResponseSchema.parse>;

export async function fetchDriftHistory(days: DriftHistoryDays = 30): Promise<DriftHistoryResponse> {
  const { data } = await api.get(`/drift/history?days=${days}`);
  return driftHistoryResponseSchema.parse(data);
}

export async function fetchDriftAllowList(): Promise<DriftAllowListResponse> {
  const { data } = await api.get('/drift/allow-list');
  return driftAllowListResponseSchema.parse(data);
}

export async function fetchDriftRunDetail(
  runDateLocal: string,
  householdName: string,
): Promise<DriftRunDetailResponse> {
  const { data } = await api.get(
    `/drift/runs/${encodeURIComponent(runDateLocal)}/${encodeURIComponent(householdName)}`,
  );
  return driftRunDetailResponseSchema.parse(data);
}

// ─── Drift v2 (per-account) ─────────────────────────────────────────────────

export type AccountDriftHistoryResponse = ReturnType<typeof accountDriftHistoryResponseSchema.parse>;
export type AccountDriftRunResponse = ReturnType<typeof accountDriftRunResponseSchema.parse>;
export type AccountDriftExclusionOverlapResponse = ReturnType<typeof exclusionOverlapReportSchema.parse>;

export async function fetchAccountDriftHistory(days: DriftHistoryDays = 30): Promise<AccountDriftHistoryResponse> {
  const { data } = await api.get(`/drift/v2/history?days=${days}`);
  return accountDriftHistoryResponseSchema.parse(data);
}

export async function fetchAccountDriftRun(runDateLocal: string): Promise<AccountDriftRunResponse> {
  const { data } = await api.get(`/drift/v2/runs/${encodeURIComponent(runDateLocal)}`);
  return accountDriftRunResponseSchema.parse(data);
}

export async function fetchRequestChecklist(requestId: string): Promise<PreapprovalChecklist> {
  const { data } = await api.get(`/requests/${encodeURIComponent(requestId)}/checklist`);
  return checklistResponseSchema.parse(data).checklist as PreapprovalChecklist;
}

export async function updateRequestChecklistItem(
  requestId: string,
  body: { key: ChecklistItemKey; checked: boolean; value?: string },
): Promise<PreapprovalChecklist> {
  const { data } = await api.put(`/requests/${encodeURIComponent(requestId)}/checklist`, body);
  return checklistResponseSchema.parse(data).checklist as PreapprovalChecklist;
}

export async function fetchAccountDriftAllowList(): Promise<DriftAllowListResponse> {
  const { data } = await api.get('/drift/v2/allow-list');
  return driftAllowListResponseSchema.parse(data);
}

export interface SetDriftOverrideInput {
  reason: DriftOverrideReason;
  note?: string;
  /** YYYY-MM-DD or null (no expiry). */
  expiresOn?: string | null;
}

export async function setDriftOverride(accountId: string, input: SetDriftOverrideInput) {
  const { data } = await api.put(`/drift/v2/overrides/${encodeURIComponent(accountId)}`, input);
  return setDriftOverrideResponseSchema.parse(data);
}

export async function clearDriftOverride(accountId: string): Promise<void> {
  await api.delete(`/drift/v2/overrides/${encodeURIComponent(accountId)}`);
}

export async function fetchAccountDriftExclusionOverlapAvailability(): Promise<boolean> {
  try {
    await api.head('/drift/v2/exclusion-overlap');
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return false;
    }
    throw err;
  }
}

export async function fetchAccountDriftExclusionOverlap(
  runDateLocal?: string,
): Promise<AccountDriftExclusionOverlapResponse> {
  const query = runDateLocal ? `?runDateLocal=${encodeURIComponent(runDateLocal)}` : '';
  const { data } = await api.get(`/drift/v2/exclusion-overlap${query}`);
  return exclusionOverlapReportSchema.parse(data);
}

// ─── Household resolve (firm-of-record from active_accounts.json) ───────────

export interface FetchHouseholdResolutionArgs {
  clientIds: readonly string[];
  accountIds: readonly string[];
  signal?: AbortSignal;
}

/**
 * Resolve firm-of-record households for the advisor's current selection.
 *
 * Silent-fallback contract (Decision log #2 in
 * `docs/plans/2026-q2-trade-request-householding.md`): a 503 from the
 * server means "household data is temporarily unavailable" — the caller
 * MUST treat this as "no firm household on file, proceed as today" and
 * NOT surface the error to the advisor. This shim swallows 503 and
 * resolves to an empty `HouseholdResolveResponse` so the form's behavior
 * matches the no-data path exactly.
 *
 * Schema validation failures from the server still rethrow so a bad
 * response is not silently rendered.
 *
 * All `accountIds` MUST be Apex ULIDs — the form is responsible for
 * translating its `selectedAccts` (custodian account numbers) into ULIDs
 * via `clientMap[clientId].accounts[].id` before calling this shim.
 * (Decision log #4.)
 */
export async function fetchHouseholdResolution({
  clientIds,
  accountIds,
  signal,
}: FetchHouseholdResolutionArgs): Promise<HouseholdResolveResponse> {
  const params = new URLSearchParams();
  if (clientIds.length > 0) params.set('clientIds', clientIds.join(','));
  if (accountIds.length > 0) params.set('accountIds', accountIds.join(','));
  const qs = params.toString();
  try {
    const { data } = await api.get(`/households/resolve${qs ? `?${qs}` : ''}`, { signal });
    return householdResolveResponseSchema.parse(data).data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 503) {
      // Silent-fallback contract — never propagate 503 to the form.
      // eslint-disable-next-line no-console
      console.warn('household_data_unavailable — proceeding without household sidecar', err.response?.data);
      return {
        households: [],
        unresolvedClientIds: [...clientIds],
        unresolvedAccountIds: [...accountIds],
      };
    }
    throw err;
  }
}
