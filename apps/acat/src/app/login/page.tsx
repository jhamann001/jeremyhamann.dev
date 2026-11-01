"use client";

import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Lock,
  Shield,
} from "lucide-react";
import { Suspense, useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import { PortfolioLink } from "@/components/PortfolioLink";
import { demoMode } from "@/lib/demo/mode";
import { PERSONAS } from "@/lib/demo/personas";

const DEV_AUTH_BYPASS =
  process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "1";

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied:
    "Access denied. Only example.com accounts are permitted.",
  OAuthAccountNotLinked:
    "This email is already linked to another sign-in method.",
  Default: "Something went wrong during sign-in. Please try again.",
};

function safeCallbackUrl(raw: string | null): string {
  if (!raw) return "/";
  try {
    const parsed = new URL(raw, "http://acat.local");
    if (parsed.origin !== "http://acat.local") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function LoginForm() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const reason = searchParams.get("reason");
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));
  const errorMessage = error
    ? ERROR_MESSAGES[error] ?? ERROR_MESSAGES.Default
    : null;
  const [devEmail, setDevEmail] = useState("jeremy@example.com");
  // Demo: sign in as one of the persona staff instead of with Google.
  const demo = demoMode();

  return (
    <div className="grid min-h-full grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
      {/* ── BRAND PANEL (always dark, part of the brand not the surface) ── */}
      <aside
        className="relative hidden overflow-hidden px-14 py-12 lg:flex lg:flex-col lg:justify-between"
        style={{
          background: `radial-gradient(1200px 600px at -10% -20%, rgba(60,180,122,0.10), transparent 60%),
            radial-gradient(900px 500px at 110% 110%, rgba(74,127,181,0.08), transparent 60%),
            linear-gradient(180deg, #0d100f 0%, #0a0a0a 100%)`,
          color: "#f8f7f4",
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)`,
            backgroundSize: "56px 56px",
            WebkitMaskImage:
              "radial-gradient(800px 500px at 30% 40%, #000 30%, transparent 80%)",
            maskImage:
              "radial-gradient(800px 500px at 30% 40%, #000 30%, transparent 80%)",
          }}
        />

        {/* Logomark + wordmark + brand tag */}
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="flex h-[34px] w-[34px] items-center justify-center rounded-lg text-[19px] font-semibold leading-none"
            style={{
              background: "#ffffff",
              color: "#1a1a1a",
              fontFamily: "var(--font-serif)",
              boxShadow:
                "0 6px 18px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.6)",
            }}
          >
            C
          </div>
          <div
            className="text-[22px] leading-none"
            style={{ fontFamily: "var(--font-serif)", color: "#f8f7f4" }}
          >
            Cedar Ridge
          </div>
          <span
            className="ml-auto inline-flex items-center gap-2 rounded-full px-[11px] py-1.5 text-[10.5px] font-medium"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "rgba(255,255,255,0.72)",
              letterSpacing: "0.04em",
            }}
          >
            <span
              className="h-[5px] w-[5px] rounded-full"
              style={{
                background: "#3cb47a",
                boxShadow: "0 0 0 3px rgba(60,180,122,0.18)",
              }}
            />
            Transfer Tracker &amp; Recon
          </span>
        </div>

        {/* Hero copy */}
        <div className="relative z-10 mt-14 max-w-[560px]">
          <div
            className="mb-[18px] inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase"
            style={{
              letterSpacing: "0.18em",
              color: "rgba(255,255,255,0.55)",
            }}
          >
            <span
              className="h-px w-[22px]"
              style={{ background: "rgba(255,255,255,0.4)" }}
            />
            Operations, rewired
          </div>
          <h1
            className="mb-[18px] text-[46px] font-normal leading-[1.08] tracking-[-0.01em]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Track every ACAT.
            <br />
            Reconcile{" "}
            <em
              style={{ fontStyle: "italic", color: "#8fd4b0", fontWeight: 500 }}
            >
              every position.
            </em>
          </h1>
          <p
            className="max-w-[480px] text-[14.5px] leading-[1.55]"
            style={{ color: "rgba(255,255,255,0.62)" }}
          >
            The internal workspace Cedar Ridge Wealth uses to move client accounts
            across custodians, watch transfers in flight, and close the loop on
            every fee and asset issue.
          </p>
        </div>

        {/* Live pipeline preview */}
        <div
          className="relative z-10 mt-auto max-w-[560px] rounded-2xl p-5"
          style={{
            background: "rgba(255,255,255,0.04)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 40px 80px -40px rgba(0,0,0,0.6)",
          }}
        >
          <div className="mb-3.5 flex items-center justify-between">
            <div
              className="flex items-center gap-2 text-[11px] font-semibold uppercase"
              style={{
                letterSpacing: "0.1em",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              <span
                className="h-[5px] w-[5px] rounded-full"
                style={{
                  background: "#3cb47a",
                  animation: "login-pulse 2s ease-in-out infinite",
                }}
              />
              Live pipeline
            </div>
            <div
              className="text-[10.5px]"
              style={{
                color: "rgba(255,255,255,0.45)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {demo ? "Demo data" : "Today"}
            </div>
          </div>

          <div className="flex flex-col gap-[7px]">
            <PreviewRow
              initials="OH"
              name="Okafor Household"
              meta="CTL-10421 · Fidelity → Apex · 6 assets"
              badge="sub"
              badgeLabel="In Transit"
            />
            <PreviewRow
              initials="AF"
              name="Alvarez Family"
              meta="CTL-10398 · Schwab → Apex · 7 assets"
              badge="ok"
              badgeLabel="Completed"
            />
            <PreviewRow
              initials="NH"
              name="Nakamura Household"
              meta="Schwab → Apex · 7 assets"
              badge="wait"
              badgeLabel="Waiting"
            />
          </div>

          <div
            className="mt-3.5 grid grid-cols-3 gap-2 border-t pt-3.5"
            style={{ borderColor: "rgba(255,255,255,0.06)" }}
          >
            <PreviewStat
              label="Active"
              value="17"
              color="#e0bc6a"
              sub="$6.4M in flight"
            />
            <PreviewStat
              label="Completed"
              value="101"
              color="#8fd4b0"
              sub="since January"
            />
            <PreviewStat
              label="Recon health"
              value="99%"
              color="#ffffff"
              sub="1 issue open"
            />
          </div>
        </div>

        <div
          className="relative z-10 mt-7 flex items-center gap-4 text-[11px]"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          <span>© 2026 Cedar Ridge Wealth</span>
          <span
            className="h-[3px] w-[3px] rounded-full"
            style={{ background: "rgba(255,255,255,0.3)" }}
          />
          <span>{demo ? "Demo · v1.0" : "Internal tool · v1.0"}</span>
          {demo && (
            <>
              <span
                className="h-[3px] w-[3px] rounded-full"
                style={{ background: "rgba(255,255,255,0.3)" }}
              />
              <span>Synthetic data, reset nightly</span>
            </>
          )}
        </div>

        <style>{`@keyframes login-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }`}</style>
      </aside>

      {/* ── SIGN-IN PANEL ── */}
      <section className="relative flex min-h-full flex-col bg-[var(--bg)] px-6 py-8 sm:px-10">
        <div className="flex items-center justify-end gap-3 text-xs text-muted-faint">
          {demo ? (
            <>
              <PortfolioLink />
              <span className="flex-1" />
              <span className="hidden sm:inline">New teammate? Ask an admin.</span>
            </>
          ) : (
            <>
              <span className="hidden sm:inline">New teammate?</span>
              <a
                href="mailto:jeremy@example.com?subject=Transfer%20Tracker%20access"
                className="border-b border-dashed border-card-border font-medium text-muted-strong transition hover:text-foreground"
              >
                Request access →
              </a>
            </>
          )}
          <ThemeToggle className="ml-2" />
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full min-w-0 max-w-[420px]">
            <div className="mb-3.5 inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: "var(--status-green-dot)",
                  boxShadow: "0 0 0 3px rgba(60,180,122,0.18)",
                }}
              />
              {demo ? "Sign in" : "Secure sign-in"}
            </div>
            <h2
              className="mb-2.5 text-[34px] font-medium leading-[1.12] tracking-[-0.01em] text-foreground"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Welcome back to{" "}
              <em className="font-normal italic text-muted-strong">
                the recon desk.
              </em>
            </h2>
            <p className="mb-7 text-sm leading-[1.6] text-muted">
              {demo
                ? "Pick one of Cedar Ridge’s staff to continue. No password needed in the demo."
                : "Sign in with your Cedar Ridge Wealth Google account to continue."}
            </p>

            {(reason === "timeout" || reason === "expired") && (
              <div
                className="mb-5 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[12.5px] leading-snug"
                style={{
                  background: "var(--warning-bg)",
                  borderColor: "var(--warning-border)",
                  color: "var(--warning)",
                }}
              >
                <Clock size={16} className="mt-0.5 shrink-0" />
                <span>
                  {reason === "timeout"
                    ? "You were signed out due to inactivity."
                    : "Your session expired. Please sign in again."}
                </span>
              </div>
            )}

            {errorMessage && (
              <div
                className="mb-5 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[12.5px] leading-snug"
                style={{
                  background: "var(--danger-bg)",
                  borderColor: "var(--danger-border)",
                  color: "var(--danger)",
                }}
              >
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {demo ? (
              <div className="flex flex-col gap-2">
                {PERSONAS.map((persona) => (
                  <button
                    key={persona.email}
                    type="button"
                    onClick={() => signIn("persona", { email: persona.email, callbackUrl })}
                    className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-[var(--bg-card)] px-3.5 py-3 text-left shadow-sm transition hover:-translate-y-px hover:bg-[var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-[var(--bg)]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-[var(--bg-hover)] text-xs font-semibold text-muted-strong">
                      {persona.name.split(" ").map((part) => part[0]).join("")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">{persona.name}</span>
                      <span className="block text-[12.5px] text-muted sm:truncate">{persona.blurb}</span>
                    </span>
                    <span className="shrink-0 rounded-full border border-card-border px-2 py-0.5 text-[11px] font-semibold text-muted-strong">
                      {persona.label}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
            <button
              type="button"
              onClick={() => signIn("google", { callbackUrl })}
              className="flex w-full items-center justify-center gap-3 rounded-xl px-[18px] py-[14px] text-sm font-semibold transition hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-[var(--bg)]"
              style={{
                background: "var(--invert-bg)",
                color: "var(--invert-text)",
                boxShadow:
                  "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px -4px rgba(0,0,0,0.08)",
              }}
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
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
              <ArrowRight size={16} className="ml-auto opacity-60" />
            </button>
            )}

            {DEV_AUTH_BYPASS && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  signIn("dev", { email: devEmail, callbackUrl });
                }}
                className="mt-4 rounded-xl border border-dashed border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-3"
              >
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--warning)]">
                  <AlertTriangle size={11} />
                  Dev sign-in (non-production only)
                </div>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={devEmail}
                    onChange={(e) => setDevEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="flex-1 rounded-md border border-card-border bg-[var(--bg-card)] px-3 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-[var(--invert-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90"
                  >
                    Sign in
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] text-muted">
                  Email must exist in the allow-list.
                </p>
              </form>
            )}

            {!demo && (
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-faint">
              <span>Trouble signing in?</span>
              <span className="h-[3px] w-[3px] rounded-full bg-[var(--muted-faint)]" />
              <a
                href="#"
                className="font-medium text-muted transition hover:text-foreground"
              >
                Check status
              </a>
              <span className="h-[3px] w-[3px] rounded-full bg-[var(--muted-faint)]" />
              <a
                href="mailto:jeremy@example.com"
                className="font-medium text-muted transition hover:text-foreground"
              >
                Email Jeremy
              </a>
            </div>
            )}

            <div className="mt-9 grid grid-cols-2 gap-4 border-t border-card-border pt-[22px]">
              {demo ? (
                <>
                  <TrustItem
                    icon={<Shield className="h-3 w-3" />}
                    label="Sign-in"
                    value="Demo personas"
                    sub="No Google OAuth, no passwords"
                  />
                  <TrustItem
                    icon={<Clock className="h-3 w-3" />}
                    label="Data"
                    value="Resets nightly"
                    sub="07:00 UTC, to the seed"
                  />
                </>
              ) : (
                <>
                  <TrustItem
                    icon={<Shield className="h-3 w-3" />}
                    label="Auth"
                    value="Google OAuth 2.0"
                    sub="SSO · 2-factor enforced"
                  />
                  <TrustItem
                    icon={<Lock className="h-3 w-3" />}
                    label="Data"
                    value="Encrypted at rest"
                    sub="Audit log · TLS 1.3"
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-y-2 pt-6 text-[11px] text-muted-faint">
          <div>
            {demo
              ? "Synthetic data · every name and number is invented"
              : "Protected by Google OAuth · Internal use only"}
          </div>
          {!demo && (
          <div className="flex items-center gap-1.5">
            <span>Press</span>
            <kbd
              className="inline-flex items-center rounded border border-card-border px-1.5 py-0.5 text-[10px] text-muted"
              style={{
                background: "var(--fill-2)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ↵
            </kbd>
            <span>to sign in</span>
          </div>
          )}
        </div>
      </section>
    </div>
  );
}

type BadgeKind = "ok" | "sub" | "wait";

function PreviewRow({
  initials,
  name,
  meta,
  badge,
  badgeLabel,
}: {
  initials: string;
  name: string;
  meta: string;
  badge: BadgeKind;
  badgeLabel: string;
}) {
  const palette: Record<
    BadgeKind,
    { bg: string; text: string; border: string; dot: string }
  > = {
    ok: {
      bg: "rgba(60,180,122,0.14)",
      text: "#8fd4b0",
      border: "rgba(60,180,122,0.28)",
      dot: "#3cb47a",
    },
    sub: {
      bg: "rgba(74,127,181,0.14)",
      text: "#8db5de",
      border: "rgba(74,127,181,0.28)",
      dot: "#4a7fb5",
    },
    wait: {
      bg: "rgba(196,154,60,0.14)",
      text: "#e0bc6a",
      border: "rgba(196,154,60,0.28)",
      dot: "#c49a3c",
    },
  };
  const c = palette[badge];

  return (
    <div
      className="flex items-center gap-2.5 rounded-[9px] px-[11px] py-2.5"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
        style={{
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(255,255,255,0.85)",
        }}
      >
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-white">{name}</div>
        <div
          className="mt-0.5 text-[10.5px]"
          style={{
            color: "rgba(255,255,255,0.45)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {meta}
        </div>
      </div>
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9.5px] font-semibold"
        style={{
          background: c.bg,
          color: c.text,
          border: `1px solid ${c.border}`,
        }}
      >
        <span
          className="h-[5px] w-[5px] rounded-full"
          style={{ background: c.dot }}
        />
        {badgeLabel}
      </span>
    </div>
  );
}

function PreviewStat({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub: string;
}) {
  return (
    <div>
      <div
        className="text-[9.5px] font-semibold uppercase"
        style={{
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.42)",
        }}
      >
        {label}
      </div>
      <div
        className="mt-[3px] text-[18px] font-bold leading-[1.1]"
        style={{ color }}
      >
        {value}
      </div>
      <div
        className="mt-0.5 text-[10px]"
        style={{ color: "rgba(255,255,255,0.4)" }}
      >
        {sub}
      </div>
    </div>
  );
}

function TrustItem({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-faint">
        {icon}
        {label}
      </div>
      <div className="text-xs font-semibold text-foreground">{value}</div>
      <div className="text-[10.5px] text-muted-faint">{sub}</div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
