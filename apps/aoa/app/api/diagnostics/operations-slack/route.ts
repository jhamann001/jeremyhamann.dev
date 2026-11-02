import { auth } from "@/auth";
import { readOperationsSlackDiagnostic } from "@/lib/data/operations-slack-diagnostic";
import { operationsSlackDiagnosticSchema } from "@/lib/operations/operations-slack-diagnostic-contract";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const error = (status: number) => Response.json({ error: "Operations Slack diagnostic unavailable" }, { status, headers });

export async function GET(request: Request): Promise<Response> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return error(403);
  let session;
  try { session = await auth(); }
  catch { return error(503); }
  if (!session?.user) return error(401);
  const role = (session.user as { role?: string }).role;
  const email = session.user.email;
  const expiresAt = Date.parse(session.expires);
  if ((role !== "ADMIN" && role !== "OPERATIONS") || typeof email !== "string" || !email.trim()
    || !session.navigationScope || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return error(403);
  if (new URL(request.url).search) return error(400);
  if (request.signal.aborted) return error(503);
  try {
    const result = operationsSlackDiagnosticSchema.parse(await readOperationsSlackDiagnostic({ role, email }));
    if (Date.now() >= expiresAt || request.signal.aborted) return error(503);
    return Response.json(result, { headers });
  } catch {
    // Never log raw database errors, client fields, claim tokens or credentials.
    return error(503);
  }
}
