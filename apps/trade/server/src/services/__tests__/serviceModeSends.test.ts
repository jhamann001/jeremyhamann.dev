import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Slack and email stay silent while the service is frozen or MCP-only (ticket). The mode comes from
// SERVICE_MODE_OVERRIDE here; serviceMode.test.ts covers the same gate fed by a database read.
const { postMessageMock, sendMailMock } = vi.hoisted(() => ({
  postMessageMock: vi.fn().mockResolvedValue({ ok: true }),
  sendMailMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function WebClient() {
    return { chat: { postMessage: postMessageMock } };
  }),
}));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock })) } }));
vi.mock('../../lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_CHANNEL_ID = 'C-TEST';
  process.env.DRIFT_SLACK_CHANNEL_ID = 'C-DRIFT';
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_USER = 'sender@example.test';
  process.env.SMTP_PASS = 'x';
});

afterEach(() => {
  for (const key of [
    'SERVICE_MODE_OVERRIDE',
    'SLACK_BOT_TOKEN',
    'SLACK_CHANNEL_ID',
    'DRIFT_SLACK_CHANNEL_ID',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
  ]) {
    delete process.env[key];
  }
});

describe('Slack and email while the service is not active', () => {
  it('frozen: a channel message is not posted', async () => {
    process.env.SERVICE_MODE_OVERRIDE = 'frozen';
    const { sendChannelMessage } = await import('../slack.js');
    await sendChannelMessage('hello');
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('frozen: a new-request notification is not posted', async () => {
    process.env.SERVICE_MODE_OVERRIDE = 'frozen';
    const { notifyNewRequest } = await import('../slack.js');
    notifyNewRequest({
      requestId: 'REQ-1',
      clientName: 'Synthetic Client',
      tradeType: 'Rebalance',
      priority: 'Standard',
      submittedBy: 'Synthetic Advisor',
      totalValue: 1,
      accounts: ['A1'],
    });
    await flush();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('MCP-only: a drift channel message is not posted', async () => {
    process.env.SERVICE_MODE_OVERRIDE = 'mcp-only';
    const { sendDriftChannelMessage } = await import('../slack.js');
    await sendDriftChannelMessage('drift');
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('frozen: an invite email is not sent', async () => {
    process.env.SERVICE_MODE_OVERRIDE = 'frozen';
    const { sendInviteEmail } = await import('../email.js');
    await sendInviteEmail({ to: 'invitee@example.test', inviteeName: 'Invitee', role: 'advisor', invitedBy: 'Ops' });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('active: a channel message is posted (today)', async () => {
    const { sendChannelMessage } = await import('../slack.js');
    await sendChannelMessage('hello');
    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });
});
