/**
 * Viewer resolution for RSC pages, server actions and route handlers.
 *
 * `getViewer()` confirms `User.isActive` on EVERY request, so an offboarded user's still-valid JWT is
 * inert immediately. Groups come from the JWT (authorization reads the token; `User.groups` is a
 * display/assignee snapshot refreshed at sign-in).
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { UnauthorizedError } from "@/lib/errors";
import { hasAny } from "@/lib/rbac";
import type { OktaGroup, Viewer } from "@/types/domain";

export async function getViewer(): Promise<Viewer | null> {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser?.id) return null;
  const row = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { isActive: true, name: true, image: true, email: true },
  });
  if (!row || !row.isActive) return null;
  return {
    id: sessionUser.id,
    email: row.email,
    name: row.name,
    image: row.image,
    groups: Array.isArray(sessionUser.groups) ? sessionUser.groups : [],
    isDev: sessionUser.isDev === true,
  };
}

/** Pages: redirect to /sign-in when there is no active viewer. */
export async function requireUser(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  return viewer;
}

/** Pages: requireUser, then any of the given groups, else redirect to /no-access. */
export async function requireGroup(...anyOf: OktaGroup[]): Promise<Viewer> {
  const viewer = await requireUser();
  if (!hasAny(viewer.groups, anyOf)) redirect("/no-access");
  return viewer;
}

/** Server actions + route handlers: throws UnauthorizedError instead of redirecting. */
export async function requireViewerOrThrow(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new UnauthorizedError();
  return viewer;
}
