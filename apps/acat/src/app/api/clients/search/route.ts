import { NextRequest, NextResponse } from "next/server";
import { searchClients } from "@/lib/client-directory";
import { clientSearchSchema, formatZodError } from "@/lib/validators";
import { directoryErrorResponse, identityError, requireIdentityOperator, IDENTITY_RESPONSE_HEADERS } from "@/lib/client-identity-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  const operator = await requireIdentityOperator();
  if (operator instanceof NextResponse) return operator;
  try {
    const parsed = clientSearchSchema.safeParse(await request.json());
    if (!parsed.success) return identityError("INVALID_REQUEST", formatZodError(parsed.error), 400);
    const result = await searchClients(parsed.data.query, parsed.data.limit);
    return NextResponse.json(result, { headers: IDENTITY_RESPONSE_HEADERS });
  } catch (error) {
    return directoryErrorResponse(error) ?? identityError("DIRECTORY_UNAVAILABLE", "Client search is temporarily unavailable", 503);
  }
}
