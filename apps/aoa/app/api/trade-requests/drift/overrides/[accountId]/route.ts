import { z } from "zod";
import { driftJson, driftRouteGate } from "@/lib/trade-requests/drift/route-gate";
import { DRIFT_OVERRIDE_REASONS } from "@/lib/trade-requests/drift/drift-status-overrides";
import { clearDriftOverride, saveDriftOverride } from "@/lib/trade-requests/drift/overrides-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Port of the standalone PUT/DELETE /api/drift/v2/overrides/:accountId (server/src/routes/drift.ts:166-233).
const overrideBodySchema = z
  .object({
    reason: z.enum(DRIFT_OVERRIDE_REASONS as unknown as [string, ...string[]]),
    note: z.string().max(2000).optional().default(""),
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expiresOn must be YYYY-MM-DD")
      .nullable()
      .optional(),
  })
  .refine((b) => b.reason !== "other" || b.note.trim().length > 0, {
    message: 'note is required when reason is "other"',
    path: ["note"],
  });
const accountParam = z.object({ accountId: z.string().min(1).max(100) });
type Params = { params: Promise<{ accountId: string }> };

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const gate = await driftRouteGate(request, "write");
  if ("refused" in gate) return gate.refused;
  const account = accountParam.safeParse(await params);
  const body = overrideBodySchema.safeParse(await request.json().catch(() => null));
  if (!account.success) return driftJson({ error: "Validation failed", details: account.error.issues }, 400);
  if (!body.success) return driftJson({ error: "Validation failed", details: body.error.issues }, 400);
  const override = await saveDriftOverride(gate.actor, account.data.accountId, {
    reason: body.data.reason as (typeof DRIFT_OVERRIDE_REASONS)[number],
    note: body.data.note ?? "",
    expiresOn: body.data.expiresOn ?? null,
  });
  return driftJson({ accountId: account.data.accountId, override });
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const gate = await driftRouteGate(request, "write");
  if ("refused" in gate) return gate.refused;
  const account = accountParam.safeParse(await params);
  if (!account.success) return driftJson({ error: "Validation failed", details: account.error.issues }, 400);
  const cleared = await clearDriftOverride(gate.actor, account.data.accountId);
  return driftJson({ accountId: account.data.accountId, cleared });
}
