import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HouseholdResolveResponse, HouseholdResolution, HouseholdResolutionAccount } from '@trade-request/shared';
import { HouseholdSidecar } from '../HouseholdSidecar';

const VALID_ULID = (suffix: string): string => `01JY2NPMDDS83DRA5FWXGS3${suffix.padStart(3, '0').slice(0, 3)}`;

function acct(opts: Partial<HouseholdResolutionAccount> & { ulid: string }): HouseholdResolutionAccount {
  return {
    accountId: opts.ulid,
    accountNumber: opts.accountNumber ?? `ACCT-${opts.ulid.slice(-3)}`,
    accountTitle: opts.accountTitle ?? `Title ${opts.ulid.slice(-3)}`,
    clientId: opts.clientId ?? 'CLI-A',
    accountType: opts.accountType ?? 'Taxable',
    balance: opts.balance ?? 100_000,
  };
}

function household(opts: Partial<HouseholdResolution> & { id: number; name: string }): HouseholdResolution {
  return {
    householdId: opts.id,
    householdName: opts.name,
    accounts: opts.accounts ?? [],
    selectedAccountIds: opts.selectedAccountIds ?? [],
    clientIds: opts.clientIds ?? [],
  };
}

function resolutionOf(households: HouseholdResolution[]): HouseholdResolveResponse {
  return { households, unresolvedClientIds: [], unresolvedAccountIds: [] };
}

const noop = (): void => {};

describe('<HouseholdSidecar />', () => {
  it('renders nothing when there are no households', () => {
    const { container } = render(
      <HouseholdSidecar
        resolution={resolutionOf([])}
        currentlySelectedClientIds={[]}
        currentlySelectedAccountIds={[]}
        onIncludeAll={vi.fn()}
        onIncludeSubset={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every account is already selected', () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const res = resolutionOf([household({ id: 100, name: 'H1', accounts: [acct({ ulid: u1 }), acct({ ulid: u2 })] })]);
    const { container } = render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A']}
        currentlySelectedAccountIds={[u1, u2]}
        onIncludeAll={vi.fn()}
        onIncludeSubset={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders single-household prompt and Include all passes only sibling ULIDs + their new client IDs', async () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const u3 = VALID_ULID('3');
    const res = resolutionOf([
      household({
        id: 100,
        name: 'Family A',
        accounts: [
          acct({ ulid: u1, clientId: 'CLI-A' }),
          acct({ ulid: u2, clientId: 'CLI-B' }),
          acct({ ulid: u3, clientId: 'CLI-B' }),
        ],
      }),
    ]);

    const onIncludeAll = vi.fn<(clientIds: string[], accountIds: string[]) => void>();

    render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A']}
        currentlySelectedAccountIds={[u1]}
        onIncludeAll={onIncludeAll}
        onIncludeSubset={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('household-sidecar')).toBeInTheDocument();
    expect(screen.getByText(/Family A/)).toBeInTheDocument();
    expect(screen.getByText(/2 sibling accounts/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('household-include-all'));
    expect(onIncludeAll).toHaveBeenCalledTimes(1);
    const [clientIds, accountIds] = onIncludeAll.mock.calls[0];
    expect(accountIds.sort()).toEqual([u2, u3].sort());
    expect(clientIds).toEqual(['CLI-B']);
  });

  it('Choose… disclosure: toggling checkboxes scopes the Include selected payload', async () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const u3 = VALID_ULID('3');
    const res = resolutionOf([
      household({
        id: 100,
        name: 'Family A',
        accounts: [
          acct({ ulid: u1, clientId: 'CLI-A' }),
          acct({ ulid: u2, clientId: 'CLI-B' }),
          acct({ ulid: u3, clientId: 'CLI-C' }),
        ],
      }),
    ]);

    const onIncludeSubset = vi.fn<(clientIds: string[], accountIds: string[]) => void>();

    render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A']}
        currentlySelectedAccountIds={[u1]}
        onIncludeAll={vi.fn()}
        onIncludeSubset={onIncludeSubset}
        onDismiss={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('household-toggle-disclosure'));

    // Both u2 and u3 are pre-checked. Uncheck u3.
    const u3Row = screen.getByTestId(`household-sibling-${u3}`);
    await userEvent.click(u3Row.querySelector('input')!);

    await userEvent.click(screen.getByTestId('household-include-subset'));
    expect(onIncludeSubset).toHaveBeenCalledTimes(1);
    const [clientIds, accountIds] = onIncludeSubset.mock.calls[0];
    expect(accountIds).toEqual([u2]);
    expect(clientIds).toEqual(['CLI-B']);
  });

  it('Include selected is disabled when no sibling is checked', async () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const res = resolutionOf([
      household({
        id: 100,
        name: 'Family A',
        accounts: [acct({ ulid: u1, clientId: 'CLI-A' }), acct({ ulid: u2, clientId: 'CLI-B' })],
      }),
    ]);

    render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A']}
        currentlySelectedAccountIds={[u1]}
        onIncludeAll={vi.fn()}
        onIncludeSubset={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('household-toggle-disclosure'));
    const u2Row = screen.getByTestId(`household-sibling-${u2}`);
    await userEvent.click(u2Row.querySelector('input')!);

    expect(screen.getByTestId('household-include-subset')).toBeDisabled();
  });

  it('Dismiss button fires onDismiss', async () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const res = resolutionOf([
      household({
        id: 100,
        name: 'Family A',
        accounts: [acct({ ulid: u1 }), acct({ ulid: u2, clientId: 'CLI-B' })],
      }),
    ]);

    const onDismiss = vi.fn<() => void>();

    render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A']}
        currentlySelectedAccountIds={[u1]}
        onIncludeAll={vi.fn()}
        onIncludeSubset={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    await userEvent.click(screen.getByTestId('household-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders multi-household warning when selection spans 2+ households (no Include all button)', async () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const u3 = VALID_ULID('3');
    const u4 = VALID_ULID('4');
    const res = resolutionOf([
      household({
        id: 100,
        name: 'Family A',
        accounts: [acct({ ulid: u1 }), acct({ ulid: u2, clientId: 'CLI-A2' })],
      }),
      household({
        id: 200,
        name: 'Family B',
        accounts: [acct({ ulid: u3, clientId: 'CLI-B' }), acct({ ulid: u4, clientId: 'CLI-B2' })],
      }),
    ]);

    const onDismiss = vi.fn<() => void>();
    render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A', 'CLI-B']}
        currentlySelectedAccountIds={[u1, u3]}
        onIncludeAll={vi.fn()}
        onIncludeSubset={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId('household-sidecar-multi')).toBeInTheDocument();
    expect(screen.getByText(/Selection spans 2 firm households/)).toBeInTheDocument();
    expect(screen.queryByTestId('household-include-all')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('household-continue'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate already-selected sibling clientIds in Include all callback', async () => {
    const u1 = VALID_ULID('1');
    const u2 = VALID_ULID('2');
    const res = resolutionOf([
      household({
        id: 100,
        name: 'Family A',
        accounts: [acct({ ulid: u1, clientId: 'CLI-A' }), acct({ ulid: u2, clientId: 'CLI-A' })],
      }),
    ]);

    const onIncludeAll = vi.fn<(clientIds: string[], accountIds: string[]) => void>();
    render(
      <HouseholdSidecar
        resolution={res}
        currentlySelectedClientIds={['CLI-A']}
        currentlySelectedAccountIds={[u1]}
        onIncludeAll={onIncludeAll}
        onIncludeSubset={vi.fn()}
        onDismiss={noop}
      />,
    );

    await userEvent.click(screen.getByTestId('household-include-all'));
    const [clientIds, accountIds] = onIncludeAll.mock.calls[0];
    expect(clientIds).toEqual([]);
    expect(accountIds).toEqual([u2]);
  });
});
