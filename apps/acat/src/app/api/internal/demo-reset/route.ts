import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { demoMode } from "@/lib/demo/mode";
import { runDemoReset } from "@/lib/demo/reset";

// Demo only. The nightly reset (src/lib/demo/reset.ts), called by the Worker's cron with
// DEMO_RESET_TOKEN.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!demoMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const token = process.env.DEMO_RESET_TOKEN;
  if (!token) return NextResponse.json({ error: "Demo reset is not configured." }, { status: 503 });
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runDemoReset();
  // A failed directory sync or digest is a failed reset, so the Worker's cron tries again.
  const complete = result.directory === "published" && result.digestSent;
  return NextResponse.json(result, { status: complete ? 200 : 500, headers: { "Cache-Control": "no-store" } });
}
