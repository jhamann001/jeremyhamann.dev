// Single source of truth for whether this runtime uses the DEV persona login
// (Credentials provider + JWT sessions, no Okta) instead of prod Okta SSO.
//
// Local dev (`NODE_ENV !== "production"`) always uses it, so `npm run dev` needs
// no Okta. A DEPLOYED instance runs `NODE_ENV=production`; it opts INTO the
// persona login explicitly with `AUTH_DEV_LOGIN=1` (the aoa-dev Cloud Run
// service). The production deploy pipeline never sets that flag, so the real
// prod service stays Okta-only. The public demo opts in with `PERSONA_SIGN_IN=on`,
// which also narrows the login to its four personas (lib/demo/personas.ts).
//
// Consumed by `auth.ts` (to choose providers / session strategy / adapter) and
// the sign-in page (to show the persona picker) so both derive the mode from
// one place and can never disagree.
export const DEV_LOGIN =
  process.env.NODE_ENV !== "production" ||
  process.env.AUTH_DEV_LOGIN === "1" ||
  process.env.PERSONA_SIGN_IN === "on";
