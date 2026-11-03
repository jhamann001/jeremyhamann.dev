import { useState, useEffect, useRef } from 'react';
import { FileText, ListChecks, Activity } from 'lucide-react';
import { PortfolioLink } from './PortfolioLink';
import { useAuth } from '../contexts/AuthContext';
import { fetchAppConfig, fetchSignInOptions, signInAsPersona, extractApiError, type Persona, type SignInOptions } from '../api/client';
import { signInReturnPath } from '../utils/signInPath';

const FEATURES = [
  { icon: FileText, label: 'Trade request tickets', color: 'green' },
  { icon: ListChecks, label: 'Approval workflows', color: 'blue' },
  { icon: Activity, label: 'Portfolio drift analysis', color: 'yellow' },
] as const;

const ICON_COLORS = {
  green: 'bg-[var(--green-light)] text-[var(--green)]',
  blue: 'bg-[var(--blue-light)] text-[var(--blue-muted)]',
  yellow: 'bg-[var(--yellow-light)] text-[var(--yellow)]',
} as const;

// Static, decorative snapshot of the drift view — illustrative figures only.
const DRIFT_BUCKETS = [
  // Mirrors the real per-bucket comparison: live position % vs Meridian
  // template %, with the resulting Δpp. Equity breaches the 5pp tolerance.
  { bucket: 'Cash', position: 6.7, template: 10, delta: -3.3, breach: false },
  { bucket: 'Fixed', position: 27.1, template: 30, delta: -2.9, breach: false },
  { bucket: 'Equity', position: 66.2, template: 60, delta: 6.2, breach: true },
] as const;

function DriftSnapshot() {
  return (
    <div
      aria-hidden="true"
      className="rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-[0_2px_12px_rgba(0,0,0,0.04)]"
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-label)]">Account drift</p>
            <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border)]">
              Sample data
            </span>
          </div>
          <p className="font-serif text-[16px] text-[var(--text-primary)] leading-tight mt-0.5">
            Sample Brokerage — ACWI Risk 12
          </p>
        </div>
        <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-md bg-[var(--yellow-light)] text-[var(--yellow)]">
          Out of tolerance
        </span>
      </div>

      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            <th className="text-left font-medium pb-1.5">Bucket</th>
            <th className="text-right font-medium pb-1.5">Position %</th>
            <th className="text-right font-medium pb-1.5">Template %</th>
            <th className="text-right font-medium pb-1.5">Δpp</th>
          </tr>
        </thead>
        <tbody>
          {DRIFT_BUCKETS.map(({ bucket, position, template, delta, breach }) => (
            <tr key={bucket} className="border-t border-[var(--border-light)]">
              <td className="py-1.5 text-[var(--text-primary)]">{bucket}</td>
              <td className="py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{position.toFixed(2)}%</td>
              <td className="py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{template.toFixed(2)}%</td>
              <td
                className={`py-1.5 text-right tabular-nums font-semibold ${
                  breach ? 'text-[var(--yellow)]' : 'text-[var(--text-secondary)]'
                }`}
              >
                {delta > 0 ? '+' : ''}
                {delta.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-[10px] text-[var(--text-muted)] mt-3 pt-2.5 border-t border-[var(--border-light)]">
        5pp tolerance · illustrative figures, not live data
      </p>
    </div>
  );
}

const ROLE_BLURB = {
  advisor: 'Submits trade requests for clients',
  trader: 'Reviews, approves and executes requests',
} as const;

function GoogleButton() {
  return (
    <a
      href="/auth/google"
      className="flex items-center justify-center gap-3 w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-5 py-4 text-[16px] font-medium text-[var(--text-primary)] shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:bg-[var(--bg-surface)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-all"
    >
        <svg width="22" height="22" viewBox="0 0 24 24">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
      Sign in with Google
    </a>
  );
}

function PersonaButton({ persona, busy, disabled, onSelect }: { persona: Persona; busy: boolean; disabled: boolean; onSelect: () => void }) {
  const initials = persona.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="flex items-center gap-4 w-full text-left bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-4 py-3.5 hover:bg-[var(--bg-surface)] hover:border-[var(--green)] transition-colors disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        className={`w-10 h-10 rounded-full flex items-center justify-center text-[14px] font-semibold shrink-0 ${
          persona.role === 'trader' ? ICON_COLORS.blue : ICON_COLORS.green
        }`}
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-[var(--text-primary)]">{persona.name}</span>
        <span className="block text-[13px] text-[var(--text-muted)]">
          {persona.title} · {ROLE_BLURB[persona.role]}
        </span>
      </span>
      {busy && <span className="text-[12px] text-[var(--text-muted)]">Signing in…</span>}
    </button>
  );
}

export function LoginPage() {
  const { user } = useAuth();
  const [domains, setDomains] = useState<string[]>([]);
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  // Set when an MCP client (such as Claude) is connecting: the chosen persona is who it will act as.
  const mcpState = params.get('mcp') ?? undefined;
  const personas = options?.personas ?? [];
  // Offer Google when it is configured, and as before when the options can't be read.
  const showGoogle = options ? options.google : optionsFailed;

  useEffect(() => {
    if (user && !mcpState) {
      window.location.href = '/';
    }
  }, [user, mcpState]);

  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on mount too: React's development double-mount runs the cleanup once before the real mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    fetchAppConfig()
      .then((c) => {
        if (mountedRef.current) setDomains(c.allowedDomains);
      })
      .catch(() => {});
    fetchSignInOptions()
      .then((o) => {
        if (mountedRef.current) setOptions(o);
      })
      .catch(() => {
        if (mountedRef.current) setOptionsFailed(true);
      });
  }, []);

  const signIn = async (persona: Persona) => {
    setSigningIn(persona.email);
    setPersonaError(null);
    try {
      const { redirect } = await signInAsPersona(persona.email, mcpState);
      window.location.href = redirect ?? signInReturnPath();
    } catch (err) {
      if (!mountedRef.current) return;
      setPersonaError(extractApiError(err, 'Sign-in failed. Please try again.'));
      setSigningIn(null);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-page)] flex flex-col md:flex-row font-sans">
      {/* Left branding panel */}
      <div className="flex-1 relative overflow-hidden bg-[var(--bg-surface)] border-b md:border-b-0 md:border-r border-[var(--border-light)] flex flex-col justify-center items-center px-6 py-10 md:px-12 md:py-16 lg:px-16 xl:px-20">
        <div className="login-glow-top" />
        <div className="login-glow-bottom" />
        {/* Above the content on a phone; pinned to the panel's corner from md up. */}
        <PortfolioLink className="relative z-20 self-start mb-6 md:mb-0 md:absolute md:top-5 md:left-8 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 shadow-sm" />

        <div className="relative z-10 w-full max-w-[480px] lg:max-w-[560px]">
          <h1 className="font-serif text-[40px] lg:text-[46px] font-medium tracking-tight text-[var(--text-primary)] leading-none">
            cedarRidge<sup className="text-[14px] italic text-[var(--text-muted)]">.ai</sup>
          </h1>
          <p className="text-[15px] lg:text-[16px] text-[var(--text-muted)] tracking-wide mt-1.5">Trade Center</p>

          <div className="w-10 h-0.5 bg-[var(--green)] rounded-full opacity-60 my-8" />

          <p className="text-[16px] lg:text-[18px] leading-relaxed text-[var(--text-secondary)] mb-8">
            Submit, review, and approve trade tickets — now with portfolio drift analysis to see where each account sits
            against its target.
          </p>

          <DriftSnapshot />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5 mt-9">
            {FEATURES.map(({ icon: Icon, label, color }) => (
              <div key={label} className="flex items-center gap-3">
                <div
                  className={`w-[36px] h-[36px] rounded-[9px] flex items-center justify-center shrink-0 ${ICON_COLORS[color]}`}
                >
                  <Icon size={18} />
                </div>
                <span className="text-[14px] lg:text-[15px] font-semibold text-[var(--text-primary)] leading-snug">
                  {label}
                </span>
              </div>
            ))}
          </div>

          <p className="hidden md:block mt-14 text-[12px] text-[var(--text-muted)] opacity-60">
            {personas.length > 0
              ? 'A demo firm: every person, client, account and number here is invented.'
              : 'Internal use only \u2014 CedarRidge Wealth'}
          </p>
        </div>
      </div>

      {/* Right login panel */}
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-card)] px-6 py-10 md:px-12 md:py-16 lg:px-16">
        <div className="w-full max-w-[400px] lg:max-w-[440px]">
          <h2 className="font-serif text-[30px] lg:text-[34px] font-medium text-[var(--text-primary)] mb-2.5">
            {personas.length > 0 ? (mcpState ? 'Connect your AI assistant' : 'Try the demo') : 'Welcome back'}
          </h2>
          <p className="text-[15px] lg:text-[16px] text-[var(--text-muted)] leading-relaxed mb-8">
            {personas.length > 0
              ? mcpState
                ? 'Choose who your MCP client will act as. Its tools are read-only and see what that person can see.'
                : 'Sign in as one of the firm\u2019s advisors or traders. No password needed, and everything resets every night.'
              : 'Sign in with your organization account to continue.'}
          </p>

          {error && (
            <div className="mb-6 bg-[var(--red-light)] border border-[var(--red-border)] rounded-xl px-4 py-3 text-[13px] text-[var(--red)]">
              {error === 'unauthorized'
                ? domains.length > 0
                  ? `Only ${domains.map((d) => `@${d}`).join(' or ')} accounts are permitted.`
                  : 'Your account is not permitted.'
                : 'Authentication failed. Please try again.'}
            </div>
          )}

          {personaError && (
            <div
              role="alert"
              className="mb-6 bg-[var(--red-light)] border border-[var(--red-border)] rounded-xl px-4 py-3 text-[13px] text-[var(--red)]"
            >
              {personaError}
            </div>
          )}

          {personas.length > 0 && (
            <div className="space-y-3">
              {personas.map((p) => (
                <PersonaButton
                  key={p.email}
                  persona={p}
                  busy={signingIn === p.email}
                  disabled={signingIn !== null}
                  onSelect={() => void signIn(p)}
                />
              ))}
            </div>
          )}

          {personas.length > 0 && <SecurityNote />}

          {showGoogle && (
            <>
              {personas.length > 0 && <div className="my-6 border-t border-[var(--border-light)]" />}
              <GoogleButton />
              <p className="text-center text-[13px] text-[var(--text-muted)] mt-6">
                {domains.length > 0 ? (
                  <>
                    Restricted to{' '}
                    {domains.map((d, i) => (
                      <span key={d}>
                        {i > 0 && ' & '}
                        <span className="font-medium">@{d}</span>
                      </span>
                    ))}{' '}
                    accounts
                  </>
                ) : (
                  'Restricted to organization accounts'
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// How the demo protects data, under the personas. In --text-secondary: --text-muted is too faint to read. It links
// to the case study's security section when the image is built with VITE_PORTFOLIO_URL.
function SecurityNote() {
  const url = import.meta.env.VITE_PORTFOLIO_URL;
  return (
    <p className="mt-6 text-[13px] leading-relaxed text-[var(--text-secondary)]">
      <strong className="font-semibold">Security:</strong> Every page is served over HTTPS with HSTS. Sessions are kept
      on the server behind HttpOnly, Secure cookies with CSRF protection, and the logger strips credentials and personal
      details before anything is written. The database is reached over TLS with a verified certificate and keeps its
      data encrypted at rest, and secrets are kept out of the code.
      {url && (
        <>
          {' '}
          <a
            href={new URL('/projects/trade-request#security', url).href}
            className="whitespace-nowrap underline underline-offset-2 hover:text-[var(--text-primary)]"
          >
            How the production app handles it&nbsp;→
          </a>
        </>
      )}
    </p>
  );
}
