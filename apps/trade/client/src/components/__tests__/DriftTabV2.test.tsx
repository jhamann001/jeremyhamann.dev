import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type {
  AccountDriftHistoryRow,
  AccountDriftRunRow,
  DriftAllowListEntry,
  ExclusionExportRow,
  ExclusionOverlapReport,
} from '@trade-request/shared';

const mocks = vi.hoisted(() => ({
  fetchAccountDriftHistory:
    vi.fn<(days?: 7 | 30 | 90 | 180) => Promise<{ days: number; runs: AccountDriftHistoryRow[] }>>(),
  fetchAccountDriftRun: vi.fn<
    (runDateLocal: string) => Promise<{
      runDateLocal: string;
      runStartedAt: string;
      snapshotSource: string;
      snapshotAsOf: string | null;
      tolerancePct: number;
      uninvestedCashThresholdPct: number;
      accounts: AccountDriftRunRow[];
    }>
  >(),
  fetchAccountDriftAllowList: vi.fn<() => Promise<{ entries: DriftAllowListEntry[] }>>(),
  fetchAccountDriftExclusionOverlapAvailability: vi.fn<() => Promise<boolean>>(),
  fetchAccountDriftExclusionOverlap: vi.fn<(runDateLocal?: string) => Promise<ExclusionOverlapReport>>(),
  fetchExclusionsExport: vi.fn<() => Promise<ExclusionExportRow[]>>(),
  setDriftOverride: vi.fn(),
  clearDriftOverride: vi.fn(),
  extractApiError: vi.fn<(err: unknown, fallback?: string) => string>((_err, fallback) => fallback ?? 'error'),
  // Configurable per test; defaults to no user (so existing tests render as a
  // non-trader and the Override column shows "—" without edit controls).
  authUser: { current: null as { role: string } | null },
}));

vi.mock('../../api/client', () => ({
  fetchAccountDriftHistory: mocks.fetchAccountDriftHistory,
  fetchAccountDriftRun: mocks.fetchAccountDriftRun,
  fetchAccountDriftAllowList: mocks.fetchAccountDriftAllowList,
  fetchAccountDriftExclusionOverlapAvailability: mocks.fetchAccountDriftExclusionOverlapAvailability,
  fetchAccountDriftExclusionOverlap: mocks.fetchAccountDriftExclusionOverlap,
  fetchExclusionsExport: mocks.fetchExclusionsExport,
  setDriftOverride: mocks.setDriftOverride,
  clearDriftOverride: mocks.clearDriftOverride,
  extractApiError: mocks.extractApiError,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.authUser.current }),
}));

import { DriftTabV2 } from '../DriftTabV2';

const RUN_DATE = '2026-05-13';

function row(overrides: Partial<AccountDriftHistoryRow> = {}): AccountDriftHistoryRow {
  return {
    runDateLocal: RUN_DATE,
    accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
    accountTitle: 'Test Account',
    householdName: 'Test Family',
    status: 'in',
    worstBucket: 'cash',
    maxBucketDeltaPct: 1.23,
    symbolBreachCount: 0,
    totalValueUsd: 100_000,
    coverage: 'both',
    snapshotSource: 'gcs',
    snapshotAsOf: '2026-05-12T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

// Canvas fixture — 12 rows matching drift-v2-mockup.canvas.tsx :59-165
// (with worstBucket/status/maxBucketDeltaPct precomputed for the v2 wire shape).
const CANVAS_ROWS: AccountDriftHistoryRow[] = [
  // Whitaker Family — Nora's Traditional IRA — equity 27.39 worst
  row({
    accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
    accountTitle: 'Nora Whitaker - Traditional IRA',
    householdName: 'Whitaker Family',
    status: 'out',
    worstBucket: 'equity',
    maxBucketDeltaPct: 27.39,
    symbolBreachCount: 2,
    totalValueUsd: 819703.74,
  }),
  // Whitaker Family — Owen's Roth IRA — equity 30.20
  row({
    accountId: '01SYNTH9NMY4NKK772YCP8WXD0',
    accountTitle: 'Owen Whitaker - Roth IRA',
    householdName: 'Whitaker Family',
    status: 'out',
    worstBucket: 'equity',
    maxBucketDeltaPct: 30.2,
    symbolBreachCount: 0,
    totalValueUsd: 432104.18,
  }),
  // Calvin Gentry — fully uninvested
  row({
    accountId: '01SYNTHNNWFNFB5PTR6N0R5J99',
    accountTitle: 'Calvin Gentry - Traditional IRA',
    householdName: 'Calvin Gentry',
    status: 'uninvested',
    worstBucket: 'cash',
    maxBucketDeltaPct: 95.0,
    symbolBreachCount: 0,
    totalValueUsd: 1_043_007.79,
  }),
  // Paige Lindell — cash bucket 8.40 worst
  row({
    accountId: '01SYNTH7JVTTYV9JBYKF4KXYKE',
    accountTitle: 'Paige Lindell - Brokerage',
    householdName: 'Paige Lindell',
    status: 'out',
    worstBucket: 'cash',
    maxBucketDeltaPct: 8.4,
    symbolBreachCount: 0,
    totalValueUsd: 921_309.26,
  }),
  // Avery — in tolerance
  row({
    accountId: '01SYNTHGY1KZ499T18HCEEXSGB',
    accountTitle: 'Simon Avery - Traditional IRA',
    householdName: 'Avery Family',
    status: 'in',
    worstBucket: 'fixed',
    maxBucketDeltaPct: 1.6,
    totalValueUsd: 1_860_995.59,
  }),
  // Hazel Moreno — fixed bucket 3.80
  row({
    accountId: '01SYNTHR8JYW52RGEP1HVKBJ5D',
    accountTitle: 'Hazel Moreno - Traditional IRA',
    householdName: 'Hazel Moreno',
    status: 'in',
    worstBucket: 'fixed',
    maxBucketDeltaPct: 3.8,
    totalValueUsd: 1_309_927.81,
  }),
  // Celia Dorsey — fixed bucket 2.07
  row({
    accountId: '01SYNTHANEES18M25ZGZ7VTZ0Q',
    accountTitle: 'Celia Dorsey - Traditional IRA',
    householdName: 'Celia Dorsey',
    status: 'in',
    worstBucket: 'fixed',
    maxBucketDeltaPct: 2.07,
    totalValueUsd: 923_435.24,
  }),
  // Brooks — cash 1.98 (in tolerance)
  row({
    accountId: '01SYNTHE78SVD2WFG6Q1GKQKM4',
    accountTitle: 'Tobias & Tessa Brooks - Joint Brokerage Companion',
    householdName: 'Brooks Family',
    status: 'in',
    worstBucket: 'cash',
    maxBucketDeltaPct: 1.98,
    totalValueUsd: 1_064_475.25,
  }),
  // Pierce — Jonah Brokerage — equity 11.49
  row({
    accountId: '01SYNTH7ARE9D2VF2TM73YPW7T',
    accountTitle: 'Jonah Pierce - Brokerage',
    householdName: 'Pierce Family',
    status: 'out',
    worstBucket: 'equity',
    maxBucketDeltaPct: 11.49,
    totalValueUsd: 1_112_605.68,
  }),
  // Pierce — Jonah IRA — fixed 3.80
  row({
    accountId: '01SYNTHQG4H8YR1SFPVEY9789V',
    accountTitle: 'Jonah Pierce - Traditional IRA',
    householdName: 'Pierce Family',
    status: 'in',
    worstBucket: 'fixed',
    maxBucketDeltaPct: 3.8,
    totalValueUsd: 876_176.83,
  }),
  // Miles Hartwell — in tolerance
  row({
    accountId: '01SYNTH5HJP4XVAXJ11PZB01CR',
    accountTitle: 'Miles Hartwell - Traditional IRA',
    householdName: 'Miles Hartwell',
    status: 'in',
    worstBucket: 'fixed',
    maxBucketDeltaPct: 1.76,
    totalValueUsd: 546_447.98,
  }),
  // Livia Conte — in tolerance
  row({
    accountId: '01SYNTH16DHD6ES03WEXCCY8MW',
    accountTitle: 'Livia Conte - Traditional IRA',
    householdName: 'Livia Conte',
    status: 'in',
    worstBucket: 'fixed',
    maxBucketDeltaPct: 1.88,
    totalValueUsd: 1_082_784.79,
  }),
];

function runDetailFor(rows: AccountDriftHistoryRow[]): {
  runDateLocal: string;
  runStartedAt: string;
  snapshotSource: string;
  snapshotAsOf: string | null;
  tolerancePct: number;
  uninvestedCashThresholdPct: number;
  accounts: AccountDriftRunRow[];
} {
  return {
    runDateLocal: RUN_DATE,
    runStartedAt: '2026-05-13T13:00:00.000Z',
    snapshotSource: 'gcs',
    snapshotAsOf: '2026-05-12T00:00:00.000Z',
    tolerancePct: 5,
    uninvestedCashThresholdPct: 99,
    accounts: rows.map((r) => ({
      ...r,
      details: {
        buckets: {
          cash: { positionPct: 0.21, templatePct: 2.0, deltaPct: 1.79 },
          fixed: { positionPct: 12.4, templatePct: 38.0, deltaPct: 25.6 },
          equity: { positionPct: 87.39, templatePct: 60.0, deltaPct: 27.39 },
        },
        symbolsWithTargets: [
          {
            symbol: '__SETTLEMENT_CASH__',
            bucket: 'cash',
            positionPct: 0.21,
            targetPct: 2.0,
            deltaPct: 1.79,
            breach: false,
          },
          { symbol: 'BND', bucket: 'fixed', positionPct: 9.28, targetPct: 26.0, deltaPct: 16.72, breach: true },
          { symbol: 'SGOV', bucket: 'fixed', positionPct: 3.12, targetPct: 12.0, deltaPct: 8.88, breach: true },
        ],
        equityHoldings: [
          { symbol: 'VOO', positionPct: 66.13 },
          { symbol: 'VEA', positionPct: 13.77 },
          { symbol: 'VWO', positionPct: 7.49 },
        ],
        positionOnlySymbols: [],
        suspectedCashEquivMisclassified: [],
      },
    })),
  };
}

function renderTab(initialEntry = '/drift') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <DriftTabV2 />
    </MemoryRouter>,
  );
}

const OVERLAP_REPORT_FIXTURE: ExclusionOverlapReport = {
  runDateLocal: RUN_DATE,
  totalAccounts: 12,
  outAccounts: 4,
  totalExclusions: 14,
  totalBreaches: 38,
  lockedTotal: 0,
  lockedSharePct: 0,
  counts: {
    actionable: 38,
    locked_blanket: 0,
    locked_dnb_under: 0,
    locked_dns_over: 0,
    sign_mismatch_unlocked: 0,
  },
  worstAccounts: [
    {
      accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
      accountTitle: 'Nora Whitaker - Traditional IRA',
      household: 'Whitaker Family',
      status: 'out',
      maxDelta: 27.39,
      breachCount: 2,
      lockedCount: 0,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAccountDriftAllowList.mockResolvedValue({ entries: [] });
  mocks.fetchAccountDriftExclusionOverlapAvailability.mockResolvedValue(false);
  mocks.fetchAccountDriftExclusionOverlap.mockResolvedValue(OVERLAP_REPORT_FIXTURE);
  mocks.extractApiError.mockImplementation((_err, fallback) => fallback ?? 'error');
  mocks.authUser.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DriftTabV2', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Case 0 (regression): /api/drift/v2/history returns the latest run from
  // EACH date in its window (HISTORY_SQL groups by run_date_local), so when
  // two distinct dates have data the same account appears twice on the wire
  // — once per date. The UI must collapse to the latest run-date only;
  // every downstream surface (summary tiles, accounts table, "Showing X of
  // Y" denominator, household grouping) inherits that narrowing.
  // ──────────────────────────────────────────────────────────────────────────
  it('dedupes rows by latest run_date_local — earlier-date duplicates never reach the table or summary tiles', async () => {
    const SAME_ACCOUNT_ID = '01SYNTHNQTDVG6RNQ8TPY28EEX';
    const earlierRow = row({
      runDateLocal: '2026-05-13',
      accountId: SAME_ACCOUNT_ID,
      accountTitle: 'Nora Whitaker - Traditional IRA',
      // Distinct household + total + delta so the earlier-date version is
      // queryable independently of the later one.
      householdName: 'Stale Household',
      status: 'in',
      worstBucket: 'fixed',
      maxBucketDeltaPct: 4.21,
      totalValueUsd: 700_000,
    });
    const laterRow = row({
      runDateLocal: '2026-05-14',
      accountId: SAME_ACCOUNT_ID,
      accountTitle: 'Nora Whitaker - Traditional IRA',
      householdName: 'Whitaker Family',
      status: 'out',
      worstBucket: 'equity',
      maxBucketDeltaPct: 27.39,
      totalValueUsd: 819_703.74,
    });
    // A second account on the EARLIER date only — it must not appear in
    // the table, because the latest-run-date for the payload is 2026-05-14
    // and this account has no row on that date.
    const earlierOnlyRow = row({
      runDateLocal: '2026-05-13',
      accountId: '01OLD1OLD1OLD1OLD1OLD1OLD1',
      accountTitle: 'Old Date Only Account',
      householdName: 'Stale Household',
      status: 'out',
      worstBucket: 'cash',
      maxBucketDeltaPct: 12.5,
      totalValueUsd: 250_000,
    });
    mocks.fetchAccountDriftHistory.mockResolvedValue({
      days: 30,
      runs: [earlierRow, laterRow, earlierOnlyRow],
    });
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    // Only ONE row for the same accountId — the later-date one. The
    // accountId text is rendered exactly once in the table.
    const ulidMatches = screen.getAllByText(SAME_ACCOUNT_ID);
    expect(ulidMatches).toHaveLength(1);

    // The later-date markers (Whitaker Family household, "out" status pill,
    // 27.39 Δpp, $820K) are present.
    expect(screen.getByText('Whitaker Family')).toBeInTheDocument();
    expect(screen.getByText('27.39')).toBeInTheDocument();

    // The earlier-date markers must NOT be in the document. "Stale
    // Household" was unique to the 2026-05-13 rows; if dedupe regresses,
    // that string would render in the household column.
    expect(screen.queryByText('Stale Household')).not.toBeInTheDocument();
    expect(screen.queryByText('4.21')).not.toBeInTheDocument();

    // The earlier-only account (no row on 2026-05-14) is hidden entirely.
    expect(screen.queryByText('Old Date Only Account')).not.toBeInTheDocument();
    expect(screen.queryByText('01OLD1OLD1OLD1OLD1OLD1OLD1')).not.toBeInTheDocument();

    // Summary tiles are sourced from the latest run only — exactly one
    // account, exactly one out-of-tolerance, worst Δ = 27.39%.
    expect(screen.getByText('Accounts compared')).toBeInTheDocument();
    expect(screen.getByText('27.39%')).toBeInTheDocument();
    // The "Accounts compared" tile shows "1" — the single latest-date row.
    // The label sits in its own <div>, so we walk up to the tile container
    // (the next ancestor div) to scope the assertion to that one tile.
    const accountsTile = screen.getByText('Accounts compared').parentElement;
    expect(accountsTile).not.toBeNull();
    expect(accountsTile!.textContent).toContain('1');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 0b: the history-window control is LIVE again.
  //
  // It was retired when v2 shipped, on the rationale that the tab "only renders
  // the latest run-date cohort" so a window was pointless. That premise no
  // longer holds — v2 since gained a run-date picker (`availableRunDates`), and
  // the fixed 30-day window was capping that picker ~30 days back, hiding every
  // earlier run. Rows are never pruned, so the history was always on disk.
  // Default stays 30; longer windows are opt-in because the tab holds the whole
  // payload in memory.
  // ──────────────────────────────────────────────────────────────────────────
  it('renders the history-window control and fetches the default 30-day window', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab('/drift');
    await screen.findByText('Nora Whitaker - Traditional IRA');

    expect(mocks.fetchAccountDriftHistory).toHaveBeenCalledWith(30);
    const select = screen.getByRole('combobox', { name: 'History window in days' });
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      '7 days',
      '30 days',
      '90 days',
      '180 days',
    ]);
  });

  it('honors a days param from the URL on first load', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 7, runs: CANVAS_ROWS });
    renderTab('/drift?days=7');
    await screen.findByText('Nora Whitaker - Traditional IRA');

    expect(mocks.fetchAccountDriftHistory).toHaveBeenCalledWith(7);
  });

  it('falls back to the 30-day default when the URL days value is not an option', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab('/drift?days=9999');
    await screen.findByText('Nora Whitaker - Traditional IRA');

    expect(mocks.fetchAccountDriftHistory).toHaveBeenCalledWith(30);
  });

  it('refetches with the longest window when the user selects 180 days', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab('/drift');
    await screen.findByText('Nora Whitaker - Traditional IRA');
    expect(mocks.fetchAccountDriftHistory).toHaveBeenCalledWith(30);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'History window in days' }), '180');

    await waitFor(() => expect(mocks.fetchAccountDriftHistory).toHaveBeenCalledWith(180));
  });

  it('hides the diagnostic button when overlap endpoint probe returns unavailable', async () => {
    mocks.fetchAccountDriftExclusionOverlapAvailability.mockResolvedValue(false);
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });

    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    expect(screen.queryByRole('button', { name: 'Check exclusion overlap' })).not.toBeInTheDocument();
  });

  it('shows diagnostic button when available, opens modal, and loads overlap report', async () => {
    mocks.fetchAccountDriftExclusionOverlapAvailability.mockResolvedValue(true);
    mocks.fetchAccountDriftExclusionOverlap.mockResolvedValue(OVERLAP_REPORT_FIXTURE);
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();

    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.click(screen.getByRole('button', { name: 'Check exclusion overlap' }));

    expect(mocks.fetchAccountDriftExclusionOverlap).toHaveBeenCalledWith(RUN_DATE);
    const dialog = await screen.findByRole('dialog', { name: 'Exclusion overlap diagnostic' });
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByText('Lock classification')).toBeInTheDocument();
    expect(within(dialog).getByText('01SYNTHNQTDVG6RNQ8TPY28EEX')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Exclusion overlap diagnostic' })).not.toBeInTheDocument();
    });
    expect(document.body.style.overflow).toBe('');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 1: rows render sorted by Δpp DESC
  // ──────────────────────────────────────────────────────────────────────────
  it('renders the Accounts view with rows sorted by Δpp DESC', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab();
    await screen.findByText('Owen Whitaker - Roth IRA');

    const titles = screen.getAllByText(
      /Whitaker Family|Calvin Gentry|Paige Lindell|Avery|Moreno|Dorsey|Brooks|Pierce|Hartwell|Conte/,
    );
    expect(titles.length).toBeGreaterThan(0);

    // Δpp DESC: 95.0 Calvin first, then 30.20 Owen, then 27.39 Nora
    const dpps = screen.getAllByText(/^(\d+\.\d{2})$/);
    const numbers = dpps.map((el) => parseFloat(el.textContent ?? ''));
    expect(numbers[0]).toBe(95.0);
    expect(numbers[1]).toBe(30.2);
    expect(numbers[2]).toBe(27.39);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 1b: full 26-char ULID renders in the row (no `…<last6>` truncation).
  // Slack alerts intentionally keep the short form — see plan §3 / §4.6 in
  // docs/plans/2026-q3-drift-v2-account-titles.md.
  // ──────────────────────────────────────────────────────────────────────────
  it('renders the full 26-char ULID under each account title in the Accounts view', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab();
    // CANVAS_ROWS contains exactly one Whitaker Traditional IRA row (the
    // default `view='accounts'` render mode shows each ULID once).
    const whitakerUlid = await screen.findByText('01SYNTHNQTDVG6RNQ8TPY28EEX');
    expect(whitakerUlid).toBeInTheDocument();

    // Every CANVAS_ROW ULID must show up in canonical 26-char ULID shape.
    const ulidEls = screen.getAllByText(/^01[A-Z0-9]{24}$/);
    expect(ulidEls.length).toBe(CANVAS_ROWS.length);
    for (const el of ulidEls) {
      expect(el.textContent).toHaveLength(26);
      expect(el.textContent?.startsWith('…')).toBe(false);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 2: households view groups by household; cards are COLLAPSED by
  // default (the prior "auto-expand on issue" behavior was retired so a
  // busy run no longer dumps 100+ rows on the user). Click expands.
  // ──────────────────────────────────────────────────────────────────────────
  it('toggling to Households groups by household with cards collapsed by default; click expands', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.click(screen.getByRole('button', { name: 'households' }));

    // Whitaker Family header is visible, but its accounts are NOT — the card
    // ships collapsed even though it carries out-of-tolerance members.
    await waitFor(() => expect(screen.getByText('Whitaker Family')).toBeInTheDocument());
    expect(screen.queryByText('Nora Whitaker - Traditional IRA')).not.toBeInTheDocument();
    expect(screen.queryByText('Owen Whitaker - Roth IRA')).not.toBeInTheDocument();

    // Header pill still surfaces the "out" count for the collapsed card.
    expect(screen.getAllByText(/of \d+ out · max/i).length).toBeGreaterThan(0);

    // Clicking the header expands and exposes both member accounts.
    await user.click(screen.getByRole('button', { expanded: false, name: /Whitaker Family/ }));
    expect(screen.getByText('Nora Whitaker - Traditional IRA')).toBeInTheDocument();
    expect(screen.getByText('Owen Whitaker - Roth IRA')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 3: status filter 'out' hides 'in' and 'uninvested'
  // ──────────────────────────────────────────────────────────────────────────
  it("status filter 'out' hides in and uninvested rows", async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.selectOptions(screen.getByLabelText('Status filter'), 'out');

    // Whitaker out account remains visible.
    expect(screen.getByText('Nora Whitaker - Traditional IRA')).toBeInTheDocument();
    // In-tolerance Miles Hartwell is hidden.
    expect(screen.queryByText('Miles Hartwell - Traditional IRA')).not.toBeInTheDocument();
    // Uninvested Calvin Gentry is hidden.
    expect(screen.queryByText('Calvin Gentry - Traditional IRA')).not.toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 4: status filter 'uninvested' shows only uninvested
  // ──────────────────────────────────────────────────────────────────────────
  it("status filter 'uninvested' hides all non-uninvested rows", async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.selectOptions(screen.getByLabelText('Status filter'), 'uninvested');

    expect(screen.getByText('Calvin Gentry - Traditional IRA')).toBeInTheDocument();
    expect(screen.queryByText('Nora Whitaker - Traditional IRA')).not.toBeInTheDocument();
    expect(screen.queryByText('Miles Hartwell - Traditional IRA')).not.toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Data-quality lanes (R1 negligible / R2 template_invalid)
  // ──────────────────────────────────────────────────────────────────────────
  it('hides negligible + template_invalid rows by default and reveals them via the toggle', async () => {
    const rows = [
      row({
        accountId: '01OUT0000000000000000000AA',
        accountTitle: 'Real Drift Acct',
        status: 'out',
        maxBucketDeltaPct: 12,
      }),
      row({
        accountId: '01NEG0000000000000000000BB',
        accountTitle: 'Dust Acct',
        status: 'negligible',
        totalValueUsd: 3,
        maxBucketDeltaPct: null,
      }),
      row({
        accountId: '01TPL0000000000000000000CC',
        accountTitle: 'Bad Template Acct',
        status: 'template_invalid',
        maxBucketDeltaPct: 60.21,
        templateTotalPct: 72,
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Real Drift Acct');

    // Hidden by default.
    expect(screen.queryByText('Dust Acct')).not.toBeInTheDocument();
    expect(screen.queryByText('Bad Template Acct')).not.toBeInTheDocument();

    // Toggle reveals both.
    await user.click(screen.getByLabelText('Show data-quality accounts'));
    expect(screen.getByText('Dust Acct')).toBeInTheDocument();
    expect(screen.getByText('Bad Template Acct')).toBeInTheDocument();
    // The template_invalid row surfaces the malformed-template sum and its
    // (untrustworthy) delta is still rendered ("keep drift, mark invalid").
    expect(screen.getByText(/Template sums to 72%/)).toBeInTheDocument();
    expect(screen.getByText('60.21')).toBeInTheDocument();
  });

  it("status filter 'template_invalid' shows only template-error rows", async () => {
    const rows = [
      row({
        accountId: '01OUT0000000000000000000AA',
        accountTitle: 'Real Drift Acct',
        status: 'out',
        maxBucketDeltaPct: 12,
      }),
      row({
        accountId: '01TPL0000000000000000000CC',
        accountTitle: 'Bad Template Acct',
        status: 'template_invalid',
        maxBucketDeltaPct: 60.21,
        templateTotalPct: 72,
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Real Drift Acct');

    await user.selectOptions(screen.getByLabelText('Status filter'), 'template_invalid');
    expect(screen.getByText('Bad Template Acct')).toBeInTheDocument();
    expect(screen.queryByText('Real Drift Acct')).not.toBeInTheDocument();
  });

  it('renders resizable column grips and a reset control on the Accounts table', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');
    // One resize grip per resizable column (every column except the fixed
    // expander) — proves the resizable header is wired.
    expect(screen.getAllByLabelText('Resize column').length).toBe(10);
    expect(screen.getByRole('button', { name: 'Reset column widths' })).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Manual status overrides
  // ──────────────────────────────────────────────────────────────────────────
  it('shows a "Set override" control for traders and "—" for non-traders', async () => {
    const rows = [
      row({ accountId: '01OUT0000000000000000000AA', accountTitle: 'Drifty', status: 'out', maxBucketDeltaPct: 12 }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });

    // Non-trader (default): no set control.
    const { unmount } = renderTab();
    await screen.findByText('Drifty');
    expect(screen.queryByRole('button', { name: 'Set override' })).not.toBeInTheDocument();
    unmount();

    // Trader: set control present.
    mocks.authUser.current = { role: 'trader' };
    renderTab();
    await screen.findByText('Drifty');
    expect(screen.getAllByRole('button', { name: 'Set override' }).length).toBeGreaterThan(0);
  });

  it('renders the override badge and excludes an overridden account from the out-of-tolerance count', async () => {
    const rows = [
      row({
        accountId: '01OUT0000000000000000000AA',
        accountTitle: 'Real Drift',
        status: 'out',
        maxBucketDeltaPct: 12,
      }),
      row({
        accountId: '01OVR0000000000000000000BB',
        accountTitle: 'Accepted Acct',
        status: 'out',
        maxBucketDeltaPct: 40,
        override: {
          reason: 'tax_constraint',
          note: 'big gains',
          expiresOn: null,
          setByName: 'Jeremy Hamann',
          setAt: '2026-06-22T00:00:00.000Z',
        },
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    renderTab();
    await screen.findByText('Accepted Acct');

    // Badge uses the short reason label.
    expect(screen.getByText(/Tax-constrained/)).toBeInTheDocument();
    // The overridden account (Δ 40) is excluded from the worst-Δ headline, so
    // the worst tile reflects the only actionable 'out' row (Δ 12), not 40.
    expect(screen.getByText('12.00%')).toBeInTheDocument();
    expect(screen.queryByText('40.00%')).not.toBeInTheDocument();
  });

  it('suggests an R5 tax-constraint override on a high-gain out account and accepts it in one click', async () => {
    mocks.authUser.current = { role: 'trader' };
    mocks.setDriftOverride.mockResolvedValue({ accountId: 'x', override: {} });
    const rows = [
      row({
        accountId: '01GAIN000000000000000000AA',
        accountTitle: 'Big Gains',
        status: 'out',
        maxBucketDeltaPct: 9,
        totalValueUsd: 1_000_000,
        unrealizedGainUsd: 240_000, // ≥ $50k and ≥ 15%
        taxable: true,
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Big Gains');

    expect(screen.getByText(/Likely Tax-constrained/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(mocks.setDriftOverride).toHaveBeenCalledWith(
      '01GAIN000000000000000000AA',
      expect.objectContaining({ reason: 'tax_constraint' }),
    );
  });

  it('suggests R3 active-transition (precedence) on a confirmed-transition out account', async () => {
    mocks.authUser.current = { role: 'trader' };
    const rows = [
      row({
        accountId: '01TXN0000000000000000000AA',
        accountTitle: 'Mid Transition',
        status: 'out',
        maxBucketDeltaPct: 30,
        totalValueUsd: 1_000_000,
        unrealizedGainUsd: 240_000, // would also trip R5, but transition wins
        transitionConfirmed: true,
        transferInPct: 60,
        taxable: true,
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    renderTab();
    await screen.findByText('Mid Transition');
    expect(screen.getByText(/Likely In transition/)).toBeInTheDocument();
  });

  it('does not suggest an override on an in-tolerance account or one already overridden', async () => {
    mocks.authUser.current = { role: 'trader' };
    const rows = [
      // in-tolerance with big gains → no suggestion (not actionable)
      row({
        accountId: '01IN00000000000000000000AA',
        accountTitle: 'Calm',
        status: 'in',
        unrealizedGainUsd: 500_000,
        taxable: true,
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    renderTab();
    await screen.findByText('Calm');
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('does NOT suggest a tax-constraint override on a NON-taxable (IRA) account with big gains', async () => {
    mocks.authUser.current = { role: 'trader' };
    const rows = [
      row({
        accountId: '01IRA0000000000000000000AA',
        accountTitle: 'Roth IRA — big gains',
        status: 'out',
        maxBucketDeltaPct: 12,
        totalValueUsd: 1_000_000,
        unrealizedGainUsd: 300_000, // would trip R5 if it were taxable
        taxable: false,
      }),
    ];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    renderTab();
    await screen.findByText('Roth IRA — big gains');
    // No suggestion — selling in an IRA realizes no capital gains, so there's
    // no tax constraint. The trader can still set a manual override.
    expect(screen.queryByText(/Likely Tax-constrained/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set override' })).toBeInTheDocument();
  });

  it('offers a re-check date on any override reason (not just active transition)', async () => {
    mocks.authUser.current = { role: 'trader' };
    const rows = [row({ accountId: '01SET0000000000000000000AA', accountTitle: 'Settable', status: 'in' })];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: rows });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Settable');

    await user.click(screen.getByRole('button', { name: 'Set override' }));
    // A non-transition reason still exposes the re-check date field.
    await user.selectOptions(screen.getByLabelText('Override reason'), 'tax_constraint');
    expect(screen.getByLabelText('Override expiry date')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 5: bucket filter 'equity' keeps only equity-worst rows
  // ──────────────────────────────────────────────────────────────────────────
  it("bucket filter 'equity' keeps only rows whose worstBucket === 'equity'", async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.selectOptions(screen.getByLabelText('Worst bucket filter'), 'equity');

    // Equity-worst accounts.
    expect(screen.getByText('Nora Whitaker - Traditional IRA')).toBeInTheDocument();
    expect(screen.getByText('Owen Whitaker - Roth IRA')).toBeInTheDocument();
    expect(screen.getByText('Jonah Pierce - Brokerage')).toBeInTheDocument();
    // Cash/fixed worst rows are hidden.
    expect(screen.queryByText('Paige Lindell - Brokerage')).not.toBeInTheDocument();
    expect(screen.queryByText('Calvin Gentry - Traditional IRA')).not.toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 6: household text input debounces 300ms and narrows case-insensitively
  // ──────────────────────────────────────────────────────────────────────────
  it('household text input debounces 300ms and narrows case-insensitively', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.type(screen.getByLabelText('Filter household'), 'whitaker');
    // Before debounce fires, all rows still visible.
    expect(screen.getByText('Calvin Gentry - Traditional IRA')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(screen.queryByText('Calvin Gentry - Traditional IRA')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Nora Whitaker - Traditional IRA')).toBeInTheDocument();
    expect(screen.getByText('Owen Whitaker - Roth IRA')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 7: clicking a row expands the inline drilldown with the three subsections
  // ──────────────────────────────────────────────────────────────────────────
  it('clicking a row reveals the per-bucket, per-symbol, and equity-holdings sections', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    mocks.fetchAccountDriftRun.mockResolvedValue(runDetailFor(CANVAS_ROWS));
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.click(screen.getByText('Nora Whitaker - Traditional IRA'));

    await screen.findByText('Per-bucket comparison');
    expect(screen.getByText(/Per-symbol breakdown — cash/)).toBeInTheDocument();
    expect(screen.getByText('Equity holdings (rolled up to bucket)')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 8: summary strip
  // ──────────────────────────────────────────────────────────────────────────
  it('displays the four summary tiles sourced from the latest run', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    expect(screen.getByText('Accounts compared')).toBeInTheDocument();
    // "Out of tolerance" appears in summary tile, status filter dropdown, and
    // status pills — assert via getAllByText that at least the tile label
    // (under a strict uppercase-tracked element) is present.
    expect(screen.getAllByText('Out of tolerance').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Uninvested').length).toBeGreaterThan(0);
    expect(screen.getByText('Worst Δ (out of tol.)')).toBeInTheDocument();

    // 12 total accounts. Calvin is 'uninvested' so the uninvested tile = 1.
    // Worst Δ (out of tol.) = 30.20 (Owen Whitaker, the worst 'out' account).
    // Calvin's 95.00 is 'uninvested' (newly funded, parked in cash) and is
    // correctly EXCLUDED — it isn't drifted, just not invested yet.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('30.20%')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 9: empty-state copy when all filters produce zero rows
  // ──────────────────────────────────────────────────────────────────────────
  it('renders the empty-state copy when all filters produce zero matching rows', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.type(screen.getByLabelText('Filter household'), 'no-such-household-anywhere');
    act(() => {
      vi.advanceTimersByTime(350);
    });

    await screen.findByText(/No accounts match this filter/i);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 10: B3 percent-scale regression guard + S4 em-dash for worstBucket=null
  // ──────────────────────────────────────────────────────────────────────────
  it('renders percent-scale values without ×100 multiplication AND em-dash for null worstBucket', async () => {
    // Drilldown fixture mirrors the canvas Whitaker-Family row precisely
    // (positions 0.21/12.40/87.39, templates 2/38/60, Δpp 27.39). The test
    // FAILS if anything multiplies — e.g. 0.21 → 21.00%.
    const whitakerRow = row({
      accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
      accountTitle: 'Nora Whitaker - Traditional IRA',
      householdName: 'Whitaker Family',
      status: 'out',
      worstBucket: 'equity',
      maxBucketDeltaPct: 27.39,
      totalValueUsd: 819_703.74,
    });
    const zeroValueRow = row({
      accountId: '01ZEROVALUEZEROVALUEZEROZZ',
      accountTitle: 'Zero Value Edge Case',
      householdName: 'Zero Household',
      status: 'in',
      worstBucket: null,
      maxBucketDeltaPct: 0,
      totalValueUsd: 0,
    });

    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: [whitakerRow, zeroValueRow] });
    mocks.fetchAccountDriftRun.mockResolvedValue({
      runDateLocal: RUN_DATE,
      runStartedAt: '2026-05-13T13:00:00.000Z',
      snapshotSource: 'gcs',
      snapshotAsOf: '2026-05-12T00:00:00.000Z',
      tolerancePct: 5,
      uninvestedCashThresholdPct: 99,
      accounts: [
        {
          ...whitakerRow,
          details: {
            buckets: {
              cash: { positionPct: 0.21, templatePct: 2.0, deltaPct: 1.79 },
              fixed: { positionPct: 12.4, templatePct: 38.0, deltaPct: 25.6 },
              equity: { positionPct: 87.39, templatePct: 60.0, deltaPct: 27.39 },
            },
            symbolsWithTargets: [],
            equityHoldings: [],
            positionOnlySymbols: [],
            suspectedCashEquivMisclassified: [],
          },
        },
      ],
    });

    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    // S4 fix — em-dash for worstBucket=null. The zero-value row renders an
    // em-dash in its Worst-bucket column (and the table should still mount
    // without crashing).
    const emDashes = screen.getAllByText('—');
    expect(emDashes.length).toBeGreaterThan(0);

    // Expand the Whitaker drilldown.
    await user.click(screen.getByText('Nora Whitaker - Traditional IRA'));
    await screen.findByText('Per-bucket comparison');

    // B3 fix — percent-scale rendering. The canvas literal numbers MUST
    // render verbatim; anything multiplied by 100 (e.g. 0.21 → 21.00%)
    // would fail the equality below.
    expect(screen.getByText('0.21%')).toBeInTheDocument();
    expect(screen.getByText('12.40%')).toBeInTheDocument();
    expect(screen.getByText('87.39%')).toBeInTheDocument();
    expect(screen.getByText('2.00%')).toBeInTheDocument();
    expect(screen.getByText('38.00%')).toBeInTheDocument();
    expect(screen.getByText('60.00%')).toBeInTheDocument();
    // 27.39 is rendered in the table without the percent sign (it's a Δpp
    // value), but the headline summary tile DOES use formatPct(worst Δ).
    expect(screen.getByText('27.39%')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 11: sort dropdown — toggling Δpp DESC → ASC flips the first row
  // ──────────────────────────────────────────────────────────────────────────
  it('sort dropdown changes the row order (Δpp DESC → Δpp ASC moves smallest delta to the top)', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    // Default sort is Δpp DESC — Calvin Gentry (95.00) is the largest delta
    // in the canvas fixture and must be the first numeric Δpp cell.
    let dpps = screen.getAllByText(/^(\d+\.\d{2})$/);
    expect(parseFloat(dpps[0].textContent ?? '')).toBe(95.0);

    // Switch to Δpp ASC — the smallest delta (Avery, 1.60) leads.
    await user.selectOptions(screen.getByLabelText('Sort accounts'), 'delta_asc');

    dpps = screen.getAllByText(/^(\d+\.\d{2})$/);
    expect(parseFloat(dpps[0].textContent ?? '')).toBe(1.6);
    // And Calvin Gentry (95.00) drops to the very end.
    expect(parseFloat(dpps[dpps.length - 1].textContent ?? '')).toBe(95.0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 12: account title text search filters by row.accountTitle
  // ──────────────────────────────────────────────────────────────────────────
  it('account title text input filters rows by accountTitle (debounced, case-insensitive)', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    // "calvin" should narrow to Calvin Gentry only — the household text
    // filter is independent, so this exercises the account-title path.
    await user.type(screen.getByLabelText('Filter account title'), 'calvin');
    act(() => {
      vi.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(screen.queryByText('Nora Whitaker - Traditional IRA')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Calvin Gentry - Traditional IRA')).toBeInTheDocument();
    expect(screen.queryByText('Owen Whitaker - Roth IRA')).not.toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 13: min Δpp filter at "> 5" hides rows with deltaPct ≤ 5
  // ──────────────────────────────────────────────────────────────────────────
  it('min Δpp filter at >5 hides accounts with maxBucketDeltaPct ≤ 5', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.selectOptions(screen.getByLabelText('Minimum Δpp filter'), '5');

    // Rows with Δpp > 5 (Calvin 95.0, Owen 30.2, Nora 27.39, Jonah
    // Brokerage 11.49, Paige 8.40) stay visible.
    expect(screen.getByText('Calvin Gentry - Traditional IRA')).toBeInTheDocument();
    expect(screen.getByText('Nora Whitaker - Traditional IRA')).toBeInTheDocument();
    expect(screen.getByText('Paige Lindell - Brokerage')).toBeInTheDocument();

    // Rows with Δpp ≤ 5 (Miles 1.76, Livia 1.88, Brooks 1.98,
    // Celia 2.07, Hazel 3.80, Jonah IRA 3.80, Avery 1.60) are hidden.
    expect(screen.queryByText('Miles Hartwell - Traditional IRA')).not.toBeInTheDocument();
    expect(screen.queryByText('Livia Conte - Traditional IRA')).not.toBeInTheDocument();
    expect(screen.queryByText('Simon Avery - Traditional IRA')).not.toBeInTheDocument();

    // Summary tiles (count chips) keep showing the full-run totals — they
    // intentionally don't change with the min-Δpp filter. The "12" tile
    // is still in the DOM.
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 14: households view ships collapsed by default (focused assertion
  // separate from Case 2's broader expand-on-click flow)
  // ──────────────────────────────────────────────────────────────────────────
  it('households view: every card renders collapsed by default — no account-row text is in the document', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.click(screen.getByRole('button', { name: 'households' }));

    // Wait for the Households view to mount (Whitaker Family header).
    await waitFor(() => expect(screen.getByText('Whitaker Family')).toBeInTheDocument());

    // Even the card with out-of-tolerance accounts (Whitaker Family) does NOT
    // expose its members on first render. Same for the uninvested
    // single-member household (Calvin Gentry).
    expect(screen.queryByText('Nora Whitaker - Traditional IRA')).not.toBeInTheDocument();
    expect(screen.queryByText('Owen Whitaker - Roth IRA')).not.toBeInTheDocument();
    expect(screen.queryByText('Calvin Gentry - Traditional IRA')).not.toBeInTheDocument();

    // The household headers (and their summary pills) themselves remain
    // visible so the user can choose what to expand.
    expect(screen.getByText('Calvin Gentry')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Helper for the adaptive-tile cases below. Tile structure is:
  //   <div container><div value/><div label/></div>
  // The label text ("Out of tolerance", "Uninvested", "No template") also
  // appears in status-pill spans and dropdown <option> nodes, so we narrow
  // by tagName === 'DIV' to land on the tile label and then walk back to
  // its preceding-sibling value div. "Accounts compared" / "Worst Δ on the
  // book" labels are unique to the tile but the helper keeps the read sites
  // uniform.
  // ──────────────────────────────────────────────────────────────────────────
  function getTileValue(label: string): string {
    const labelDiv = screen.getAllByText(label).find((el) => el.tagName === 'DIV');
    if (!labelDiv) throw new Error(`Tile label div not found: ${label}`);
    const valueDiv = labelDiv.previousElementSibling;
    if (!valueDiv) throw new Error(`Tile value not found for label: ${label}`);
    return valueDiv.textContent ?? '';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Case 15: no_template rows render the No template pill, em-dash for Δpp,
  // appear in the No template stat tile, and survive the "No template only"
  // status filter
  // ──────────────────────────────────────────────────────────────────────────
  it('no_template rows render with the No template pill, em-dash Δpp, and feed the No template stat tile + filter', async () => {
    // Synthetic fixture: one canvas row + one no_template row sourced from
    // an account that has positions + a household but no Meridian
    // allocation target. We want to verify (a) the pill says "No template",
    // (b) the Δpp column collapses to em-dash, (c) the summary tile counts
    // it, and (d) the status filter "no_template" narrows the table to it.
    const NO_TEMPLATE_ROW: AccountDriftHistoryRow = row({
      accountId: '01HGTPL9999999999999999999',
      accountTitle: 'Templateless Trust - Brokerage',
      householdName: 'Some Other Household',
      status: 'no_template',
      worstBucket: null,
      maxBucketDeltaPct: null,
      symbolBreachCount: 0,
      totalValueUsd: 250_000,
      coverage: 'positions_only',
    });
    const FIXTURE = [CANVAS_ROWS[0], NO_TEMPLATE_ROW];
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: FIXTURE });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Templateless Trust - Brokerage');

    // Pill: at least one "No template" label appears (the row pill + the
    // summary tile label both contain that string).
    expect(screen.getAllByText('No template').length).toBeGreaterThan(0);

    // Δpp column on the no_template row collapses to em-dash. The row is
    // identified by its unique account title; the em-dash sits in the
    // same <tr> as the matching <td>.
    const titleCell = screen.getByText('Templateless Trust - Brokerage');
    const titleRow = titleCell.closest('tr');
    expect(titleRow).not.toBeNull();
    expect(titleRow!.textContent).toContain('—');

    // "No template only" filter narrows the visible table to the
    // no_template row. The canvas row (Nora) drops out.
    await user.selectOptions(screen.getByLabelText('Status filter'), 'no_template');
    expect(screen.queryByText('Nora Whitaker - Traditional IRA')).not.toBeInTheDocument();
    expect(screen.getByText('Templateless Trust - Brokerage')).toBeInTheDocument();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 16 (adaptive tiles): status filter = out narrows ALL five tiles to
  // the OOT cohort. Out-tile mirrors the visible row count, the inactive-
  // status tiles (Uninvested, No template) collapse to 0, and Worst Δ
  // tracks the max delta among OOT rows only.
  // ──────────────────────────────────────────────────────────────────────────
  it('status filter = out: all tiles adapt to the OOT cohort (Worst Δ = max OOT delta)', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.selectOptions(screen.getByLabelText('Status filter'), 'out');

    // CANVAS_ROWS has 4 OOT accounts: Nora 27.39, Owen 30.20, Paige
    // 8.40, Jonah Brokerage 11.49. Calvin (uninvested) and the in-
    // tolerance rows drop out of every tile.
    expect(getTileValue('Accounts compared')).toBe('4');
    expect(getTileValue('Out of tolerance')).toBe('4');
    expect(getTileValue('Uninvested')).toBe('0');
    expect(getTileValue('No template')).toBe('0');
    expect(getTileValue('Worst Δ (out of tol.)')).toBe('30.20%');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 17 (adaptive tiles): status filter = no_template renders an em-dash
  // in Worst Δ instead of `0%` because every cohort row has a null Δpp.
  // ──────────────────────────────────────────────────────────────────────────
  it('status filter = no_template: Worst Δ tile renders em-dash (no measurable Δpp in cohort)', async () => {
    const NO_TEMPLATE_ROW: AccountDriftHistoryRow = row({
      accountId: '01HGTPL9999999999999999999',
      accountTitle: 'Templateless Trust - Brokerage',
      householdName: 'Some Other Household',
      status: 'no_template',
      worstBucket: null,
      maxBucketDeltaPct: null,
      symbolBreachCount: 0,
      totalValueUsd: 250_000,
      coverage: 'positions_only',
    });
    mocks.fetchAccountDriftHistory.mockResolvedValue({
      days: 30,
      runs: [CANVAS_ROWS[0], NO_TEMPLATE_ROW],
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Templateless Trust - Brokerage');

    await user.selectOptions(screen.getByLabelText('Status filter'), 'no_template');

    expect(getTileValue('Accounts compared')).toBe('1');
    expect(getTileValue('No template')).toBe('1');
    expect(getTileValue('Out of tolerance')).toBe('0');
    expect(getTileValue('Uninvested')).toBe('0');
    // The Worst Δ tile renders the em-dash literal (not "0.00%" and not
    // "0%") because the only cohort row has `maxBucketDeltaPct === null`.
    expect(getTileValue('Worst Δ (out of tol.)')).toBe('—');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 18 (adaptive tiles): bucket filter = cash narrows tiles to the
  // cash-bucket-worst cohort.
  // ──────────────────────────────────────────────────────────────────────────
  it('bucket filter = cash: tiles reflect only cash-bucket-worst rows; Worst Δ = max among them', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    await user.selectOptions(screen.getByLabelText('Worst bucket filter'), 'cash');

    // Cash-worst cohort: Calvin (uninvested, 95.00), Paige (out, 8.40),
    // Brooks (in, 1.98). Three rows total. Worst Δ counts OUT rows only, so
    // it's Paige's 8.40 — Calvin's 95.00 is 'uninvested' and excluded.
    expect(getTileValue('Accounts compared')).toBe('3');
    expect(getTileValue('Out of tolerance')).toBe('1');
    expect(getTileValue('Uninvested')).toBe('1');
    expect(getTileValue('No template')).toBe('0');
    expect(getTileValue('Worst Δ (out of tol.)')).toBe('8.40%');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Case 19 (adaptive tiles): account-title text search narrows tiles to
  // the matching row (single-row cohort: every tile reflects that row's
  // status / Δpp).
  // ──────────────────────────────────────────────────────────────────────────
  it('account title search: Accounts tile = 1, all other tiles reflect the single matched row', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTab();
    await screen.findByText('Calvin Gentry - Traditional IRA');

    await user.type(screen.getByLabelText('Filter account title'), 'calvin');
    act(() => {
      vi.advanceTimersByTime(350);
    });

    await waitFor(() => {
      expect(screen.queryByText('Nora Whitaker - Traditional IRA')).not.toBeInTheDocument();
    });

    // Calvin Gentry: uninvested, cash, 95.00 Δpp. The cohort is one row
    // and every tile reflects that row's status. Worst Δ counts OUT rows
    // only — there are none here — so the tile renders an em-dash, NOT
    // Calvin's 95.00 (he's uninvested: parked in cash, not drifted).
    expect(getTileValue('Accounts compared')).toBe('1');
    expect(getTileValue('Uninvested')).toBe('1');
    expect(getTileValue('Out of tolerance')).toBe('0');
    expect(getTileValue('No template')).toBe('0');
    expect(getTileValue('Worst Δ (out of tol.)')).toBe('—');
  });

  it('flags malformed templates: "⚠ Template sums to X%" chip when weights don\'t total ~100', async () => {
    const badTemplateRow = row({
      accountId: '01BADTPL000000000000000000',
      accountTitle: 'Renata Vale - Roth IRA',
      householdName: 'Vale Family',
      status: 'out',
      worstBucket: 'equity',
      maxBucketDeltaPct: 60.49,
      templateName: 'Taxable - National - Risk 13 - URTH',
      templateTotalPct: 72,
    });
    const goodTemplateRow = row({
      accountId: '01GOODTPL00000000000000000',
      accountTitle: 'Healthy Template Account',
      householdName: 'Healthy Family',
      status: 'in',
      maxBucketDeltaPct: 1.2,
      templateName: 'ACWI Optimized 250',
      templateTotalPct: 100,
    });
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: [badTemplateRow, goodTemplateRow] });
    renderTab();
    await screen.findByText('Renata Vale - Roth IRA');

    // The malformed-template chip renders ONLY on the 72% row — a healthy
    // 100% template must not be flagged.
    expect(screen.getByText('⚠ Template sums to 72%')).toBeInTheDocument();
    expect(screen.queryByText(/Template sums to 100%/)).not.toBeInTheDocument();
  });

  it('renders the cost-basis tax layer: staleness banner, unrealized-gain column, and transfer-in / transition chips', async () => {
    const freshness = {
      level: 'critical' as const,
      fullProcessDate: '2026-05-01',
      fullAgeDays: 12,
      dailyProcessDate: '2026-05-10',
      dailyAgeDays: 3,
      pipelineLatest: '2026-05-11T11:00:00-04:00',
      pipelineAgeDays: 2,
      message: 'Cost-basis data stale (critical) — full: 12d old (2026-05-01)',
    };
    const taxRow = row({
      accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
      accountTitle: 'Victor Lang - Brokerage',
      householdName: 'Lang Family',
      status: 'no_template',
      worstBucket: null,
      maxBucketDeltaPct: null,
      totalValueUsd: 241_000,
      unrealizedGainUsd: 44_767,
      realizedGainYtdUsd: 41_000,
      transferInPct: 71,
      transitionCandidate: true,
      costBasisFreshness: freshness,
    });
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: [taxRow] });
    const detail = runDetailFor([taxRow]);
    (detail.accounts[0] as { details: unknown }).details = {
      ...(detail.accounts[0].details as object),
      tax: {
        investableValueUsd: 241_000,
        basisCoveragePct: 98,
        unrealizedGainUsd: 44_767,
        unrealizedShortTermGainUsd: 47_580,
        unrealizedLongTermGainUsd: 489,
        transferInValueUsd: 171_000,
        transferInPct: 71,
        hasMissingBasis: true,
        transitionCandidate: true,
        realizedGainYtdUsd: 41_000,
        realizedShortTermYtdUsd: 5_000,
        realizedLongTermYtdUsd: 36_000,
        symbols: [
          {
            symbol: 'WDC',
            marketValueUsd: 5875,
            costBasisUsd: 626,
            unrealizedGainUsd: 5249,
            unrealizedShortTermGainUsd: 5249,
            unrealizedLongTermGainUsd: 0,
            transferInPct: 100,
            hasMissingBasis: false,
          },
        ],
      },
    };
    mocks.fetchAccountDriftRun.mockResolvedValue(detail);

    render(
      <MemoryRouter>
        <DriftTabV2 />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Victor Lang - Brokerage')).toBeInTheDocument());

    // Staleness banner.
    expect(screen.getByRole('alert')).toHaveTextContent(/Cost-basis data stale/i);
    // Unrealized-gain column (signed, abbreviated): +$45K.
    expect(screen.getByText('+$45K')).toBeInTheDocument();
    // Realized-YTD column header + value (signed, abbreviated): +$41K.
    expect(screen.getByText('Realized G/L YTD')).toBeInTheDocument(); // column header (pre-expand, unique)
    expect(screen.getAllByText('+$41K').length).toBeGreaterThan(0); // column cell + summary tile
    // Flags under the account title.
    expect(screen.getByText(/Transfer-in 71%/)).toBeInTheDocument();
    expect(screen.getByText('Transition candidate')).toBeInTheDocument();

    // Realized YTD summary tile (book-level, from the history rows).
    expect(screen.getByText('Realized G/L YTD (visible)')).toBeInTheDocument();

    // Expanding the row surfaces the Tax & cost basis panel.
    await userEvent.click(screen.getByText('Victor Lang - Brokerage'));
    await waitFor(() => expect(screen.getByText('Tax & cost basis')).toBeInTheDocument());
    expect(screen.getByText('WDC')).toBeInTheDocument();
  });

  it('run-date picker shows the latest run and Export CSV downloads that run as a CSV', async () => {
    mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
    const user = userEvent.setup();
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const setAttr = vi.spyOn(HTMLAnchorElement.prototype, 'setAttribute');

    renderTab();
    await screen.findByText('Nora Whitaker - Traditional IRA');

    // Date picker defaults to the latest run, flagged "(latest)".
    const dateSelect = screen.getByLabelText('Run date') as HTMLSelectElement;
    expect(dateSelect.value).toBe(RUN_DATE);
    expect(screen.getByRole('option', { name: `${RUN_DATE} (latest)` })).toBeInTheDocument();

    // Export → a CSV blob is created and the anchor is named drift_<date>.csv.
    await user.click(screen.getByRole('button', { name: /Export CSV/i }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    expect(blob.type).toContain('text/csv');
    expect(setAttr).toHaveBeenCalledWith('download', `drift_${RUN_DATE}.csv`);

    // The CSV body carries the header + a known account row.
    const text = await blob.text();
    expect(text.split('\n')[0]).toContain('Max Δpp');
    expect(text).toContain('Nora Whitaker - Traditional IRA');
  });

  describe('exports', () => {
    function stubDownload() {
      const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const setAttr = vi.spyOn(HTMLAnchorElement.prototype, 'setAttribute');
      return { createObjectUrl, setAttr };
    }

    it('drift CSV carries the override columns — reason, note, who set it and when', async () => {
      mocks.fetchAccountDriftHistory.mockResolvedValue({
        days: 30,
        runs: [
          row({
            accountTitle: 'Overridden Account',
            status: 'out',
            maxBucketDeltaPct: 12.5,
            override: {
              reason: 'tax_constraint',
              note: 'Large embedded gain, revisit next year',
              expiresOn: '2026-12-31',
              setByName: 'Dana Trader',
              setAt: '2026-07-01T14:00:00.000Z',
            },
          }),
        ],
      });
      const { createObjectUrl } = stubDownload();
      const user = userEvent.setup();

      renderTab();
      await screen.findByText('Overridden Account');
      await user.click(screen.getByRole('button', { name: /Export CSV/i }));

      const text = await (createObjectUrl.mock.calls[0][0] as Blob).text();
      const [header, dataRow] = text.split('\n');

      for (const col of [
        'Account ID',
        'Actionable',
        'Overridden',
        'Override Reason',
        'Override Note',
        'Override Set By',
        'Override Set At',
        'Override Expires On',
      ]) {
        expect(header).toContain(col);
      }
      // Human-readable reason label, not the raw enum value.
      expect(dataRow).toContain('Tax constraint (embedded gains)');
      expect(dataRow).toContain('Large embedded gain, revisit next year');
      expect(dataRow).toContain('Dana Trader');
      expect(dataRow).toContain('2026-12-31');
      expect(dataRow).toContain('01SYNTHNQTDVG6RNQ8TPY28EEX');
    });

    it('marks an overridden out-of-tolerance account as not actionable', async () => {
      mocks.fetchAccountDriftHistory.mockResolvedValue({
        days: 30,
        runs: [
          row({ accountTitle: 'Plain Breach', status: 'out', maxBucketDeltaPct: 9 }),
          row({
            accountTitle: 'Accepted Breach',
            accountId: '01KBQMN6YVMKZ0D2GZZZP3BJTO',
            status: 'out',
            maxBucketDeltaPct: 8,
            override: {
              reason: 'other',
              note: '',
              expiresOn: null,
              setByName: 'Dana Trader',
              setAt: '2026-07-01T14:00:00.000Z',
            },
          }),
        ],
      });
      const { createObjectUrl } = stubDownload();
      const user = userEvent.setup();

      renderTab();
      await screen.findByText('Plain Breach');
      await user.click(screen.getByRole('button', { name: /Export CSV/i }));

      const text = await (createObjectUrl.mock.calls[0][0] as Blob).text();
      const cols = text
        .split('\n')[0]
        .split(',')
        .map((c) => c.replace(/"/g, ''));
      const actionableIdx = cols.indexOf('Actionable');
      const cellsFor = (title: string) =>
        text
          .split('\n')
          .find((l) => l.includes(title))!
          .split(',')
          .map((c) => c.replace(/"/g, ''));

      // Mirrors the summary tiles: out + overridden is NOT in the action list.
      expect(cellsFor('Plain Breach')[actionableIdx]).toBe('yes');
      expect(cellsFor('Accepted Breach')[actionableIdx]).toBe('no');
    });

    it('exports firm-wide exclusions as a separate file', async () => {
      mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
      mocks.fetchExclusionsExport.mockResolvedValue([
        {
          scope: 'account',
          clientId: 'user-1',
          clientName: 'Alice Advisor-Client',
          accountId: '01SYNTHNQTDVG6RNQ8TPY28EEX',
          accountNumber: 'ACCT-1001',
          ticker: 'XOM',
          kind: 'client',
          reason: 'ESG preference',
          noBuy: true,
          noSell: false,
          createdByName: 'Dana Trader',
          createdAt: '2026-07-01T14:00:00.000Z',
        },
        {
          scope: 'client',
          clientId: 'user-2',
          clientName: 'Bob Client',
          accountId: '',
          accountNumber: '',
          ticker: 'TSLA',
          kind: 'advisor',
          reason: 'Concentration',
          noBuy: true,
          noSell: true,
          createdByName: 'Dana Trader',
          createdAt: '2026-06-01T14:00:00.000Z',
        },
      ]);
      const { createObjectUrl, setAttr } = stubDownload();
      const user = userEvent.setup();

      renderTab();
      await screen.findByText('Nora Whitaker - Traditional IRA');
      await user.click(screen.getByRole('button', { name: /Export exclusions/i }));

      await waitFor(() => expect(mocks.fetchExclusionsExport).toHaveBeenCalledTimes(1));
      const blob = createObjectUrl.mock.calls[0][0] as Blob;
      expect(blob.type).toContain('text/csv');
      // Its own file — not folded into the drift export.
      expect(setAttr).toHaveBeenCalledWith('download', expect.stringMatching(/^exclusions_\d{4}-\d{2}-\d{2}\.csv$/));

      const text = await blob.text();
      const lines = text.split('\n');
      expect(lines[0]).toContain('Scope');
      expect(lines[0]).toContain('No Buy');
      // Client-scope rows sort ahead of account-scope rows.
      expect(lines[1]).toContain('TSLA');
      expect(lines[2]).toContain('XOM');
      expect(text).toContain('ACCT-1001');
      expect(text).toContain('ESG preference');
    });

    it('reports an error instead of downloading when the exclusions fetch fails', async () => {
      mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
      mocks.fetchExclusionsExport.mockRejectedValue(new Error('boom'));
      const { createObjectUrl } = stubDownload();
      const user = userEvent.setup();

      renderTab();
      await screen.findByText('Nora Whitaker - Traditional IRA');
      await user.click(screen.getByRole('button', { name: /Export exclusions/i }));

      expect(await screen.findByText(/Unable to export exclusions/i)).toBeInTheDocument();
      expect(createObjectUrl).not.toHaveBeenCalled();
      // Button recovers rather than staying stuck on "Exporting…".
      expect(screen.getByRole('button', { name: /Export exclusions/i })).toBeEnabled();
    });

    it('says so when there are no exclusions rather than downloading an empty file', async () => {
      mocks.fetchAccountDriftHistory.mockResolvedValue({ days: 30, runs: CANVAS_ROWS });
      mocks.fetchExclusionsExport.mockResolvedValue([]);
      const { createObjectUrl } = stubDownload();
      const user = userEvent.setup();

      renderTab();
      await screen.findByText('Nora Whitaker - Traditional IRA');
      await user.click(screen.getByRole('button', { name: /Export exclusions/i }));

      expect(await screen.findByText(/No standing exclusions to export/i)).toBeInTheDocument();
      expect(createObjectUrl).not.toHaveBeenCalled();
    });
  });
});
