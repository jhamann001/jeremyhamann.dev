import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn();
  const mockCreateTransport = vi.fn(() => ({
    sendMail: mockSendMail,
  }));
  return { mockSendMail, mockCreateTransport };
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}));

vi.mock('../../lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function clearSmtpEnv(): void {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_FROM;
  delete process.env.CLIENT_ORIGIN;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  clearSmtpEnv();
});

describe('sendInviteEmail', () => {
  it('throws when SMTP is not configured (no env vars)', async () => {
    vi.resetModules();
    clearSmtpEnv();
    const { sendInviteEmail } = await import('../email.js');
    await expect(
      sendInviteEmail({
        to: 'a@b.com',
        inviteeName: 'X',
        role: 'R',
        invitedBy: 'Y',
      }),
    ).rejects.toThrow('SMTP not configured — invite email cannot be sent');
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('sends email successfully when configured (mock nodemailer.createTransport)', async () => {
    vi.resetModules();
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user@test';
    process.env.SMTP_PASS = 'secret';
    mockSendMail.mockResolvedValue(undefined);
    const { sendInviteEmail } = await import('../email.js');
    await sendInviteEmail({
      to: 'invitee@test.com',
      inviteeName: 'Inv',
      role: 'Trader',
      invitedBy: 'Boss',
    });
    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.test',
      port: 587,
      secure: false,
      auth: { user: 'user@test', pass: 'secret' },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'invitee@test.com',
        from: 'user@test',
        subject: "You've been invited to the Trade Request app",
      }),
    );
  });

  it('re-throws when sendMail fails', async () => {
    vi.resetModules();
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user@test';
    process.env.SMTP_PASS = 'secret';
    mockSendMail.mockRejectedValue(new Error('smtp down'));
    const { sendInviteEmail } = await import('../email.js');
    await expect(
      sendInviteEmail({
        to: 'fail@test.com',
        inviteeName: 'X',
        role: 'R',
        invitedBy: 'Y',
      }),
    ).rejects.toThrow('smtp down');
  });

  it('email HTML contains escaped invitee name and role', async () => {
    vi.resetModules();
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user@test';
    process.env.SMTP_PASS = 'secret';
    mockSendMail.mockResolvedValue(undefined);
    const { sendInviteEmail } = await import('../email.js');
    await sendInviteEmail({
      to: 'safe@test.com',
      inviteeName: 'Bob<script>',
      role: 'Admin<img>',
      invitedBy: 'Lead',
    });
    const payload = mockSendMail.mock.calls[0][0] as { html: string };
    expect(payload.html).toContain('Bob&lt;script&gt;');
    expect(payload.html).toContain('Admin&lt;img&gt;');
    expect(payload.html).not.toContain('Bob<script>');
    expect(payload.html).not.toContain('Admin<img>');
  });

  it('uses first CLIENT_ORIGIN when comma-separated', async () => {
    vi.resetModules();
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'user@test';
    process.env.SMTP_PASS = 'secret';
    process.env.CLIENT_ORIGIN = 'https://first.example, https://second.example';
    mockSendMail.mockResolvedValue(undefined);
    const { sendInviteEmail } = await import('../email.js');
    await sendInviteEmail({
      to: 'u@test.com',
      inviteeName: 'N',
      role: 'R',
      invitedBy: 'B',
    });
    const payload = mockSendMail.mock.calls[0][0] as { html: string };
    expect(payload.html).toContain('href="https://first.example"');
    expect(payload.html).not.toContain('second.example');
  });
});
