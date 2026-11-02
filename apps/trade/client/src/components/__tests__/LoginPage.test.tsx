import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LoginPage } from '../LoginPage';
import { signInReturnPath } from '../../utils/signInPath';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  fetchAppConfig: vi.fn(),
  fetchSignInOptions: vi.fn(),
  signInAsPersona: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('../../api/client', () => ({
  fetchAppConfig: () => mocks.fetchAppConfig(),
  fetchSignInOptions: () => mocks.fetchSignInOptions(),
  signInAsPersona: (email: string, mcpState?: string) => mocks.signInAsPersona(email, mcpState),
  extractApiError: (_err: unknown, fallback: string) => fallback,
}));

const PERSONAS = [
  { email: 'ethan.cole@example.com', name: 'Ethan Cole', role: 'trader', title: 'Trader' },
  { email: 'rachel.moss@example.com', name: 'Rachel Moss', role: 'advisor', title: 'Advisor' },
];

describe('LoginPage', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      user: null,
      actualUser: null,
      loading: false,
      error: null,
      logout: async () => {},
      refresh: async () => {},
      roleOverride: null,
      setRoleOverride: () => {},
    });
    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['example.com'], sessionTtlMs: 3600000 });
    mocks.fetchSignInOptions.mockResolvedValue({ google: true, personas: [] });
    Object.defineProperty(window, 'location', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: new URL('http://localhost/login'),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('renders sign-in button with Google link', async () => {
    render(<LoginPage />);
    const link = await screen.findByRole('link', { name: /sign in with google/i });
    expect(link).toHaveAttribute('href', '/auth/google');
  });

  it("shows 'Welcome back' heading", () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
  });

  it('displays domain restriction text when fetchAppConfig resolves', async () => {
    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['acme.corp'], sessionTtlMs: 3600000 });
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/restricted to/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/@acme\.corp/)).toBeInTheDocument();
  });

  it('shows error message when ?error=unauthorized in URL', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: new URL('http://localhost/login?error=unauthorized'),
    });

    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['allowed.org'], sessionTtlMs: 3600000 });
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/only @allowed\.org accounts are permitted/i)).toBeInTheDocument();
    });
  });

  it('still offers Google when the sign-in options cannot be read', async () => {
    mocks.fetchSignInOptions.mockRejectedValue(new Error('offline'));
    render(<LoginPage />);
    expect(await screen.findByRole('link', { name: /sign in with google/i })).toBeInTheDocument();
  });

  describe('demo personas', () => {
    beforeEach(() => {
      mocks.fetchSignInOptions.mockResolvedValue({ google: false, personas: PERSONAS });
    });

    it('lists the personas and leaves Google out when it is not configured', async () => {
      render(<LoginPage />);
      expect(await screen.findByRole('button', { name: /ethan cole/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /rachel moss/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /try the demo/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /sign in with google/i })).not.toBeInTheDocument();
    });

    it('signs in as the chosen persona and goes home', async () => {
      mocks.signInAsPersona.mockResolvedValue({});
      // A plain location, so the page can navigate by assigning href.
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: { href: 'http://localhost/login', search: '' },
      });
      render(<LoginPage />);
      fireEvent.click(await screen.findByRole('button', { name: /rachel moss/i }));
      await waitFor(() => expect(mocks.signInAsPersona).toHaveBeenCalledWith('rachel.moss@example.com', undefined));
      await waitFor(() => expect(window.location.href).toBe('/'));
    });

    it('signs in and stays on the request link it was opened on (a link from another demo)', async () => {
      mocks.signInAsPersona.mockResolvedValue({});
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: { href: 'http://localhost/queue/REQ-00001045', pathname: '/queue/REQ-00001045', search: '' },
      });
      render(<LoginPage />);
      fireEvent.click(await screen.findByRole('button', { name: /ethan cole/i }));
      await waitFor(() => expect(window.location.href).toBe('/queue/REQ-00001045'));
    });

    it('returns only to a path on this site, and never to the sign-in page', () => {
      expect(signInReturnPath({ pathname: '/queue/REQ-00001045', search: '?x=1' })).toBe('/queue/REQ-00001045?x=1');
      expect(signInReturnPath({ pathname: '/login', search: '?error=unauthorized' })).toBe('/');
      expect(signInReturnPath({ pathname: '//evil.example/x', search: '' })).toBe('/');
      expect(signInReturnPath({ pathname: '', search: '' })).toBe('/');
    });

    it('finishes an MCP connection by sending the browser back to the MCP client', async () => {
      mocks.signInAsPersona.mockResolvedValue({ redirect: 'http://127.0.0.1:5555/callback?code=abc&state=xyz' });
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: { href: 'http://localhost/login?mcp=st8', search: '?mcp=st8' },
      });
      render(<LoginPage />);
      expect(await screen.findByRole('heading', { name: /connect your ai assistant/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /ethan cole/i }));
      await waitFor(() => expect(mocks.signInAsPersona).toHaveBeenCalledWith('ethan.cole@example.com', 'st8'));
      await waitFor(() => expect(window.location.href).toBe('http://127.0.0.1:5555/callback?code=abc&state=xyz'));
    });

    it('shows an error when sign-in fails', async () => {
      mocks.signInAsPersona.mockRejectedValue(new Error('nope'));
      render(<LoginPage />);
      fireEvent.click(await screen.findByRole('button', { name: /ethan cole/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/sign-in failed/i);
    });
  });
});
