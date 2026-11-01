import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  OAuthError,
  assertMcpEnabledForUser,
  createAuthorizationCode,
  parseAuthorizationRequest,
  validateAuthorizationRequest,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function redirectWithError(redirectUri: string, state: string | null, error: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: String(form.get("client_id") ?? ""),
    redirect_uri: String(form.get("redirect_uri") ?? ""),
    code_challenge: String(form.get("code_challenge") ?? ""),
    code_challenge_method: "S256",
    scope: String(form.get("scope") ?? ""),
  });
  const state = String(form.get("state") ?? "");
  if (state) params.set("state", state);

  let safeRedirectUri: string | null = null;
  let safeState: string | null = null;

  try {
    const authReq = parseAuthorizationRequest(params);
    const { client, scopes } = await validateAuthorizationRequest(authReq);
    safeRedirectUri = authReq.redirectUri;
    safeState = authReq.state;

    await assertMcpEnabledForUser(session.user.email);
    const code = await createAuthorizationCode({
      userEmail: session.user.email,
      clientDbId: client.id,
      redirectUri: authReq.redirectUri,
      scopes,
      codeChallenge: authReq.codeChallenge,
    });
    const redirectUrl = new URL(authReq.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (authReq.state) redirectUrl.searchParams.set("state", authReq.state);
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    const error = err instanceof OAuthError ? err.code : "server_error";
    if (safeRedirectUri) {
      return redirectWithError(safeRedirectUri, safeState, error);
    }
    return NextResponse.json({ error }, { status: err instanceof OAuthError ? err.status : 500 });
  }
}
