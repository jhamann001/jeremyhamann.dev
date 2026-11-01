import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function requireAdmin(): Promise<
  { email: string } | NextResponse
> {
  const session = await auth();
  if (!session?.user?.email || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { email: session.user.email };
}
