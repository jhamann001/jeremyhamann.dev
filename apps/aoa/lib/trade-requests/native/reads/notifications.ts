import { z } from "zod";
import { prisma } from "@/lib/db";
import { identityIdFor } from "./actor";
import { nativeRoutes, ok, queryOf, route } from "./http";

// trade-request d41b6c9 server/src/routes/notifications.ts:11-68.

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unreadOnly: z.enum(["true", "false"]).optional(),
});

type NotificationRow = { id: string; body: string; request_id: string | null; read_at: Date | null; created_at: Date };

export const notificationsListHandler = nativeRoutes(route("GET", "/notifications", async (_params, call, actor) => {
  const query = listQuerySchema.parse(queryOf(call));
  const userId = await identityIdFor(actor.email);
  if (!userId) return ok({ data: [], unreadCount: 0 });
  const rows = await prisma.$queryRawUnsafe<NotificationRow[]>(
    `SELECT id::text AS id, body, request_id, read_at, created_at
       FROM trade_request.notifications
      WHERE user_id = $1::uuid ${query.unreadOnly === "true" ? "AND read_at IS NULL" : ""}
      ORDER BY created_at DESC
      LIMIT $2::int`,
    userId, query.limit,
  );
  const counted = await prisma.$queryRawUnsafe<Array<{ c: string }>>(
    `SELECT COUNT(*)::text AS c FROM trade_request.notifications WHERE user_id = $1::uuid AND read_at IS NULL`,
    userId,
  );
  return ok({
    data: rows.map((r) => ({
      id: r.id,
      message: r.body,
      isRead: r.read_at != null,
      date: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
      requestId: r.request_id,
    })),
    unreadCount: parseInt(counted[0]?.c ?? "0", 10),
  });
}));
