import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { readAcatWorkspace } from "@/lib/data/acat-workspace";
import { acatWorkspaceResponseSchema } from "@/lib/data/acat-workspace-contract";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const error = (status: number) => Response.json({ error: "ACAT workspace unavailable" }, { status, headers });

export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return error(403);
  let session;
  try { session = await auth(); }
  catch { return error(503); }
  if (!session?.user) return error(401);
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const scope = session.navigationScope;
  const sessionExpiresAt = Date.parse(session.expires);
  if (!scope || !Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now() ||
      !canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) return error(403);
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  if (params.getAll("view").length !== 1 || (view !== "library" && view !== "tracking") ||
      params.getAll("refresh").length > 1 || (params.has("refresh") && params.get("refresh") !== "1") ||
      [...params.keys()].some((key) => key !== "view" && key !== "refresh")) return error(400);
  try {
    const snapshot = await readAcatWorkspace({ role, email: session.user.email ?? null }, view, params.get("refresh") === "1");
    const response = acatWorkspaceResponseSchema.parse({ snapshot, scope, sessionExpiresAt, serverNow: Date.now() });
    // A slow read must not turn an already-expired snapshot into a new lease.
    if (response.serverNow >= Math.min(snapshot.expiresAt, sessionExpiresAt)) return error(503);
    return Response.json(response, { headers });
  } catch {
    // No source errors, credentials, response bodies or client names in logs.
    return error(503);
  }
}
