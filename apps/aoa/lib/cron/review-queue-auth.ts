import "server-only";

import { OAuth2Client } from "google-auth-library";
import { appWritesPaused } from "@/lib/maintenance";
import { requireIngestToken } from "@/lib/ingest/auth";

const verifier = new OAuth2Client();

/**
 * Authenticate a review-queue cron request without putting the shared ingest
 * bearer in Cloud Scheduler or Terraform state. Interactive/manual operations
 * may still use the existing ingest bearer; the recurring scheduler uses a
 * Google-signed OIDC token whose audience and service-account email must both
 * match the exact non-secret runtime configuration.
 */
export async function requireReviewQueueCronAuth(req: Request): Promise<boolean> {
  if (appWritesPaused()) return false;
  if (requireIngestToken(req).ok) return true;

  const audience = process.env.REVIEW_QUEUE_SCHEDULER_AUDIENCE?.trim();
  const expectedEmail = process.env.REVIEW_QUEUE_SCHEDULER_SERVICE_ACCOUNT
    ?.trim()
    .toLowerCase();
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token, extra] = header.split(" ");
  const requestUrl = new URL(req.url);
  let configuredAudience: URL | null = null;
  try {
    configuredAudience = audience ? new URL(audience) : null;
  } catch {
    configuredAudience = null;
  }
  // The JWT verifier below binds the token to the exact canonical audience
  // (scheme, host, and path). For request routing, compare the path separately:
  // reverse proxies may reconstruct req.url with an internal origin, and
  // forwarded host headers are not a trustworthy authorization input. This
  // path check prevents a valid scheduler token from replaying onto /validate.
  if (
    !audience ||
    !configuredAudience ||
    configuredAudience.pathname !== requestUrl.pathname ||
    !expectedEmail ||
    scheme !== "Bearer" ||
    !token ||
    extra
  ) {
    return false;
  }

  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    const issuer = payload?.iss;
    return (
      (issuer === "https://accounts.google.com" || issuer === "accounts.google.com") &&
      payload?.email_verified === true &&
      payload.email?.toLowerCase() === expectedEmail
    );
  } catch {
    // Static, deliberately silent rejection: JWTs, claims, and callers never
    // enter application logs. Cloud Scheduler retains only the HTTP status.
    return false;
  }
}
