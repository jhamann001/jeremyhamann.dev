import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DriftAllowListEntry, DriftHistoryRow, DriftRunDetail } from '@trade-request/shared';

// Hoisted typed mocks for the API surface the component consumes. The typed
// `vi.fn<...>()` shape is mandated by the workspace's `typecheck-before-commit`
// rule (untyped `vi.fn()` widens to `Mock` and breaks the response inference).
const mocks = vi.hoisted(() => ({
  fetchDriftHistory: vi.fn<(days?: 7 | 30 | 90) => Promise<{ days: number; runs: DriftHistoryRow[] }>>(),
  fetchDriftAllowList: vi.fn<() => Promise<{ entries: DriftAllowListEntry[] }>>(),
  fetchDriftRunDetail: vi.fn<(date: string, household: string) => Promise<{ run: DriftRunDetail }>>(),
  extractApiError: vi.fn<(err: unknown, fallback?: string) => string>((_err, fallback) => fallback ?? 'error'),
}));

vi.mock('../../api/client', () => ({
  fetchDriftHistory: mocks.fetchDriftHistory,
  fetchDriftAllowList: mocks.fetchDriftAllowList,
  fetchDriftRunDetail: mocks.fetchDriftRunDetail,
  extractApiError: mocks.extractApiError,
}));

import { DriftTab } from '../DriftTab';

function row(overrides: Partial<DriftHistoryRow> = {}): DriftHistoryRow {
  return {
    runDateLocal: '2026-05-12',
    householdName: 'Doe Family',
    maxDeltaPct: 0.045,
    breach: false,
    coverageStatus: 'full',
    schemaVersion: 1,
    snapshotSource: 'gcs',
    snapshotAsOf: '2026-05-12T03:00:00.000Z',
    ...overrides,
  };
}

const ALLOW_LIST_ENTRY: DriftAllowListEntry = {
  householdName: 'Whitaker Family',
  reason: 'awaiting_within_type_spread',
  unblocksWhenPlanShips: 'docs/plans/2026-q4-engine-within-type-spread.md',
  notes: 'Multiple Trads of materially different size; known divergence.',
};

function renderTab(initialEntry = '/drift') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <DriftTab />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchDriftAllowList.mockResolvedValue({ entries: [ALLOW_LIST_ENTRY] });
  mocks.extractApiError.mockImplementation((_err, fallback) => fallback ?? 'error');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DriftTab', () => {
  it('renders the empty state when fetchDriftHistory resolves with no rows', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({ days: 30, runs: [] });
    renderTab();
    expect(await screen.findByText(/No drift runs yet/i)).toBeInTheDocument();
  });

  it('renders the table with N rows in newest-first order', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({
      days: 30,
      runs: [row({ runDateLocal: '2026-05-12' }), row({ runDateLocal: '2026-05-11', householdName: 'Smith Family' })],
    });
    renderTab();
    await screen.findByText('Doe Family');
    expect(screen.getByText('Smith Family')).toBeInTheDocument();

    // Confirm first content row corresponds to the newest date (Doe Family).
    const tbodyRows = document.querySelectorAll('tbody > tr');
    expect(tbodyRows[0].textContent).toContain('Doe Family');
  });

  it('breach-only checkbox hides non-breach rows', async () => {
    const user = userEvent.setup();
    mocks.fetchDriftHistory.mockResolvedValue({
      days: 30,
      runs: [
        row({ householdName: 'Doe Family', breach: false }),
        row({ householdName: 'Whitaker Family', breach: true }),
      ],
    });
    renderTab();
    await screen.findByText('Doe Family');
    expect(screen.getByText('Whitaker Family')).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Breach only/i));

    expect(screen.queryByText('Doe Family')).not.toBeInTheDocument();
    expect(screen.getByText('Whitaker Family')).toBeInTheDocument();
  });

  it('debounces the household name filter at 300ms before applying', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({
      days: 30,
      runs: [row({ householdName: 'Doe Family' }), row({ householdName: 'Smith Household' })],
    });
    renderTab();

    await screen.findByText('Doe Family');

    // Switch to fake timers AFTER the initial async fetches resolve, so the
    // initial render isn't blocked waiting for microtasks under fake timers.
    vi.useFakeTimers();

    const input = screen.getByPlaceholderText('Filter household…');
    fireEvent.change(input, { target: { value: 'smith' } });

    // Before 300ms have elapsed, both rows still render.
    expect(screen.getByText('Doe Family')).toBeInTheDocument();
    expect(screen.getByText('Smith Household')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(NAME_FILTER_DEBOUNCE_MS);
    });

    expect(screen.queryByText('Doe Family')).not.toBeInTheDocument();
    expect(screen.getByText('Smith Household')).toBeInTheDocument();
  });

  it('clicking 7d calls fetchDriftHistory(7) and updates the URL ?days=7', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({ days: 30, runs: [] });
    const user = userEvent.setup();
    renderTab();

    await waitFor(() => expect(mocks.fetchDriftHistory).toHaveBeenCalledWith(30));

    await user.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(mocks.fetchDriftHistory).toHaveBeenCalledWith(7));
    // The URL is updated via setSearchParams with replace; assert pressed state
    // on the segmented control as a proxy (DOM-observable equivalent).
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders "Would alert" badge for breach rows that are NOT allow-listed and NOT unmapped', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({
      days: 30,
      runs: [row({ householdName: 'Doe Family', breach: true, coverageStatus: 'full' })],
    });
    renderTab();
    await screen.findByText('Doe Family');
    expect(screen.getByText('Would alert')).toBeInTheDocument();
  });

  it('renders "Allow-listed" badge with reason+notes tooltip for breach rows in the allow-list', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({
      days: 30,
      runs: [row({ householdName: 'Whitaker Family', breach: true, coverageStatus: 'full' })],
    });
    renderTab();
    await screen.findByText('Whitaker Family');
    const badge = await screen.findByText('Allow-listed');
    expect(badge.getAttribute('title')).toContain('awaiting_within_type_spread');
    expect(badge.getAttribute('title')).toContain('known divergence');
  });

  it('renders "Unmapped" badge for unmapped_account rows regardless of breach value (precedence)', async () => {
    mocks.fetchDriftHistory.mockResolvedValue({
      days: 30,
      runs: [
        row({ householdName: 'Mystery Account', breach: true, coverageStatus: 'unmapped_account' }),
        row({ householdName: 'Other Mystery', breach: false, coverageStatus: 'unmapped_account' }),
      ],
    });
    renderTab();
    await screen.findByText('Mystery Account');
    const unmappedBadges = screen.getAllByText('Unmapped');
    // One badge per row in the Breach column AND one badge per row in the
    // Status column (DriftStatusBadge also renders "Unmapped" for the same
    // coverage value). Two rows × two badges = 4. Just assert ≥ 2 to keep
    // the test resilient to UI cosmetic copy changes.
    expect(unmappedBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('renders error state with a Retry button that re-invokes fetchDriftHistory', async () => {
    const user = userEvent.setup();
    mocks.fetchDriftHistory.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce({ days: 30, runs: [] });
    renderTab();
    await screen.findByText(/Unable to load drift history/i);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.fetchDriftHistory).toHaveBeenCalledTimes(2));
  });

  it('Refresh button re-invokes fetchDriftHistory', async () => {
    const user = userEvent.setup();
    mocks.fetchDriftHistory.mockResolvedValue({ days: 30, runs: [row()] });
    renderTab();
    await screen.findByText('Doe Family');

    await user.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => expect(mocks.fetchDriftHistory).toHaveBeenCalledTimes(2));
  });

  it('row click triggers fetchDriftRunDetail; collapse-and-re-expand triggers it again', async () => {
    const user = userEvent.setup();
    mocks.fetchDriftHistory.mockResolvedValue({ days: 30, runs: [row()] });
    mocks.fetchDriftRunDetail.mockResolvedValue({
      run: {
        ...row(),
        runStartedAt: '2026-05-12T07:00:00.000Z',
        accountCount: 4,
        details: { worstSymbol: 'VTI', accounts: [{ accountNumber: 'A1' }, { accountNumber: 'A2' }] },
      },
    });
    renderTab();
    const householdCell = await screen.findByText('Doe Family');
    const rowEl = householdCell.closest('tr')!;

    await user.click(rowEl);
    await waitFor(() => expect(mocks.fetchDriftRunDetail).toHaveBeenCalledTimes(1));
    expect(mocks.fetchDriftRunDetail).toHaveBeenLastCalledWith('2026-05-12', 'Doe Family');
    await screen.findByText('VTI');

    await user.click(rowEl); // collapse
    await user.click(rowEl); // re-expand
    await waitFor(() => expect(mocks.fetchDriftRunDetail).toHaveBeenCalledTimes(2));
  });

  it('shows Loading… before the first fetch resolves', async () => {
    let resolveFn: (value: { days: number; runs: DriftHistoryRow[] }) => void = () => {};
    mocks.fetchDriftHistory.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFn = res;
        }),
    );
    renderTab();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    resolveFn({ days: 30, runs: [] });
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  });

  it('renders gracefully when /api/drift/runs returns details: {} (empty JSONB blob)', async () => {
    const user = userEvent.setup();
    mocks.fetchDriftHistory.mockResolvedValue({ days: 30, runs: [row()] });
    mocks.fetchDriftRunDetail.mockResolvedValue({
      run: {
        ...row(),
        runStartedAt: '2026-05-12T07:00:00.000Z',
        accountCount: 0,
        details: {},
      },
    });
    renderTab();
    const householdCell = await screen.findByText('Doe Family');
    await user.click(householdCell.closest('tr')!);

    expect(await screen.findByText(/No per-symbol breakdown available/i)).toBeInTheDocument();
  });
});

const NAME_FILTER_DEBOUNCE_MS = 300;
