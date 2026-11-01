/**
 * Request context for RSC pages / server actions and route handlers — node only, layer L2
 *. Computed at the point of use: there is no relay header.
 */
import { headers } from "next/headers";
import type { RequestContext } from "@/types/domain";
import { requestContextFromHeaders } from "@/lib/client-ip";
import { assertServingInvariants, env } from "@/lib/env";

/** For RSC pages and server actions (Next 15: `headers()` is async). */
export async function getRequestContext(): Promise<RequestContext> {
  // Serving-time boot gate: a production process that inherited NEXT_PHASE would have skipped
  // the boot check; this fails closed on the first request instead of serving with a spoofable audited IP.
  assertServingInvariants();
  return requestContextFromHeaders(await headers(), env.TRUSTED_PROXY_HOPS);
}

/** For route handlers, which receive the Request directly. */
export function getRequestContextFromRequest(req: Request): RequestContext {
  assertServingInvariants();
  return requestContextFromHeaders(req.headers, env.TRUSTED_PROXY_HOPS);
}
