import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(authorizationServerMetadata());
}
