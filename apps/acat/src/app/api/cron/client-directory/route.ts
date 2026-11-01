import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { syncClientDirectory } from "@/lib/client-directory/sync";
import { DirectorySourceError } from "@/lib/client-directory/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = process.env.CLIENT_DIRECTORY_SYNC_TOKEN;
  if (!token) return NextResponse.json({ error: "Directory sync is not configured." }, { status: 503 });
  const provided = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(provided), digest(`Bearer ${token}`))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // A request can trigger only the configured read-only source. It cannot
  // supply a card, credentials, directory rows, or a claimed health override.
  try {
    return NextResponse.json(await syncClientDirectory(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof DirectorySourceError ? error.code : "DIRECTORY_SYNC_FAILED";
    console.error("[client-directory] sync failed", { code });
    return NextResponse.json({ error: "Directory sync failed.", code }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
