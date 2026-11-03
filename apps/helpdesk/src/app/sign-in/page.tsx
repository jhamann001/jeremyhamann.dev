import { ChevronRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StickyActionBar } from "@/components/shell/sticky-action-bar";
import { isGoogleConfigured, isOktaConfigured } from "@/auth.config";
import { DEV_PERSONAS, isDevLoginEnabled } from "@/lib/dev-login";
import { demoMode } from "@/lib/demo/mode";
import { PortfolioLink, portfolioSite } from "@/components/demo/portfolio-link";
import { allowedGoogleDomains } from "@/lib/google-domain";
import { cn } from "@/lib/utils";
import { signInWithGoogle, signInWithOkta } from "./sign-in.actions";

// The kill switch and the error/callback params are evaluated per request, never baked at build time.
export const dynamic = "force-dynamic";

/**
 * Auth.js `?error=` values are mapped to fixed copy. The raw parameter is never echoed: it is
 * caller-controlled and the sign-in page is public.
 *
 * Copy rule: every line here names a group that actually exists. "the help desk administrator"
 * was a role nobody held, so a locked-out person had nobody to ask; `user:admin` belongs to
 * `ops_team`, which the app labels "Operations", so that is who the copy names.
 * `AccessDenied` now also covers a deactivated account, which is a thing Operations
 * can reverse — the old wording read as a permanent verdict. It covers the temporary Google domain gate
 * too: a Google address outside the allowlist, or one Google has not verified, is refused with no session
 * at all, and someone who just clicked "Continue with a Google account" needs to be told that is why.
 *
 * Two lines were also DE-OKTA'd by the same change, and are named here so the rewording is not read back
 * later as copy that was always generic: `OAuthSignin` ("Could not start the Okta sign-in") and
 * `OAuthCallbackError` ("Okta did not complete the sign-in") are now provider-neutral, because either
 * provider can raise them and naming the wrong one sends the reader to the wrong place. Everything else
 * in this table is unchanged, `OAuthAccountNotLinked` included — it is the answer a Google sign-in gets
 * when a `User` row already holds that email, and it is fail-closed.
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  Configuration: "Sign-in is not configured correctly. Contact the Operations team.",
  AccessDenied:
    "Your account cannot sign in. It may have been deactivated here, your Okta groups may not grant access, or you used a Google account outside the approved company domains — the Operations team can check all three.",
  Verification: "The sign-in link is no longer valid. Start again.",
  OAuthSignin: "Could not start the sign-in. Try again.",
  OAuthCallbackError: "The identity provider did not complete the sign-in. Try again.",
  OAuthCreateAccount: "Your account could not be created. Contact the Operations team.",
  OAuthAccountNotLinked: "This email is already linked to a different sign-in method.",
  Callback: "Sign-in could not be completed. Try again.",
  CredentialsSignin: "That development persona could not be signed in.",
  SessionRequired: "Sign in to continue.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? "Sign-in failed. Try again.";
}

/**
 * Where access comes from on THIS instance. The card used to say "your Okta group membership"
 * unconditionally, which is wrong on exactly the environment the temporary Google provider exists for: a
 * Google-only service takes its groups from `AUTH_GOOGLE_GROUPS`, and by default that list is empty,
 * so the most common outcome is /no-access with a previous screen that named a system nobody signed in
 * through. Same copy rule as ERROR_MESSAGES above — every line names something that actually exists here.
 */
function accessDescription(okta: boolean, google: boolean): string {
  if (okta) return "Staff sign-in. Access is granted by your Okta group membership.";
  if (google) return "Staff sign-in. Access is granted by the groups configured for company Google accounts.";
  return "Staff sign-in. Access is granted by your group membership.";
}

/**
 * Layout is phone-first: when a real sign-in method is configured the primary CTA
 * is a sticky bottom bar on phones and the in-card button from `md`; with neither Okta nor Google there is no
 * sticky bar (a disabled sticky CTA is noise — the personas are the actions). Auth behaviour is unchanged and
 * stays S1's.
 *
 * The bar used to key on Okta alone. It now keys on "Okta OR Google", because a Google-only dev service is
 * exactly the environment this temporary provider exists for, and on a phone the bar IS the sign-in button —
 * keying it on Okta would have left that instance with no visible action below `md`. When both are
 * configured Okta is the primary CTA and Google the secondary, in the card and in the bar.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}): Promise<React.JSX.Element> {
  const { callbackUrl, error } = await searchParams;
  // The action re-validates with safeRelativePath; an unsafe value simply lands on /dashboard.
  const target = callbackUrl ?? "/dashboard";
  const message = errorMessage(error);
  const devLogin = isDevLoginEnabled();
  const okta = isOktaConfigured();
  const google = isGoogleConfigured();
  // Read from the environment, never from `searchParams`: nothing caller-controlled is echoed into this page.
  const googleDomains = google ? allowedGoogleDomains().map((d) => `@${d}`).join(", ") : "";

  // The public demo shows only its four personas: no Okta or Google section (that code stays, unconfigured).
  if (devLogin && demoMode()) return <DemoSignIn target={target} message={message} />;

  return (
    <main
      className={cn(
        "flex min-h-svh flex-col items-center bg-background px-safe pt-6 sm:justify-center sm:pt-10",
        // Reserve the sticky bar's height only when the bar exists; the bar is md:hidden, so the
        // reservation must hold until md as well (sm:py-10 would have uncovered it at 640–767).
        okta || google ? "pb-bar-safe md:pb-10" : "pb-10",
      )}
    >
      <div className="flex w-full max-w-md flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">WM Help Desk</CardTitle>
            <CardDescription>{accessDescription(okta, google)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {message ? (
              <Alert variant="destructive">
                <AlertTitle>Sign-in problem</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            {okta ? (
              <form action={signInWithOkta.bind(null, target)} className="hidden md:block">
                <Button type="submit" className="hidden w-full md:inline-flex" size="lg">
                  Continue with Okta
                </Button>
              </form>
            ) : (
              <div className="flex flex-col gap-2">
                <Button type="button" className="w-full" size="lg" disabled>
                  Continue with Okta
                </Button>
                <p className="text-xs text-muted-foreground">
                  Okta single sign-on is not configured in this environment (AUTH_OKTA_ISSUER / AUTH_OKTA_ID /
                  AUTH_OKTA_SECRET are unset).{google ? " Use a company Google account." : ""}
                  {devLogin ? " Use a development persona below." : ""}
                </p>
              </div>
            )}
            {google ? (
              <div className="flex flex-col gap-2">
                {/* Hidden below `md` for the same reason the Okta form is: the sticky bar carries the action
                    on a phone. The line underneath is NOT hidden — the bar has no room for it, and the domain
                    restriction is the one thing someone needs to read before clicking. */}
                <form action={signInWithGoogle.bind(null, target)} className="hidden md:block">
                  <Button
                    type="submit"
                    variant={okta ? "outline" : "default"}
                    className="hidden w-full md:inline-flex"
                    size="lg"
                  >
                    Continue with a Google account
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">
                  Google sign-in is temporary, and only {googleDomains} accounts are accepted.
                </p>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Every sign-in, ticket view and change is recorded in the compliance audit log.
            </p>
          </CardContent>
        </Card>

        {devLogin ? (
          <Card className="border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30" size="sm">
            <CardHeader>
              <CardTitle className="text-amber-950 dark:text-amber-100">
                Development personas — not available in production
              </CardTitle>
              <CardDescription>
                Fixed test identities enabled by <code>AUTH_DEV_LOGIN=true</code>. Sessions are flagged
                &ldquo;DEV LOGIN&rdquo; in the topbar.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {DEV_PERSONAS.map((p, i) => (
                <div key={p.key} className="flex flex-col gap-3">
                  {i > 0 ? <Separator /> : null}
                  <form method="post" action="/sign-in/persona" className="flex flex-col gap-1.5">
                    <input type="hidden" name="persona" value={p.key} />
                    <input type="hidden" name="callbackUrl" value={target} />
                    <Button type="submit" variant="outline" className="w-full justify-between">
                      {p.name}
                      <ChevronRight aria-hidden />
                    </Button>
                    <div className="flex flex-wrap gap-1">
                      {p.groups.map((g) => (
                        <Badge key={g} variant="secondary">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  </form>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {okta || google ? (
        <StickyActionBar label="Sign in">
          {okta ? (
            <form action={signInWithOkta.bind(null, target)} className="flex-1">
              <Button type="submit" size="lg" className="w-full">
                Continue with Okta
              </Button>
            </form>
          ) : null}
          {google ? (
            <form action={signInWithGoogle.bind(null, target)} className="flex-1">
              {/* Secondary when Okta is there, and shortened so two full-width buttons still fit one bar. */}
              <Button type="submit" size="lg" variant={okta ? "outline" : "default"} className="w-full">
                {okta ? "Google" : "Continue with a Google account"}
              </Button>
            </form>
          ) : null}
        </StickyActionBar>
      ) : null}
    </main>
  );
}

/**
 * The demo's sign-in: four staff from the invented firm, each with the groups that decide what they can see
 * and do. Signing in uses the source's own persona provider; the sessions are flagged in the topbar.
 */
function DemoSignIn({ target, message }: { target: string; message: string | null }): React.JSX.Element {
  return (
    <main className="flex min-h-svh flex-col items-center bg-background px-safe pt-6 pb-10 sm:justify-center sm:pt-10">
      <div className="flex w-full max-w-md flex-col gap-4">
        <PortfolioLink />
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">WM Help Desk</CardTitle>
            <CardDescription>
              The internal help desk of an invented wealth-management firm. Sign in as one of four staff: each
              sees and does only what their group allows. Every person, account and ticket is invented, and the
              desk resets daily at 14:00 UTC.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {message ? (
              <Alert variant="destructive">
                <AlertTitle>Sign-in problem</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            {DEV_PERSONAS.map((p, i) => (
              <div key={p.key} className="flex flex-col gap-3">
                {i > 0 ? <Separator /> : null}
                <form method="post" action="/sign-in/persona" className="flex flex-col gap-1.5">
                  <input type="hidden" name="persona" value={p.key} />
                  <input type="hidden" name="callbackUrl" value={target} />
                  <Button type="submit" variant="outline" className="min-h-11 w-full justify-between">
                    {p.name}
                    <ChevronRight aria-hidden />
                  </Button>
                  <p className="text-xs text-muted-foreground">{p.title}</p>
                  <div className="flex flex-wrap gap-1">
                    {p.groups.map((g) => (
                      <Badge key={g} variant="secondary">
                        {g}
                      </Badge>
                    ))}
                  </div>
                </form>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Every sign-in, ticket view and change is recorded in the compliance audit log, as it would be at a
              real firm. Sign in as Priya to read it.
            </p>
            <SecurityNote />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

/**
 * How the demo protects data, under the audit-log line. Brighter than the muted text around it, which is too faint to
 * read in dark. It links to the case study's security section when the image knows the portfolio site.
 */
function SecurityNote(): React.JSX.Element {
  const site = portfolioSite();
  return (
    <p className="text-xs text-foreground/70">
      <strong className="font-semibold">Security:</strong> Every page is served over HTTPS with HSTS. Social Security,
      card and account numbers are redacted before anything is stored, reply links are signed with HMAC, and the audit
      log is a SHA-256 hash chain that the database enforces. The database accepts only encrypted connections and keeps
      its data encrypted at rest, and its password changes on every deploy.
      {site ? (
        <>
          {" "}
          <a className="whitespace-nowrap underline underline-offset-3" href={new URL("/projects/help-desk#security", site.url).href}>
            How the production app handles it&nbsp;→
          </a>
        </>
      ) : null}
    </p>
  );
}
