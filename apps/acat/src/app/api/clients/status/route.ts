import { NextResponse } from "next/server";
import { getDirectoryStatus } from "@/lib/client-directory";
import { requireIdentityOperator, IDENTITY_RESPONSE_HEADERS } from "@/lib/client-identity-http";
import { clientIdentityEnabled, pendingAccountPolicy } from "@/lib/client-identity-policy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const operator = await requireIdentityOperator();
  if (operator instanceof NextResponse) return operator;
  try {
    return NextResponse.json(await getDirectoryStatus(), { headers: IDENTITY_RESPONSE_HEADERS });
  } catch {
    // Status remains safe to consume when source/storage is unavailable. Never
    // expose connection errors, source URLs or tokens to the browser/logs.
    return NextResponse.json({
      enabled: clientIdentityEnabled(), health: "UNAVAILABLE", writeEligible: false,
      pendingAccountPolicy: pendingAccountPolicy(), lastSuccessAt: null, sourceAsOf: null,
    }, { headers: IDENTITY_RESPONSE_HEADERS });
  }
}
