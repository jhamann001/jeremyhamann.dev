import Link from "next/link";
import { auth, signIn } from "@/auth";
import { DEV_LOGIN } from "@/lib/auth/mode";
import { portfolioLink } from "@/lib/demo/mode";
import { PERSONAS, personaSignInEnabled } from "@/lib/demo/personas";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ClearNavigationMemory } from "@/components/navigation/ListNavigationBoundary";
import styles from "./page.module.css";

// Dev-login personas (must match the seeded users in prisma/seed.ts).
const DEV_PERSONAS = [
  { email: "ops@example.com", label: "Riley Ops · OPERATIONS (sees all)" },
  { email: "admin@example.com", label: "Dana Admin · ADMIN (sees all)" },
  { email: "avery@example.com", label: "Avery Stone · ADVISOR (own book)" },
  { email: "blake@example.com", label: "Gwen Kuhlman · ADVISOR (own book)" },
  { email: "view@example.com", label: "Val Viewer · VIEWER (sees none)" },
];

// Where to send the user after a successful sign-in. Defaults to the post-login
// home (TDD ADR-3). If middleware bounced them here from a protected route it
// passes the original path as ?callbackUrl — but we ONLY honor a same-origin,
// absolute in-app path (starts with a single "/"): reject "//host", "/\host",
// and anything with a scheme, so a crafted callbackUrl can't become an open
// redirect. (auth.ts's redirect callback also fails closed on foreign origins.)
function safeDest(callbackUrl?: string): string {
  if (
    typeof callbackUrl === "string" &&
    callbackUrl.startsWith("/") &&
    !callbackUrl.startsWith("//") &&
    !callbackUrl.startsWith("/\\")
  ) {
    return callbackUrl;
  }
  return "/command-center";
}

// Friendly copy for the errors Auth.js can hand back on ?error=.
function errorMessage(error?: string): string | null {
  if (!error) return null;
  switch (error) {
    case "AccessDenied":
      return "Your account isn't authorized for this app. Contact your administrator.";
    case "Configuration":
      return "Sign-in is temporarily unavailable due to a configuration issue. Please try again shortly.";
    case "Verification":
      return "That sign-in link has expired. Please sign in again.";
    default:
      return "We couldn't sign you in. Please try again.";
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  const sp = await searchParams;
  const dest = safeDest(sp.callbackUrl);
  const errMsg = errorMessage(sp.error);
  // The public demo offers its four personas (lib/demo/personas.ts); local dev keeps the seed's.
  const demo = personaSignInEnabled();
  const personas = demo ? PERSONAS : DEV_PERSONAS;

  return (
    <main className={styles.screen}>
      {!session?.user && <ClearNavigationMemory />}
      <div className={styles.card}>
        <div className={styles.accent} />
        <div className={styles.toggle}>
          <ThemeToggle />
        </div>

        <div className={styles.brand}>
          <div className={styles.mono}>c</div>
          <div>
            <div className={styles.wm}>Cedar Ridge Wealth</div>
            <div className={styles.kick}>Always-On Advice</div>
          </div>
        </div>

        <div className={styles.divider} />

        {session?.user ? (
          <>
            <h1 className={styles.title}>You&apos;re signed in</h1>
            <p className={styles.signedin}>Signed in as {session.user.email}</p>
            <Link className={styles.okta} href="/command-center" style={{ textDecoration: "none" }}>
              Go to Command Center
            </Link>
          </>
        ) : !DEV_LOGIN ? (
          <>
            <h1 className={styles.title}>Welcome back</h1>
            <p className={styles.sub}>
              Sign in with your Cedar Ridge Okta account to continue to the advisor workspace.
            </p>
            {errMsg && <div className={styles.error}>{errMsg}</div>}
            <form
              action={async () => {
                "use server";
                await signIn("okta", { redirectTo: dest });
              }}
            >
              <button className={styles.okta} type="submit">
                <LockIcon />
                Sign in with Okta
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className={styles.title}>{demo ? "Choose a persona" : "Dev sign-in"}</h1>
            <p className={styles.devnote}>
              {demo
                ? "A portfolio demo of Always-On-Advice at an invented firm. Pick a role to see what that person sees. Every person, account and record is made up, and it all resets nightly."
                : "Non-production environment — pick a persona to exercise role-based RLS. Production uses Okta; this dev login is disabled there."}
            </p>
            {errMsg && <div className={styles.error}>{errMsg}</div>}
            <div className={styles.personas}>
              {personas.map((p) => (
                <form
                  key={p.email}
                  action={async () => {
                    "use server";
                    await signIn("dev", { email: p.email, redirectTo: dest });
                  }}
                >
                  <button className={styles.persona} type="submit">
                    {p.label}
                  </button>
                </form>
              ))}
            </div>
            {demo && <SecurityNote />}
          </>
        )}

        <div className={styles.foot}>
          {demo ? "Persona sign-in" : "Secured by Okta"}<span className={styles.dot}>•</span>Cedar Ridge Wealth
        </div>
      </div>
    </main>
  );
}

function LockIcon() {
  return (
    <svg className={styles.lock} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" fill="currentColor" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

// The demo's note on how it protects data, under the personas. It links to the case study's security section on the
// portfolio site when the demo image knows that site (NEXT_PUBLIC_PORTFOLIO_URL).
function SecurityNote() {
  const site = portfolioLink();
  return (
    <p className={styles.securitynote}>
      <strong>Security:</strong> Every page is served over HTTPS with HSTS and a strict Content Security Policy. The
      database accepts only encrypted connections and keeps its data encrypted at rest, and row-level security decides
      what each persona can read. Account numbers show only their last four digits, your IP address is replaced with a
      keyed hash before the app sees it, and secrets are kept out of the code.
      {site && (
        <>
          {" "}
          <a href={new URL("/projects/always-on-advice#security", site.url).href}>
            How the production app handles it&nbsp;→
          </a>
        </>
      )}
    </p>
  );
}
