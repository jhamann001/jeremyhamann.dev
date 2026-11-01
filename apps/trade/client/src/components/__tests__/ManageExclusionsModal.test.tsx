import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClientExclusion } from '@trade-request/shared';
import { ManageExclusionsModal } from '../ManageExclusionsModal';
import {
  fetchClientExclusions,
  applyClientExclusionsBatch,
  fetchAccountExclusions,
  applyAccountExclusionsBatch,
  type ApplyClientExclusionsBatchPayload,
  type ApplyClientExclusionsBatchResult,
} from '../../api/client';

vi.mock('../../api/client', () => ({
  fetchClientExclusions: vi.fn(),
  applyClientExclusionsBatch: vi.fn(),
  fetchAccountExclusions: vi.fn(),
  applyAccountExclusionsBatch: vi.fn(),
  extractApiError: vi.fn((err: unknown, fallback?: string) => (err as Error)?.message ?? fallback ?? 'error'),
}));

const fetchMock = vi.mocked(fetchClientExclusions);
const applyMock = vi.mocked(applyClientExclusionsBatch);
const fetchAccountMock = vi.mocked(fetchAccountExclusions);
const applyAccountMock = vi.mocked(applyAccountExclusionsBatch);

const sampleExclusions: ClientExclusion[] = [
  {
    id: 'ex-1',
    clientId: 'hh-1',
    ticker: 'TSLA',
    kind: 'advisor',
    reason: 'Concentration risk',
    noBuy: true,
    noSell: true,
    createdByName: 'Rachel',
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'ex-2',
    clientId: 'hh-1',
    ticker: 'AAPL',
    kind: 'client',
    reason: '',
    noBuy: true,
    noSell: true,
    createdByName: 'Sam',
    createdAt: '2026-05-02T00:00:00.000Z',
  },
];

function applyResult(overrides: Partial<ApplyClientExclusionsBatchResult> = {}): ApplyClientExclusionsBatchResult {
  return {
    exclusions: [],
    added: 0,
    removed: 0,
    edited: 0,
    ...overrides,
  };
}

async function findApplyButton(): Promise<HTMLButtonElement> {
  return await screen.findByRole('button', { name: /^apply/i });
}

function getAdvisorSection() {
  // The advisor section is identified by its heading text.
  const heading = screen.getByRole('heading', { name: /advisor specific exclusions/i });
  const section = heading.closest('section');
  if (!section) throw new Error('advisor section not found');
  return section;
}

function getClientSection() {
  const heading = screen.getByRole('heading', { name: /client requested exclusions/i });
  const section = heading.closest('section');
  if (!section) throw new Error('client section not found');
  return section;
}

// v3.4 — find the DNB checkbox of the most recently-staged advisor add row.
// Multiple staged rows produce multiple inputs with the same aria-label, so
// we always grab the LAST one in document order (newest add).
function lastNewAdvisorDnbCheckbox(): HTMLInputElement {
  const inputs = screen.getAllByLabelText(/new advisor exclusion: do not buy/i);
  return inputs[inputs.length - 1] as HTMLInputElement;
}

function lastNewClientDnbCheckbox(): HTMLInputElement {
  const inputs = screen.getAllByLabelText(/new client exclusion: do not buy/i);
  return inputs[inputs.length - 1] as HTMLInputElement;
}

describe('ManageExclusionsModal (v3.3 batch staging)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock.mockReset();
    applyMock.mockReset();
    fetchAccountMock.mockReset();
    applyAccountMock.mockReset();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  const singleClient = [{ id: 'hh-1', name: 'Test Household' }];

  it('renders both kind sections with existing saved entries (single client)', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-1', expect.any(AbortSignal)));
    expect(screen.getByText('Test Household')).toBeInTheDocument();
    expect(screen.getByText('TSLA')).toBeInTheDocument();
    expect(screen.getByText('— Concentration risk')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('Apply button is disabled until there is at least one pending change', async () => {
    fetchMock.mockResolvedValue([]);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const applyBtn = await findApplyButton();
    expect(applyBtn).toBeDisabled();
  });

  it('staging an add row enables Apply, fires ONE batch POST, and stays open with a saved toast', async () => {
    fetchMock.mockResolvedValue([]);
    applyMock.mockResolvedValue(
      applyResult({
        added: 1,
        exclusions: [
          {
            id: 'ex-new',
            clientId: 'hh-1',
            ticker: 'NVDA',
            kind: 'advisor',
            reason: 'High vol',
            noBuy: true,
            noSell: true,
            createdByName: 'Rachel',
            createdAt: '2026-05-21T00:00:00.000Z',
          },
        ],
      }),
    );
    const onClose = vi.fn<() => void>();

    render(<ManageExclusionsModal clients={singleClient} onClose={onClose} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Click "Add row" in the advisor section.
    const advisorSection = getAdvisorSection();
    await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));

    // Fill the row.
    const tickerInput = screen.getByLabelText(/ticker for new advisor exclusion/i);
    const reasonInput = screen.getByLabelText(/reason for new advisor exclusion/i);
    await userEvent.type(tickerInput, 'nvda');
    await userEvent.type(reasonInput, 'High vol');
    // v3.4 — Apply stays disabled until at least one side is checked.
    await userEvent.click(lastNewAdvisorDnbCheckbox());

    // Apply.
    const applyBtn = await findApplyButton();
    expect(applyBtn).not.toBeDisabled();
    await userEvent.click(applyBtn);

    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    const [calledClientId, payload] = applyMock.mock.calls[0] as [string, ApplyClientExclusionsBatchPayload];
    expect(calledClientId).toBe('hh-1');
    expect(payload.add).toEqual([{ ticker: 'NVDA', kind: 'advisor', reason: 'High vol', noBuy: true, noSell: false }]);
    expect(payload.remove).toEqual([]);
    expect(payload.edit).toEqual([]);

    // Saved toast appears, modal stays open (onClose NOT called).
    await waitFor(() => expect(screen.getByText(/^Saved\./i)).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    // Pending state cleared — Apply button is disabled again.
    expect(await findApplyButton()).toBeDisabled();
  });

  it('staging multiple rows + a removal sends them all in ONE batch call', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);
    applyMock.mockResolvedValue(applyResult({ added: 2, removed: 1 }));

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Stage two adds on the advisor side.
    const advisorSection = getAdvisorSection();
    const addRowButton = within(advisorSection).getByRole('button', { name: /^add row$/i });
    await userEvent.click(addRowButton);
    await userEvent.click(addRowButton);

    const tickerInputs = within(advisorSection).getAllByLabelText(/ticker for new advisor exclusion/i);
    expect(tickerInputs).toHaveLength(2);
    await userEvent.type(tickerInputs[0], 'aapl');
    await userEvent.type(tickerInputs[1], 'xom');

    // v3.4 — tick a side on both staged rows. AAPL gets DNB+DNS (both),
    // XOM gets DNS only to verify mixed-side batches work.
    const dnbBoxes = screen.getAllByLabelText(/new advisor exclusion: do not buy/i);
    const dnsBoxes = screen.getAllByLabelText(/new advisor exclusion: do not sell/i);
    await userEvent.click(dnbBoxes[0]); // AAPL DNB
    await userEvent.click(dnsBoxes[0]); // AAPL DNS
    await userEvent.click(dnsBoxes[1]); // XOM DNS

    // Mark the existing TSLA row for removal.
    await userEvent.click(within(advisorSection).getByRole('button', { name: /mark tsla for removal/i }));

    await userEvent.click(await findApplyButton());

    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    const [, payload] = applyMock.mock.calls[0] as [string, ApplyClientExclusionsBatchPayload];
    expect(payload.add).toEqual([
      { ticker: 'AAPL', kind: 'advisor', reason: '', noBuy: true, noSell: true },
      { ticker: 'XOM', kind: 'advisor', reason: '', noBuy: false, noSell: true },
    ]);
    expect(payload.remove).toEqual(['ex-1']);
    expect(payload.edit).toEqual([]);
  });

  it('toggling the trash icon twice un-marks a saved row for removal', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);
    applyMock.mockResolvedValue(applyResult());

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const advisorSection = getAdvisorSection();
    const trash = within(advisorSection).getByRole('button', { name: /mark tsla for removal/i });
    await userEvent.click(trash);

    // Button label flips to "Unmark…"
    const unmark = within(advisorSection).getByRole('button', { name: /unmark tsla for removal/i });
    await userEvent.click(unmark);

    // Apply is back to disabled (nothing pending).
    expect(await findApplyButton()).toBeDisabled();
  });

  it('Apply is disabled if any staged-add row has an empty ticker or no side checked (v3.4)', async () => {
    fetchMock.mockResolvedValue([]);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const advisorSection = getAdvisorSection();
    await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
    // Empty ticker AND no side → disabled.
    expect(await findApplyButton()).toBeDisabled();

    // Fill ticker but still no side → still disabled (v3.4 validation guard).
    const tickerInput = screen.getByLabelText(/ticker for new advisor exclusion/i);
    await userEvent.type(tickerInput, 'AAPL');
    expect(await findApplyButton()).toBeDisabled();
    // Inline-alert visible.
    expect(screen.getByRole('alert')).toHaveTextContent(/pick at least one of dnb or dns/i);

    // Tick DNB → enabled.
    await userEvent.click(lastNewAdvisorDnbCheckbox());
    expect(await findApplyButton()).not.toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('discarding a staged row removes it from the pending batch without any API call', async () => {
    fetchMock.mockResolvedValue([]);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const advisorSection = getAdvisorSection();
    await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
    const tickerInput = screen.getByLabelText(/ticker for new advisor exclusion/i);
    await userEvent.type(tickerInput, 'AAPL');

    await userEvent.click(within(advisorSection).getByRole('button', { name: /discard staged advisor exclusion/i }));

    expect(screen.queryByLabelText(/ticker for new advisor exclusion/i)).not.toBeInTheDocument();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('surfaces an error toast when Apply fails and KEEPS the pending state', async () => {
    fetchMock.mockResolvedValue([]);
    applyMock.mockRejectedValue(new Error('Duplicate ticker'));

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const advisorSection = getAdvisorSection();
    await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
    await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'TSLA');
    await userEvent.click(lastNewAdvisorDnbCheckbox());

    await userEvent.click(await findApplyButton());

    await waitFor(() => expect(screen.getByText(/duplicate ticker/i)).toBeInTheDocument());
    // Pending row is still there for editing/retry.
    expect(screen.getByLabelText(/ticker for new advisor exclusion/i)).toHaveValue('TSLA');
  });

  it('Close after a successful Apply fires onSavedChanges exactly once', async () => {
    fetchMock.mockResolvedValue([]);
    applyMock.mockResolvedValue(applyResult({ added: 1 }));
    const onSavedChanges = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();

    render(<ManageExclusionsModal clients={singleClient} onClose={onClose} onSavedChanges={onSavedChanges} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const advisorSection = getAdvisorSection();
    await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
    await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'NVDA');
    await userEvent.click(lastNewAdvisorDnbCheckbox());
    await userEvent.click(await findApplyButton());

    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(onSavedChanges).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Close with no writes does NOT fire onSavedChanges and does NOT prompt', async () => {
    fetchMock.mockResolvedValue([]);
    const onSavedChanges = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();

    render(<ManageExclusionsModal clients={singleClient} onClose={onClose} onSavedChanges={onSavedChanges} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(onSavedChanges).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Close with pending changes prompts a confirm dialog and aborts when user cancels', async () => {
    fetchMock.mockResolvedValue([]);
    confirmSpy.mockReturnValue(false); // user clicks "Cancel" on the confirm.
    const onClose = vi.fn<() => void>();

    render(<ManageExclusionsModal clients={singleClient} onClose={onClose} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const advisorSection = getAdvisorSection();
    await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
    await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'NVDA');

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/1 unsaved change for Test Household/));
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('multi-client (household)', () => {
    const household = [
      { id: 'hh-1', name: 'John Smith' },
      { id: 'hh-2', name: 'Jane Smith' },
    ];

    beforeEach(() => {
      // Each client's fetch returns its own one-row standing list so we can
      // exercise per-tab independence.
      fetchMock.mockImplementation(async (id) => {
        if (id === 'hh-1') return [{ ...sampleExclusions[0], clientId: 'hh-1' }];
        if (id === 'hh-2') return [{ ...sampleExclusions[1], clientId: 'hh-2', id: 'ex-jane', ticker: 'GOOG' }];
        return [];
      });
    });

    it('per-tab staging persists across tab switches', async () => {
      render(<ManageExclusionsModal clients={household} onClose={vi.fn()} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-1', expect.any(AbortSignal)));

      // Stage a row on John's tab.
      let advisorSection = getAdvisorSection();
      await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JOHN1');

      // Switch to Jane's tab.
      await userEvent.click(screen.getByRole('tab', { name: /jane smith/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-2', expect.any(AbortSignal)));

      // John's staged row is NOT visible (it belongs to John's tab).
      expect(screen.queryByDisplayValue('JOHN1')).not.toBeInTheDocument();

      // Stage a different row on Jane's tab.
      advisorSection = getAdvisorSection();
      await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JANE1');

      // Switch back to John's tab — original staged row is still there.
      await userEvent.click(screen.getByRole('tab', { name: /john smith/i }));
      expect(await screen.findByDisplayValue('JOHN1')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('JANE1')).not.toBeInTheDocument();
    });

    it('Apply targets only the active tab and leaves the other tabs pending state untouched', async () => {
      applyMock.mockResolvedValue(applyResult({ added: 1 }));

      render(<ManageExclusionsModal clients={household} onClose={vi.fn()} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-1', expect.any(AbortSignal)));

      // Stage on John's tab.
      let advisorSection = getAdvisorSection();
      await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JOHN1');

      // Switch to Jane's tab, stage there too.
      await userEvent.click(screen.getByRole('tab', { name: /jane smith/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-2', expect.any(AbortSignal)));
      advisorSection = getAdvisorSection();
      await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JANE1');

      // Tick a side on Jane's row so Apply enables.
      await userEvent.click(lastNewAdvisorDnbCheckbox());

      // Apply ONLY commits Jane's batch (since Jane is the active tab).
      await userEvent.click(await findApplyButton());

      await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
      const [calledClientId, payload] = applyMock.mock.calls[0] as [string, ApplyClientExclusionsBatchPayload];
      expect(calledClientId).toBe('hh-2');
      expect(payload.add).toEqual([{ ticker: 'JANE1', kind: 'advisor', reason: '', noBuy: true, noSell: false }]);

      // Switch back to John — his pending row is STILL there.
      await userEvent.click(screen.getByRole('tab', { name: /john smith/i }));
      expect(await screen.findByDisplayValue('JOHN1')).toBeInTheDocument();
    });

    it('Close with pending changes on multiple tabs aggregates the confirm message', async () => {
      confirmSpy.mockReturnValue(false);

      render(<ManageExclusionsModal clients={household} onClose={vi.fn()} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-1', expect.any(AbortSignal)));

      // Stage on John.
      await userEvent.click(within(getAdvisorSection()).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JOHN1');

      // Switch to Jane, stage there too.
      await userEvent.click(screen.getByRole('tab', { name: /jane smith/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-2', expect.any(AbortSignal)));
      await userEvent.click(within(getAdvisorSection()).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JANE1');

      // Close — confirm message lists both clients.
      await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringMatching(/1 unsaved change for John Smith.*1 unsaved change for Jane Smith/),
      );
    });

    it('tab strip shows an unsaved-count badge for each tab with pending changes', async () => {
      render(<ManageExclusionsModal clients={household} onClose={vi.fn()} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-1', expect.any(AbortSignal)));

      const johnTab = screen.getByRole('tab', { name: /john smith/i });
      // No badge yet.
      expect(within(johnTab).queryByLabelText(/unsaved/i)).not.toBeInTheDocument();

      await userEvent.click(within(getAdvisorSection()).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'JOHN1');

      // Badge shows 1.
      expect(within(johnTab).getByLabelText('1 unsaved')).toHaveTextContent('1');

      // Stage a second row → 2.
      await userEvent.click(within(getAdvisorSection()).getByRole('button', { name: /^add row$/i }));
      expect(within(johnTab).getByLabelText('2 unsaved')).toHaveTextContent('2');
    });
  });

  // Sanity check the client section is reachable in tests (other places use it).
  it('Add row in the client section creates a client-kind staged row', async () => {
    fetchMock.mockResolvedValue([]);
    applyMock.mockResolvedValue(applyResult({ added: 1 }));

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const clientSection = getClientSection();
    await userEvent.click(within(clientSection).getByRole('button', { name: /^add row$/i }));
    await userEvent.type(screen.getByLabelText(/ticker for new client exclusion/i), 'AAPL');
    await userEvent.click(lastNewClientDnbCheckbox());

    await userEvent.click(await findApplyButton());
    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    const [, payload] = applyMock.mock.calls[0] as [string, ApplyClientExclusionsBatchPayload];
    expect(payload.add).toEqual([{ ticker: 'AAPL', kind: 'client', reason: '', noBuy: true, noSell: false }]);
  });

  // ─── v3.4 (DNB / DNS) ─────────────────────────────────────────────────

  it('v3.4: saved-row inline edit stages a pendingEdit and submits it in the batch payload', async () => {
    fetchMock.mockResolvedValue(sampleExclusions); // TSLA blanket, AAPL blanket
    applyMock.mockResolvedValue(applyResult({ edited: 1 }));

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // TSLA starts as DNB+DNS (both true). Uncheck DNS → row becomes DNB only.
    const tslaDns = screen.getByLabelText(/tsla: do not sell/i);
    expect(tslaDns).toBeChecked();
    await userEvent.click(tslaDns);
    expect(tslaDns).not.toBeChecked();

    // Apply button reflects 1 pending change.
    const applyBtn = await findApplyButton();
    expect(applyBtn).toHaveTextContent(/apply 1 change/i);
    await userEvent.click(applyBtn);

    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    const [, payload] = applyMock.mock.calls[0] as [string, ApplyClientExclusionsBatchPayload];
    expect(payload.add).toEqual([]);
    expect(payload.remove).toEqual([]);
    expect(payload.edit).toEqual([{ id: 'ex-1', noBuy: true, noSell: false }]);
  });

  it('v3.4: toggling a saved row back to its saved values removes the pendingEdit (no-op normalization)', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const tslaDns = screen.getByLabelText(/tsla: do not sell/i);
    await userEvent.click(tslaDns); // off
    expect(await findApplyButton()).toHaveTextContent(/apply 1 change/i);

    await userEvent.click(tslaDns); // back on — pendingEdit cleared
    expect(await findApplyButton()).toBeDisabled();
    expect(await findApplyButton()).toHaveTextContent(/^apply changes$/i);
  });

  it('v3.4: cannot uncheck both DNB and DNS on a saved row (UI-side CHECK guard)', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const tslaDnb = screen.getByLabelText(/tsla: do not buy/i);
    const tslaDns = screen.getByLabelText(/tsla: do not sell/i);

    // Uncheck DNS — leaves DNB only.
    await userEvent.click(tslaDns);
    expect(tslaDnb).toBeChecked();
    expect(tslaDns).not.toBeChecked();

    // Try to uncheck DNB — UI blocks it (would zero out both sides → CHECK
    // violation). Checkbox stays checked.
    await userEvent.click(tslaDnb);
    expect(tslaDnb).toBeChecked();
  });

  it('v3.4: marking a saved row for removal clears its pending edit and disables its checkboxes', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Stage an edit on TSLA.
    await userEvent.click(screen.getByLabelText(/tsla: do not sell/i));
    expect(await findApplyButton()).toHaveTextContent(/apply 1 change/i);

    // Now mark TSLA for removal — the edit is dropped, so total pending = 1
    // (just the removal), not 2.
    await userEvent.click(screen.getByRole('button', { name: /mark tsla for removal/i }));
    expect(await findApplyButton()).toHaveTextContent(/apply 1 change/i);

    // Both checkboxes are now disabled.
    expect(screen.getByLabelText(/tsla: do not buy/i)).toBeDisabled();
    expect(screen.getByLabelText(/tsla: do not sell/i)).toBeDisabled();
  });

  it('v3.4: pending count badge in the tab strip includes inline edits', async () => {
    fetchMock.mockImplementation(async (id) => {
      if (id === 'hh-1') return sampleExclusions.map((e) => ({ ...e, clientId: 'hh-1' }));
      return [];
    });

    render(
      <ManageExclusionsModal
        clients={[
          { id: 'hh-1', name: 'John Smith' },
          { id: 'hh-2', name: 'Jane Smith' },
        ]}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('hh-1', expect.any(AbortSignal)));

    const johnTab = screen.getByRole('tab', { name: /john smith/i });
    expect(within(johnTab).queryByLabelText(/unsaved/i)).not.toBeInTheDocument();

    // Stage an inline edit on TSLA.
    await userEvent.click(screen.getByLabelText(/tsla: do not sell/i));
    expect(within(johnTab).getByLabelText('1 unsaved')).toHaveTextContent('1');
  });

  it('v3.4: server response with edited > 0 surfaces in the saved toast', async () => {
    fetchMock.mockResolvedValue(sampleExclusions);
    applyMock.mockResolvedValue(applyResult({ edited: 2 }));

    render(<ManageExclusionsModal clients={singleClient} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await userEvent.click(screen.getByLabelText(/tsla: do not sell/i));
    await userEvent.click(await findApplyButton());

    await waitFor(() => expect(screen.getByText(/^Saved\./i)).toBeInTheDocument());
    expect(screen.getByText(/updated 2/i)).toBeInTheDocument();
  });

  describe('account mode', () => {
    const accounts = [{ id: 'acc-1', accountNumber: 'ACC-001', clientName: 'Cole Harmon' }];

    it('loads and renders account-scoped exclusions', async () => {
      fetchAccountMock.mockResolvedValue([
        {
          id: 'ax-1',
          accountId: 'acc-1',
          ticker: 'TSLA',
          kind: 'client',
          reason: 'Employer stock',
          noBuy: true,
          noSell: false,
          createdByName: 'Ops',
          createdAt: '2026-05-01T00:00:00.000Z',
        },
      ]);

      render(<ManageExclusionsModal mode="account" accounts={accounts} onClose={vi.fn()} />);

      await waitFor(() => expect(fetchAccountMock).toHaveBeenCalledWith('acc-1', expect.any(AbortSignal)));
      expect(screen.getByText(/manage account restrictions/i)).toBeInTheDocument();
      expect(screen.getByText(/ACC-001/i)).toBeInTheDocument();
      expect(screen.getByText('TSLA')).toBeInTheDocument();
    });

    it('normalizes verbose imported reasons in account mode', async () => {
      fetchAccountMock.mockResolvedValue([
        {
          id: 'ax-1',
          accountId: 'acc-1',
          ticker: 'XOM',
          kind: 'advisor',
          reason: 'Imported from /tmp/meridian/restrictions.csv line 22',
          noBuy: true,
          noSell: false,
          createdByName: 'Ops',
          createdAt: '2026-05-01T00:00:00.000Z',
        },
      ]);

      render(<ManageExclusionsModal mode="account" accounts={accounts} onClose={vi.fn()} />);

      await waitFor(() => expect(fetchAccountMock).toHaveBeenCalled());
      expect(screen.getByText(/Imported from Meridian restrictions file/i)).toBeInTheDocument();
      expect(screen.queryByText(/\/tmp\/meridian\/restrictions\.csv/i)).not.toBeInTheDocument();
    });

    it('stages and applies account exclusion changes through account batch api', async () => {
      fetchAccountMock.mockResolvedValue([]);
      applyAccountMock.mockResolvedValue({
        exclusions: [
          {
            id: 'ax-2',
            accountId: 'acc-1',
            ticker: 'NVDA',
            kind: 'advisor',
            reason: 'Concentration',
            noBuy: true,
            noSell: false,
            createdByName: 'Ops',
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ],
        added: 1,
        removed: 0,
        edited: 0,
      });

      render(<ManageExclusionsModal mode="account" accounts={accounts} onClose={vi.fn()} />);
      await waitFor(() => expect(fetchAccountMock).toHaveBeenCalled());

      const advisorSection = getAdvisorSection();
      await userEvent.click(within(advisorSection).getByRole('button', { name: /^add row$/i }));
      await userEvent.type(screen.getByLabelText(/ticker for new advisor exclusion/i), 'nvda');
      await userEvent.click(lastNewAdvisorDnbCheckbox());

      await userEvent.click(await findApplyButton());
      await waitFor(() => expect(applyAccountMock).toHaveBeenCalledTimes(1));
      const [accountId, payload] = applyAccountMock.mock.calls[0] as [string, ApplyClientExclusionsBatchPayload];
      expect(accountId).toBe('acc-1');
      expect(payload.add).toEqual([{ ticker: 'NVDA', kind: 'advisor', reason: '', noBuy: true, noSell: false }]);
      expect(payload.remove).toEqual([]);
      expect(payload.edit).toEqual([]);
    });
  });
});
