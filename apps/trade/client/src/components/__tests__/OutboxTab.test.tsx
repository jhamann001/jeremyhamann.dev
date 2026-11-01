import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OutboxTab } from '../OutboxTab';

const mocks = vi.hoisted(() => ({ fetchOutbox: vi.fn() }));
vi.mock('../../api/client', () => ({
  fetchOutbox: () => mocks.fetchOutbox(),
  extractApiError: (_err: unknown, fallback: string) => fallback,
}));

const now = new Date().toISOString();
const SLACK = {
  id: '1',
  transport: 'slack',
  destination: 'C0DEMODRIFT',
  destinationLabel: '#drift-alerts',
  subject: null,
  body: '*Drift report* for `ACCT-1` &amp; more\n```\n% off  account\n```\nSee <https://trade.test/drift|drift dashboard>',
  createdAt: now,
};
const EMAIL = {
  id: '2',
  transport: 'email',
  destination: 'nina@example.com',
  destinationLabel: 'nina@example.com',
  subject: "You've been invited",
  body: '<h2>Welcome</h2><script>alert(1)</script>',
  createdAt: now,
};

beforeEach(() => {
  mocks.fetchOutbox.mockResolvedValue([SLACK, EMAIL]);
});

describe('OutboxTab', () => {
  it("renders Slack's markup: bold, code, code blocks, escaped characters and links", async () => {
    render(<OutboxTab />);
    expect(await screen.findByText('Drift report')).toContainHTML('strong');
    expect(screen.getByText('ACCT-1').tagName).toBe('CODE');
    expect(screen.getByText(/& more/)).toBeInTheDocument();
    expect(screen.getByText(/% off\s+account/).tagName).toBe('PRE');
    expect(screen.getByRole('link', { name: 'drift dashboard' })).toHaveAttribute('href', 'https://trade.test/drift');
  });

  it('shows an email in a sandbox that allows nothing, from its own address', async () => {
    render(<OutboxTab />);
    const frame = (await screen.findByTitle("You've been invited")) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('src')).toBe(`/api/outbox/${EMAIL.id}/body`);
  });

  it('filters by transport', async () => {
    render(<OutboxTab />);
    await screen.findByText('Drift report');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    expect(screen.queryByText('Drift report')).not.toBeInTheDocument();
    expect(screen.getByTitle("You've been invited")).toBeInTheDocument();
  });

  it('says so when nothing has been sent', async () => {
    mocks.fetchOutbox.mockResolvedValue([]);
    render(<OutboxTab />);
    expect(await screen.findByText(/nothing has been sent yet/i)).toBeInTheDocument();
  });
});
