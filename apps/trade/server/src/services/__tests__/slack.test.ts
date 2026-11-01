import { describe, it, expect, vi, beforeEach } from 'vitest';

const { postMessageMock } = vi.hoisted(() => {
  const postMessageMock = vi.fn().mockResolvedValue({ ok: true });
  return { postMessageMock };
});

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function WebClient() {
    return {
      chat: {
        postMessage: postMessageMock,
      },
    };
  }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function clearSlackEnv(): void {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CHANNEL_ID;
  delete process.env.DRIFT_SLACK_CHANNEL_ID;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  clearSlackEnv();
});

describe('escapeSlack', () => {
  it('escapes ampersands, angle brackets', async () => {
    const { escapeSlack } = await import('../slack.js');
    expect(escapeSlack('a & b')).toBe('a &amp; b');
    expect(escapeSlack('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater-than', async () => {
    const { escapeSlack } = await import('../slack.js');
    expect(escapeSlack('a > b')).toBe('a &gt; b');
  });
});

describe('sendChannelMessage', () => {
  it('returns silently when not enabled (no token)', async () => {
    const { sendChannelMessage } = await import('../slack.js');
    await sendChannelMessage('hello');
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('throws when token set but channelId missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const { sendChannelMessage } = await import('../slack.js');
    await expect(sendChannelMessage('x')).rejects.toThrow('SLACK_CHANNEL_ID is not configured');
  });

  it('posts message when fully configured', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C01234567';
    const { sendChannelMessage } = await import('../slack.js');
    await sendChannelMessage('channel text');
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C01234567',
      text: 'channel text',
      mrkdwn: true,
    });
  });
});

describe('sendDirectMessage', () => {
  it('returns silently when slackUserId empty', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const { sendDirectMessage } = await import('../slack.js');
    await sendDirectMessage('', 'some text');
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});

describe('sendDriftChannelMessage', () => {
  it('returns silently when SLACK_BOT_TOKEN is unset', async () => {
    process.env.DRIFT_SLACK_CHANNEL_ID = 'C_DRIFT';
    const { sendDriftChannelMessage } = await import('../slack.js');
    await sendDriftChannelMessage('hi');
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('returns silently when DRIFT_SLACK_CHANNEL_ID is missing (failure-soft)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_DIGEST';
    const { sendDriftChannelMessage } = await import('../slack.js');
    await sendDriftChannelMessage('hi');
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('posts to the dedicated drift channel when both env vars are set', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_DIGEST';
    process.env.DRIFT_SLACK_CHANNEL_ID = 'C_DRIFT_999';
    const { sendDriftChannelMessage } = await import('../slack.js');
    await sendDriftChannelMessage('drift text');
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C_DRIFT_999',
      text: 'drift text',
      mrkdwn: true,
    });
  });
});

describe('notifyNewRequest', () => {
  it('formats currency and posts to channel', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_CHANNEL';
    const { notifyNewRequest } = await import('../slack.js');
    notifyNewRequest({
      requestId: 'REQ-99',
      clientName: 'Acme',
      tradeType: 'Buy',
      priority: 'High',
      submittedBy: 'Sam',
      totalValue: 1234567,
      accounts: ['ACCT-001', 'ACCT-002'],
      advisorNotes: 'Rush this please',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_CHANNEL',
        mrkdwn: true,
        text: expect.stringMatching(/\$1,234,567/),
      }),
    );
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*New Trade Request*');
    expect(payload.text).toContain('REQ-99');
  });
});

describe('notifyExclusionChange', () => {
  it('does nothing when Slack is disabled (no token)', async () => {
    const { notifyExclusionChange } = await import('../slack.js');
    notifyExclusionChange({
      clientId: 'C-1',
      clientName: 'Acme',
      ticker: 'TSLA',
      kind: 'advisor',
      reason: 'concentration',
      noBuy: true,
      noSell: true,
      action: 'added',
      changedBy: 'Rachel',
    });
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('posts an "added" message including reason and the DNB+DNS side', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionChange } = await import('../slack.js');
    notifyExclusionChange({
      clientId: 'C-7',
      clientName: 'Smith Family',
      ticker: 'TSLA',
      kind: 'advisor',
      reason: 'Concentration risk',
      noBuy: true,
      noSell: true,
      action: 'added',
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string; channel: string };
    expect(payload.channel).toBe('C_TRADING');
    expect(payload.text).toContain('*Exclusion added*');
    expect(payload.text).toContain('Smith Family');
    expect(payload.text).toContain('TSLA');
    expect(payload.text).toContain('advisor');
    expect(payload.text).toContain('Side: DNB+DNS');
    expect(payload.text).toContain('Concentration risk');
    expect(payload.text).toContain('Changed by: Rachel');
  });

  it('omits the "Reason" line when reason is empty', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionChange } = await import('../slack.js');
    notifyExclusionChange({
      clientId: 'C-8',
      clientName: 'Doe',
      ticker: 'XOM',
      kind: 'client',
      reason: '',
      noBuy: true,
      noSell: false,
      action: 'removed',
      changedBy: 'Sam',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*Exclusion removed*');
    expect(payload.text).toContain('Side: DNB');
    expect(payload.text).not.toContain('Reason:');
  });

  it('renders the DNS-only side correctly (v3.4)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionChange } = await import('../slack.js');
    notifyExclusionChange({
      clientId: 'C-9',
      clientName: 'Kim',
      ticker: 'AAPL',
      kind: 'advisor',
      reason: 'Low basis',
      noBuy: false,
      noSell: true,
      action: 'added',
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('Side: DNS');
    expect(payload.text).not.toContain('Side: DNB');
  });
});

describe('notifyExclusionBatchChange (v3.3 + v3.4)', () => {
  it('does nothing when Slack is disabled', async () => {
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Acme',
      added: [{ ticker: 'TSLA', kind: 'advisor', reason: 'r', noBuy: true, noSell: true }],
      removed: [],
      changed: [],
      changedBy: 'Rachel',
    });
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('does nothing when added, removed, AND changed are all empty', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Acme',
      added: [],
      removed: [],
      changed: [],
      changedBy: 'Rachel',
    });
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('uses singular "Exclusion added" header when exactly one add is in the batch (and renders side)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Smith Household',
      added: [{ ticker: 'TSLA', kind: 'advisor', reason: 'Concentration', noBuy: true, noSell: false }],
      removed: [],
      changed: [],
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*Exclusion added* for *Smith Household*');
    expect(payload.text).toContain('Added:');
    expect(payload.text).toContain('`TSLA` (advisor, DNB) — Concentration');
    expect(payload.text).toContain('Changed by: Rachel');
    expect(payload.text).not.toContain('Removed:');
    expect(payload.text).not.toContain('Changed:');
  });

  it('uses pluralized "N exclusions added" header when multiple adds in the batch (with mixed sides)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Smith',
      added: [
        { ticker: 'TSLA', kind: 'advisor', reason: 'Concentration', noBuy: true, noSell: true },
        { ticker: 'AAPL', kind: 'client', reason: '', noBuy: false, noSell: true },
      ],
      removed: [],
      changed: [],
      changedBy: 'Sam',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*2 exclusions added* for *Smith*');
    expect(payload.text).toContain('`TSLA` (advisor, DNB+DNS) — Concentration');
    expect(payload.text).toContain('`AAPL` (client, DNS)');
    expect(payload.text).not.toMatch(/`AAPL` \(client, DNS\) —/); // no em-dash for empty reason
  });

  it('uses "N exclusions updated" header and renders both sections when adds AND removes are present', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Doe Household',
      added: [{ ticker: 'NEW', kind: 'advisor', reason: 'fresh', noBuy: true, noSell: true }],
      removed: [{ ticker: 'OLD', kind: 'client', reason: 'stale', noBuy: true, noSell: false }],
      changed: [],
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*2 exclusions updated* for *Doe Household*');
    expect(payload.text).toContain('Added:');
    expect(payload.text).toContain('Removed:');
    expect(payload.text).toContain('`NEW` (advisor, DNB+DNS) — fresh');
    expect(payload.text).toContain('`OLD` (client, DNB) — stale');
  });

  it('renders the Changed: section with before → after transitions for edit-only batches (v3.4)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Smith',
      added: [],
      removed: [],
      changed: [
        {
          ticker: 'NVDA',
          kind: 'advisor',
          before: { noBuy: true, noSell: true },
          after: { noBuy: true, noSell: false },
        },
      ],
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*Exclusion updated* for *Smith*');
    expect(payload.text).toContain('Changed:');
    expect(payload.text).toContain('`NVDA` (advisor): DNB+DNS → DNB');
    expect(payload.text).not.toContain('Added:');
    expect(payload.text).not.toContain('Removed:');
  });

  it('uses generic "N exclusions updated" header when buckets are mixed (add + edit)', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Mixed',
      added: [{ ticker: 'NEW', kind: 'advisor', reason: '', noBuy: true, noSell: true }],
      removed: [],
      changed: [
        {
          ticker: 'NVDA',
          kind: 'advisor',
          before: { noBuy: true, noSell: true },
          after: { noBuy: false, noSell: true },
        },
      ],
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*2 exclusions updated* for *Mixed*');
    expect(payload.text).toContain('Added:');
    expect(payload.text).toContain('Changed:');
    expect(payload.text).toContain('`NVDA` (advisor): DNB+DNS → DNS');
  });

  it('pluralizes "N exclusions updated" header for multi-edit-only batches', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'Multi',
      added: [],
      removed: [],
      changed: [
        {
          ticker: 'NVDA',
          kind: 'advisor',
          before: { noBuy: true, noSell: true },
          after: { noBuy: true, noSell: false },
        },
        {
          ticker: 'TSLA',
          kind: 'advisor',
          before: { noBuy: false, noSell: true },
          after: { noBuy: true, noSell: true },
        },
      ],
      changedBy: 'Sam',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('*2 exclusions updated* for *Multi*');
    expect(payload.text).toContain('`NVDA` (advisor): DNB+DNS → DNB');
    expect(payload.text).toContain('`TSLA` (advisor): DNS → DNB+DNS');
  });

  it('escapes Slack markup characters in clientName, ticker, and reason', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TRADING';
    const { notifyExclusionBatchChange } = await import('../slack.js');
    notifyExclusionBatchChange({
      clientId: 'C-1',
      clientName: 'A & B <Trust>',
      added: [{ ticker: 'X&Y', kind: 'advisor', reason: '<flag>', noBuy: true, noSell: true }],
      removed: [],
      changed: [],
      changedBy: 'Rachel',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    const payload = postMessageMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('A &amp; B &lt;Trust&gt;');
    expect(payload.text).toContain('X&amp;Y');
    expect(payload.text).toContain('&lt;flag&gt;');
  });
});

describe('notifyStatusChange', () => {
  it('does nothing when advisorSlackId is null', async () => {
    const { notifyStatusChange } = await import('../slack.js');
    notifyStatusChange({
      requestId: 'REQ-1',
      clientName: 'Test',
      newStatus: 'Approved',
      note: '',
      changedBy: 'Trader',
      advisorSlackId: null,
    });
  });

  it('DMs advisor when advisorSlackId is set', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const { notifyStatusChange } = await import('../slack.js');
    notifyStatusChange({
      requestId: 'REQ-2',
      clientName: 'Client Co',
      newStatus: 'Done',
      note: 'All good',
      changedBy: 'Ops',
      advisorSlackId: 'U_ADVISOR',
    });
    await expect.poll(() => postMessageMock.mock.calls.length).toBeGreaterThan(0);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'U_ADVISOR',
        mrkdwn: true,
        text: expect.stringContaining('REQ-2'),
      }),
    );
    const payload = postMessageMock.mock.calls[0][0] as { text: string; channel: string };
    expect(payload.channel).toBe('U_ADVISOR');
    expect(payload.text).toContain('Client Co');
    expect(payload.text).toContain('Done');
  });
});
