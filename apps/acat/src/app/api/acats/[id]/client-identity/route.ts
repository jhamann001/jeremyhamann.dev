import { NextRequest, NextResponse } from "next/server";
import { toOperationalAcat } from "@/lib/acat-identity-dto";
import { clientIdentityRelinkSchema, formatZodError } from "@/lib/validators";
import { directoryErrorResponse, identityError, requireIdentityOperator, IDENTITY_RESPONSE_HEADERS } from "@/lib/client-identity-http";
import { relinkAcatClients } from "@/lib/client-identity-relink";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const operator = await requireIdentityOperator();
  if (operator instanceof NextResponse) return operator;
  const { id } = await params;
  try {
    const parsed = clientIdentityRelinkSchema.safeParse(await request.json());
    if (!parsed.success) return identityError("INVALID_REQUEST", formatZodError(parsed.error), 400);
    const result = await relinkAcatClients({ id, input: parsed.data, performedBy: operator.email });
    if (result.kind === "response") return result.response;
    return NextResponse.json(toOperationalAcat(result.record), { headers: IDENTITY_RESPONSE_HEADERS });
  } catch (error) {
    return directoryErrorResponse(error) ?? NextResponse.json({ error: "Failed to update client identity" }, { status: 500, headers: IDENTITY_RESPONSE_HEADERS });
  }
}
