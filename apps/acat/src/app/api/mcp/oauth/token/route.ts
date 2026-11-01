import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  OAuthError,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const grantType = String(form.get("grant_type") ?? "");
    const clientId = String(form.get("client_id") ?? "");

    if (grantType === "authorization_code") {
      const result = await exchangeAuthorizationCode({
        code: String(form.get("code") ?? ""),
        clientId,
        redirectUri: String(form.get("redirect_uri") ?? ""),
        codeVerifier: String(form.get("code_verifier") ?? ""),
      });
      return NextResponse.json(result);
    }

    if (grantType === "refresh_token") {
      const result = await refreshAccessToken({
        refreshToken: String(form.get("refresh_token") ?? ""),
        clientId,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json(
      {
        error: "unsupported_grant_type",
        error_description: "Only authorization_code and refresh_token are supported",
      },
      { status: 400 }
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      return NextResponse.json(
        { error: err.code, error_description: err.message },
        { status: err.status }
      );
    }
    logger.error({ err }, "POST /api/mcp/oauth/token failed");
    return NextResponse.json(
      { error: "server_error", error_description: "Failed to issue token" },
      { status: 500 }
    );
  }
}
