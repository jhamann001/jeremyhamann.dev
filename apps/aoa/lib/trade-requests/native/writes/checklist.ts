import "server-only";
import { z } from "zod";
import { CHECKLIST_KEYS, type ChecklistItemKey } from "@/lib/trade-requests/checklist-view";
import { NativeHttpError, SEGMENT, bodyOf, nativeRoutes, route } from "@/lib/trade-requests/native/reads/http";
import { paramId } from "./request-schemas";
import { FORBIDDEN, actingUser, aoaWrite, refusable } from "./support";

// Checklist save, ported from trade-request d41b6c9 server/src/routes/requests.ts:1214-1218 and :1242-1270
// and server/src/services/requestChecklist.ts:11 and :33-58.

const TERMINAL = new Set(["Approved", "Rejected", "Completed"]);

const checklistBodySchema = z.object({
  key: z.enum(CHECKLIST_KEYS as unknown as [ChecklistItemKey, ...ChecklistItemKey[]]),
  checked: z.boolean(),
  value: z.string().max(2000).optional(),
});

export const checklistSave = nativeRoutes(route("PUT", `/requests/${SEGMENT}/checklist`, refusable(async ([rawId], call, actor) => {
  const user = await actingUser(actor);
  if (user.role !== "trader") return FORBIDDEN;
  const id = paramId.safeParse(rawId);
  const body = checklistBodySchema.safeParse(bodyOf(call));
  // The checklist route answers every validation failure without details (requests.ts:1264-1266).
  if (!id.success || !body.success) return { status: 400, body: { error: "Validation failed" } };

  const result = await aoaWrite(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
      "SELECT status FROM trade_request.trade_requests WHERE id = $1",
      id.data,
    );
    if (rows.length === 0) return { ok: false as const, reason: "not_found" as const };
    if (TERMINAL.has(rows[0].status)) return { ok: false as const, reason: "locked" as const };
    const state = { checked: body.data.checked, value: body.data.value ?? "", by: user.name, at: new Date().toISOString() };
    const updated = await tx.$queryRawUnsafe<Array<{ preapproval_checklist: unknown }>>(
      `UPDATE trade_request.trade_requests
          SET preapproval_checklist = jsonb_set(COALESCE(preapproval_checklist, '{}'::jsonb), ARRAY[$2::text], $3::jsonb, true)
        WHERE id = $1
        RETURNING preapproval_checklist`,
      id.data,
      body.data.key,
      JSON.stringify(state),
    );
    return { ok: true as const, checklist: updated[0]?.preapproval_checklist ?? {} };
  });
  if (!result.ok) {
    if (result.reason === "not_found") throw new NativeHttpError(404, `Request ${id.data} not found`);
    throw new NativeHttpError(409, "Checklist is locked — the request has already been decided.");
  }
  return { status: 200, body: { checklist: result.checklist } };
})));
