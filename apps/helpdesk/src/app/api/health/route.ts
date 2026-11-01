/**
 * GET /api/health — liveness/readiness probe for Cloud Run, the deploy smoke step and uptime checks
 * (mirrors OPS_PORTAL's probe).
 *
 * Public: outside the middleware matcher, no session, no viewer, NO audit row — a probe is not a view and
 * nothing here returns record content. Exposes exactly two booleans (no version, host or error text) and is
 * `Cache-Control: no-store` so every call is a fresh round trip.
 *
 *   200 {"ok":true,"db":true}   — the serving-invariant gate passed and `SELECT 1` returned;
 *   503 {"ok":false,"db":false} — either failed. The gate runs first: a misconfigured process is
 *                                 never reported healthy, so the smoke step catches it before traffic shifts.
 *
 * The ONLY route.ts besides the Auth.js handler that is exempt from guardrail G3; G13 pins its import allowlist.
 */
import { prisma } from "@/lib/db";
import { assertServingInvariants, envInvariantKeys } from "@/lib/env";
import { logError } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(): Promise<Response> {
  try {
    assertServingInvariants();
    // Cheap DB round trip: no table access, no rows of record content.
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, db: true }, { status: 200, headers: NO_STORE });
  } catch (e) {
    // CWE-209: the probe used to `console.error` a label it derived from the
    // caught error — and its fallback branch was `e.message`, which on a Prisma error names the
    // database host and user. `logError` records `errorLabel(e)` (class name + AppError code) and
    // nothing else, so no branch can leak a message. `@/lib/logger` is the third and last entry on
    // G13's closed import allowlist; it imports only `@/lib/errors` and reaches no database.
    //
    // The one thing the message carried that an operator genuinely needs is back, as a FIELD rather
    // than as text: when the serving-invariant gate refuses, `envInvariantKeys` returns the offending
    // variable NAMES off the typed error (`EnvInvariantError.keys`, src/lib/env.ts). Names, never
    // values — that is the whole reason it can be logged, and it is structural rather than a message
    // substring, so no filter has to stay correct for it to be safe. A Prisma failure returns null
    // here and the line is the class name alone, exactly as before.
    const envKeys = envInvariantKeys(e);
    logError("route:/api/health", e, envKeys === null ? undefined : { envKeys: envKeys.join(",") });
    return Response.json({ ok: false, db: false }, { status: 503, headers: NO_STORE });
  }
}
