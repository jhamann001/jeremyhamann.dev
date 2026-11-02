import type { Prisma } from "@prisma/client";
import { TRANSFER_SLACK_CLOSEOUT, writeAudit } from "@/lib/audit";
import { isCloseoutComplete } from "@/lib/data/slack-closeout-template";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";

// Slack closeout callback (SLACK_TRANSFER_CLOSEOUT). n8n calls this after it
// posts the Slack message (`type:"posted"`) and on each checkbox toggle
// (`type:"item"`). Under /api/ingest/ so it inherits the middleware Okta-redirect
// exclusion (ADR-6) and the bearer-token gate (requireIngestToken). Writes as
// ingest_rw via withIngestScope — the tables' GUC-less ingest policy admits it.
export const runtime = "nodejs";

type ErrBody = { error: string };
const err = (error: string, status: number) =>
  Response.json({ error } satisfies ErrBody, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const type = b.type;
  const transferId = b.transfer_id;
  if (
    (type !== "posted" && type !== "item") ||
    typeof transferId !== "string" ||
    !transferId
  ) {
    return err("bad_request", 400);
  }
  // A malformed body (item toggle with no item_key) is a 400, not a 404 —
  // validate it pre-scope alongside type/transfer_id (unknown ids → 404 below).
  const itemKey = b.item_key;
  if (type === "item" && (typeof itemKey !== "string" || !itemKey)) {
    return err("bad_request", 400);
  }

  try {
    // `notFound` is set inside the tx when the target row doesn't exist; we map
    // it to a 404 AFTER the tx so an unknown id is a clean 404, not a 500.
    let notFound = false;

    await withIngestScope(async (tx) => {
      if (type === "posted") {
        const channel = typeof b.channel === "string" ? b.channel : null;
        const messageTs = typeof b.message_ts === "string" ? b.message_ts : null;
        const res = await tx.transferSlackCloseout.updateMany({
          where: { transfer_id: transferId },
          data: { channel, message_ts: messageTs, posted_at: new Date() },
        });
        if (res.count === 0) notFound = true;
        return;
      }

      // type === "item" — itemKey validated pre-scope (a string by here).
      const key = itemKey as string;
      const done = b.done === true;
      const actor = typeof b.actor === "string" ? b.actor : null;
      const at =
        typeof b.at === "string" && !Number.isNaN(Date.parse(b.at))
          ? new Date(b.at)
          : new Date();

      const res = await tx.transferSlackItem.updateMany({
        where: { transfer_id: transferId, item_key: key },
        data: done
          ? { done: true, done_by: actor, done_at: at }
          : { done: false, done_by: null, done_at: null },
      });
      if (res.count === 0) {
        notFound = true;
        return;
      }

      // Completion is a RULE, not "every box" (isCloseoutComplete): the three
      // standalone items done AND Trade Instructions satisfied (Trade Center OR
      // CRM; Meridian never counts alone). Re-evaluated on every toggle so
      // unchecking a required box reverts COMPLETE → PENDING. The audit row is
      // written ONCE per completion (only on the PENDING→COMPLETE transition).
      const doneRows = await tx.transferSlackItem.findMany({
        where: { transfer_id: transferId, done: true },
        select: { item_key: true },
      });
      const complete = isCloseoutComplete(doneRows.map((r) => r.item_key));
      const cur = await tx.transferSlackCloseout.findUnique({
        where: { transfer_id: transferId },
        select: { status: true },
      });
      const wasComplete = cur?.status === "COMPLETE";
      await tx.transferSlackCloseout.updateMany({
        where: { transfer_id: transferId },
        data: {
          status: complete ? "COMPLETE" : "PENDING",
          completed_at: complete ? new Date() : null,
        },
      });
      if (complete && !wasComplete) {
        await writeAudit(
          tx as Prisma.TransactionClient,
          { role: "INGEST", email: null },
          {
            action: TRANSFER_SLACK_CLOSEOUT,
            entityType: "transfer",
            entityId: transferId,
            detail: { status: "COMPLETE", done: doneRows.length },
          },
        );
      }
    });

    if (notFound) return err("not_found", 404);
  } catch {
    console.error("[slack-closeout] callback tx_failed");
    return err("internal", 500);
  }

  return Response.json({ ok: true });
}
