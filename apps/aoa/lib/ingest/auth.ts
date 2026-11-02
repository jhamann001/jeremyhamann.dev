import crypto from "crypto";
import { appWritesPaused } from "@/lib/maintenance";

/**
 * Bearer-token gate for the ingest endpoints (TDD ADR-3). Returns a boolean-
 * shaped result; the route maps `!ok` → 401 `{ error: "unauthorized" }`.
 *
 * Fail closed by construction:
 *  - `AOA_WRITES_PAUSED` set to any non-false value → `{ ok: false }`, even
 *    with the correct token. The owner-gated dev cleanup uses this as an
 *    application-boundary maintenance lock for every ingest and cron writer.
 *  - `INGEST_TOKEN` unset/empty → `{ ok: false }` + a counts-free config-error
 *    log (a misconfiguration, worth surfacing — but NEVER the header value).
 *  - missing `Authorization` header, wrong scheme, or empty token →
 *    `{ ok: false }` with NO log (a bad caller, not a misconfig).
 *  - constant-time compare over the SHA-256 DIGESTS of the presented token and
 *    the env token. Digesting first makes both buffers 32 bytes, so
 *    `timingSafeEqual` never throws on a length mismatch and never
 *    short-circuits on length.
 *
 * The env var is read AT CALL TIME (not module load): tests toggle it in-process
 * per-case, and a prod secret resolves at instance start.
 *
 * This function NEVER logs, echoes, or returns the token or the presented
 * header — only the boolean.
 */
export function requireIngestToken(req: Request): { ok: true } | { ok: false } {
  if (appWritesPaused()) return { ok: false };

  const configured = process.env.INGEST_TOKEN;
  if (!configured) {
    // Counts-free config-error line — no header value, no token.
    console.warn("[ingest] INGEST_TOKEN not configured — refusing all requests");
    return { ok: false };
  }

  const header = req.headers.get("authorization");
  if (!header) return { ok: false };

  // Parse `Bearer <token>` — exactly two space-separated parts, scheme "Bearer".
  const [scheme, presented] = header.split(" ");
  if (scheme !== "Bearer" || !presented) return { ok: false };

  // SHA-256 both sides → fixed 32-byte buffers → timingSafeEqual is safe and
  // length-oblivious.
  const presentedDigest = crypto.createHash("sha256").update(presented).digest();
  const configuredDigest = crypto.createHash("sha256").update(configured).digest();

  return crypto.timingSafeEqual(presentedDigest, configuredDigest)
    ? { ok: true }
    : { ok: false };
}
