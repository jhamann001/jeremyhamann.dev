import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { NativeHttpError, SEGMENT, nativeRoutes, route } from "@/lib/trade-requests/native/reads/http";
import { actingUser, aoaWrite, refusable } from "./support";

// Bell read state, ported from trade-request d41b6c9 server/src/routes/notifications.ts:16, :67-92 and :94-111.

const notificationId = z.string().uuid("Invalid notification id");

export const markNotificationRead = nativeRoutes(route("PATCH", `/notifications/${SEGMENT}/read`, refusable(async ([rawId], _call, actor) => {
  const user = await actingUser(actor);
  const id = notificationId.parse(rawId);
  const updated = await aoaWrite((tx) =>
    tx.$executeRawUnsafe(
      `UPDATE trade_request.notifications SET read_at = date_trunc('milliseconds', NOW())
        WHERE id = $1::uuid AND user_id = $2::uuid AND read_at IS NULL`,
      id,
      user.id,
    ),
  );
  if (updated === 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      "SELECT 1::int AS one FROM trade_request.notifications WHERE id = $1::uuid AND user_id = $2::uuid",
      id,
      user.id,
    );
    if (rows.length === 0) throw new NativeHttpError(404, "Notification not found");
  }
  return { status: 204, body: null };
})));

export const markAllNotificationsRead = nativeRoutes(route("POST", "/notifications/read-all", refusable(async (_params, _call, actor) => {
  const user = await actingUser(actor);
  await aoaWrite((tx) =>
    tx.$executeRawUnsafe(
      `UPDATE trade_request.notifications SET read_at = date_trunc('milliseconds', NOW())
        WHERE user_id = $1::uuid AND read_at IS NULL`,
      user.id,
    ),
  );
  return { status: 204, body: null };
})));
