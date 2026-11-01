import { NextResponse } from "next/server";
import { auth } from "./auth";
import { ClientDirectoryError } from "./client-directory";
import type { ClientIdentityErrorCode } from "./client-identity-contract";

export const IDENTITY_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };

export async function requireIdentityOperator(): Promise<{ email: string } | NextResponse> {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: IDENTITY_RESPONSE_HEADERS });
  }
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: IDENTITY_RESPONSE_HEADERS });
  }
  return { email: session.user.email };
}

export function identityError(code: ClientIdentityErrorCode, error: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: IDENTITY_RESPONSE_HEADERS });
}

export function directoryErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ClientDirectoryError) {
    return identityError(error.code, error.message, error.httpStatus);
  }
  if (error instanceof SyntaxError) {
    return identityError("INVALID_REQUEST", "Invalid JSON body", 400);
  }
  return null;
}
