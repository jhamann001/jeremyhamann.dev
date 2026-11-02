import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { tradeRequestsRosterAdminEnabled } from "@/lib/flags";
import { appWritesPaused } from "@/lib/maintenance";
import { readServingState } from "@/lib/trade-requests/serving-state";
import { changeRoster, readRoster, RosterRefusal } from "@/lib/trade-requests/roster";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

async function gate(request: Request, write: boolean): Promise<{ refused: Response } | { userId: string; email: string }> {
  if (!tradeRequestsRosterAdminEnabled() || (await readServingState()).servingSource !== "aoa") {
    return { refused: reply({ ok: false }, 404) };
  }
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || (write && site !== "same-origin")) return { refused: reply({ ok: false }, 403) };
  if (write && appWritesPaused()) return { refused: reply({ ok: false }, 503) };
  let session;
  try {
    session = await auth();
  } catch {
    return { refused: reply({ ok: false }, 503) };
  }
  const userId = session?.user?.id;
  if (!userId) return { refused: reply({ ok: false }, 401) };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, email: true } });
  if (user?.role !== "ADMIN") return { refused: reply({ ok: false }, 403) };
  return { userId, email: user.email ?? "" };
}

export async function GET(request: Request) {
  const g = await gate(request, false);
  if ("refused" in g) return g.refused;
  return reply({ ok: true, data: await readRoster() });
}

export async function POST(request: Request) {
  const g = await gate(request, true);
  if ("refused" in g) return g.refused;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const actor = { aoaUserId: g.userId, email: g.email };
  try {
    if (body?.action === "add" && typeof body.email === "string") {
      return reply({ ok: true, data: await changeRoster(actor, { action: "add", email: body.email }) });
    }
    if (body?.action === "remove" && typeof body.memberId === "string") {
      return reply({ ok: true, data: await changeRoster(actor, { action: "remove", memberId: body.memberId }) });
    }
    if (body?.action === "slack" && typeof body.memberId === "string" && (typeof body.slackUserId === "string" || body.slackUserId === null)) {
      const slackUserId = body.slackUserId === "" ? null : (body.slackUserId as string | null);
      return reply({ ok: true, data: await changeRoster(actor, { action: "slack", memberId: body.memberId, slackUserId }) });
    }
    return reply({ ok: false, outcome: "invalid" }, 400);
  } catch (err) {
    if (err instanceof RosterRefusal) {
      const status = err.code === "not_found" ? 404 : err.code === "invalid_member" || err.code === "invalid_slack_id" ? 400 : 422;
      return reply({ ok: false, outcome: err.code }, status);
    }
    throw err;
  }
}
