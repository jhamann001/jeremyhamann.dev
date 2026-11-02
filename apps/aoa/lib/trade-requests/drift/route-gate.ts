import "server-only";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { tradeRequestsDriftRoutesEnabled } from "@/lib/flags";
import { appWritesPaused } from "@/lib/maintenance";
import { isAoaServed } from "@/lib/trade-requests/serving-state";

// Gate for the drift read and override routes (ticket). Refused (404) unless the epic switch is on and Trade
// Requests are AOA-served; reads for ADMIN, OPERATIONS and ADVISOR; override writes for ADMIN and OPERATIONS
// (the standalone "trader" role). The role is read from the stored AOA user on every call.
export const DRIFT_HEADERS = { "Cache-Control": "no-store, private", Vary: "Cookie" } as const;
export const driftJson = (body: unknown, status = 200) => Response.json(body, { status, headers: DRIFT_HEADERS });

export type DriftActor = { aoaUserId: string; email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
const READ_ROLES: ReadonlySet<string> = new Set(["ADMIN", "OPERATIONS", "ADVISOR"]);
const WRITE_ROLES: ReadonlySet<string> = new Set(["ADMIN", "OPERATIONS"]);

export async function driftRouteGate(request: Request, access: "read" | "write"): Promise<{ refused: Response } | { actor: DriftActor }> {
  if (!tradeRequestsDriftRoutesEnabled() || !(await isAoaServed())) return { refused: driftJson({ error: "not_found" }, 404) };
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || (access === "write" && site !== "same-origin")) return { refused: driftJson({ error: "forbidden" }, 403) };
  if (access === "write" && appWritesPaused()) return { refused: driftJson({ error: "writes_paused" }, 503) };
  let session;
  try {
    session = await auth();
  } catch {
    return { refused: driftJson({ error: "unavailable" }, 503) };
  }
  const userId = session?.user?.id;
  if (!userId) return { refused: driftJson({ error: "unauthorized" }, 401) };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, email: true, name: true } });
  if (!user || !(access === "write" ? WRITE_ROLES : READ_ROLES).has(user.role)) return { refused: driftJson({ error: "forbidden" }, 403) };
  const email = user.email ?? "";
  return { actor: { aoaUserId: userId, email, name: (user.name?.trim() || email).slice(0, 255), role: user.role as DriftActor["role"] } };
}
