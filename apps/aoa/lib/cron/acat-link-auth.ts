import "server-only";
import { OAuth2Client } from "google-auth-library";
import { appWritesPaused } from "@/lib/maintenance";
import { requireIngestToken } from "@/lib/ingest/auth";

const verifier = new OAuth2Client();
const PATH = "/api/cron/acat-link-sync";

/** Dedicated scheduler identity; the shared ingest token remains available
 * for authorized manual runs. Tokens and verifier errors never enter logs. */
export async function requireAcatLinkCronAuth(req: Request): Promise<boolean> {
  if (appWritesPaused() || req.method !== "POST" || new URL(req.url).pathname !== PATH) return false;
  const [scheme, token, extra] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token || extra !== undefined) return false;
  if (process.env.INGEST_TOKEN && requireIngestToken(req).ok) return true;

  const audience = process.env.ACAT_LINK_SCHEDULER_AUDIENCE?.trim();
  const email = process.env.ACAT_LINK_SCHEDULER_SERVICE_ACCOUNT?.trim().toLowerCase();
  if (!audience || !email || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email)) return false;
  try {
    const url = new URL(audience);
    if (url.protocol !== "https:" || url.pathname !== PATH || url.search || url.hash || url.username || url.password) return false;
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return (payload?.iss === "https://accounts.google.com" || payload?.iss === "accounts.google.com")
      && payload.email_verified === true && payload.email?.toLowerCase() === email;
  } catch { return false; }
}
