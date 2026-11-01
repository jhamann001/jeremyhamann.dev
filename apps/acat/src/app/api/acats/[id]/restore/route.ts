import { NextRequest, NextResponse } from "next/server";
import { applyAcatRestore } from "@/lib/acat-record-write";
import { requireAdmin } from "@/lib/auth-helpers";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit-redis";
import { restoreAcatSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";

// Share the same bucket as DELETE so a compromised admin can't bypass the
// per-hour limit by alternating delete/restore.
const RESTORE_RATE_LIMIT = {
  maxTokens: 20,
  interval: 60 * 60 * 1000,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const email = check.email;

  const { allowed } = await rateLimit("acat-delete", rateLimitKey(email, request.headers.get("x-forwarded-for")), RESTORE_RATE_LIMIT);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many restore requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    let body: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }
    }

    const parsed = restoreAcatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const reason = parsed.data.reason ?? null;

    return applyAcatRestore({ id, reason, performedBy: email });
  } catch (err) {
    logger.error(
      { err, acatId: id },
      "POST /api/acats/[id]/restore failed"
    );
    return NextResponse.json(
      { error: "Failed to restore ACAT record" },
      { status: 500 }
    );
  }
}
