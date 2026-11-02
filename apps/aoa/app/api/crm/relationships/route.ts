import { auth } from "@/auth";
import { crmRelationshipsEnabled } from "@/lib/flags";
import { canReadCrmRelationships } from "@/lib/data/crm-relationships";
import { getCrmRelationshipWorkspace } from "@/lib/data/crm-relationship-workspace";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!crmRelationshipsEnabled() || !canReadCrmRelationships(role)) {
    return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const rootIdentityId = new URL(request.url).searchParams.get("root")?.trim() ?? "";
  const result = await getCrmRelationshipWorkspace(
    { role, email: session.user.email ?? null },
    rootIdentityId,
  );
  if (!result.ok) {
    const status = result.reason === "row_limit_exceeded" ? 422 : 404;
    return Response.json({ error: "not_available" }, { status, headers: NO_STORE_HEADERS });
  }
  return Response.json({ data: result.data }, { headers: NO_STORE_HEADERS });
}
