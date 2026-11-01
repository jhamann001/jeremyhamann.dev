import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { revokeToken } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    if (token) {
      await revokeToken(token);
    }
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    logger.error({ err }, "POST /api/mcp/oauth/revoke failed");
    return NextResponse.json(
      { error: "server_error", error_description: "Failed to revoke token" },
      { status: 500 }
    );
  }
}
