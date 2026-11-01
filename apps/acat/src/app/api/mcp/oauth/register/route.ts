import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { OAuthError, registerOAuthClient } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const client = await registerOAuthClient({
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
    });
    return NextResponse.json(client, { status: 201 });
  } catch (err) {
    if (err instanceof OAuthError) {
      return NextResponse.json(
        { error: err.code, error_description: err.message },
        { status: err.status }
      );
    }
    logger.error({ err }, "POST /api/mcp/oauth/register failed");
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "server_error", error_description: "Failed to register OAuth client" },
      { status: 500 }
    );
  }
}
