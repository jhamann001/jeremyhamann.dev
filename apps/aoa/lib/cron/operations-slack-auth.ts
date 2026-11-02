import "server-only";

import { OAuth2Client } from "google-auth-library";
import { appWritesPaused } from "@/lib/maintenance";

const verifier = new OAuth2Client();
const PATH = "/api/cron/operations-slack";
const AUDIENCE = `https://aoa.jeremyhamann.dev${PATH}`;

/** Dedicated OIDC identity only. Shared ingest tokens cannot send Slack. */
export async function requireOperationsSlackCronAuth(req: Request): Promise<boolean> {
  if (appWritesPaused() || process.env.APP_ENV !== "prod") return false;
  const email = process.env.OPERATIONS_SLACK_SCHEDULER_SERVICE_ACCOUNT?.trim();
  const [scheme, token, extra] = (req.headers.get("authorization") ?? "").split(" ");
  if (!email || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@ops-portal\.iam\.gserviceaccount\.com$/.test(email)
    || new URL(req.url).pathname !== PATH || scheme !== "Bearer" || !token || extra) return false;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience: AUDIENCE });
    const payload = ticket.getPayload();
    return payload?.email_verified === true && payload.email === email
      && (payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com");
  } catch {
    // Never log the token, claims, request headers, or upstream response.
    return false;
  }
}
