import "server-only";
import { OAuth2Client } from "google-auth-library";
import { appWritesPaused } from "@/lib/maintenance";

const verifier = new OAuth2Client();
export const TRADE_REQUEST_DRIFT_CRON_PATH = "/api/cron/trade-request-drift";
const SCHEDULER_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@ops-portal(-dev)?\.iam\.gserviceaccount\.com$/;

/** Dedicated scheduler OIDC identity only (ticket): live mode can post to Slack, so the shared ingest token is
 * not accepted. Tokens, claims and verifier errors never enter logs. */
export async function requireTradeRequestDriftCronAuth(req: Request): Promise<boolean> {
  if (appWritesPaused() || req.method !== "POST" || new URL(req.url).pathname !== TRADE_REQUEST_DRIFT_CRON_PATH) return false;
  const [scheme, token, extra] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token || extra !== undefined) return false;
  const audience = process.env.TRADE_REQUEST_DRIFT_SCHEDULER_AUDIENCE?.trim();
  const email = process.env.TRADE_REQUEST_DRIFT_SCHEDULER_SERVICE_ACCOUNT?.trim().toLowerCase();
  if (!audience || !email || !SCHEDULER_ACCOUNT.test(email)) return false;
  try {
    const url = new URL(audience);
    if (url.protocol !== "https:" || url.pathname !== TRADE_REQUEST_DRIFT_CRON_PATH || url.search || url.hash || url.username || url.password) return false;
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return (payload?.iss === "https://accounts.google.com" || payload?.iss === "accounts.google.com")
      && payload.email_verified === true && payload.email?.toLowerCase() === email;
  } catch {
    return false;
  }
}
