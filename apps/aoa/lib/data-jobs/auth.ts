import "server-only";
import { OAuth2Client } from "google-auth-library";
import { appWritesPaused } from "@/lib/maintenance";
import { DATA_JOB_PROVIDER_CONFIG } from "./registry";
const verifier = new OAuth2Client();

/** Dedicated Google OIDC identity; neither browser sessions nor ingest tokens can collect. */
export async function requireDataJobsCollectorAuth(req: Request): Promise<boolean> {
  if (appWritesPaused()) return false;
  const audience = process.env.DATA_JOB_COLLECTOR_AUDIENCE;
  const email = process.env.DATA_JOB_COLLECTOR_SERVICE_ACCOUNT;
  const environment = process.env.APP_ENV;
  const config = environment === "dev" || environment === "prod" ? DATA_JOB_PROVIDER_CONFIG[environment] : null;
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!config || !audience || !email || !/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+\.iam\.gserviceaccount\.com$/.test(email)
    || !email.endsWith(`@${config.gcpProject}.iam.gserviceaccount.com`) || !match) return false;
  try {
    const url = new URL(audience);
    if (url.protocol !== "https:" || url.origin !== config.aoaOrigin || url.pathname !== "/api/cron/data-jobs" || url.search || url.hash
      || url.username || url.password || new URL(req.url).pathname !== url.pathname) return false;
    const payload = (await verifier.verifyIdToken({ idToken: match[1], audience })).getPayload();
    return Boolean(payload && ["https://accounts.google.com", "accounts.google.com"].includes(payload.iss)
      && payload.email_verified === true && payload.email === email);
  } catch { return false; }
}
