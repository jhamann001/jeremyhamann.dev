import { NextResponse } from "next/server";
import { verifyAcatWriteCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { restoreAcatSchema, formatZodError } from "@/lib/validators";
import { applyAcatRestore } from "@/lib/acat-record-write";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const caller = await verifyAcatWriteCaller(request, "restore");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { allowed } = await rateLimit("machine-acat-write", caller.email, {
    maxTokens: 60,
    interval: 60_000,
    failClosed: true,
  });
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: unknown = {};
  const text = await request.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const parsed = restoreAcatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  return applyAcatRestore({
    id,
    reason: parsed.data.reason ?? null,
    performedBy: caller.email,
  });
}
