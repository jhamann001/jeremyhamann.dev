import "server-only";
import { OAuth2Client } from "google-auth-library";
import { appWritesPaused } from "@/lib/maintenance";

const verifier = new OAuth2Client();
const PATH = "/api/cron/custodian-projection";

export async function requireCustodianProjectionCronAuth(req: Request): Promise<boolean> {
  if (appWritesPaused() || req.method !== "POST" || new URL(req.url).pathname !== PATH) return false;
  const [scheme, token, extra] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token || extra !== undefined) return false;
  const audience = process.env.CUSTODIAN_PROJECTION_SCHEDULER_AUDIENCE?.trim();
  const email = process.env.CUSTODIAN_PROJECTION_SCHEDULER_SERVICE_ACCOUNT?.trim().toLowerCase();
  if (!audience || !email || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email)) return false;
  try {
    const url = new URL(audience);
    if (url.protocol !== "https:" || url.pathname !== PATH || url.search || url.hash || url.username || url.password) return false;
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return (payload?.iss === "https://accounts.google.com" || payload?.iss === "accounts.google.com")
      && payload.email_verified === true && payload.email?.toLowerCase() === email;
  } catch {
    return false;
  }
}
