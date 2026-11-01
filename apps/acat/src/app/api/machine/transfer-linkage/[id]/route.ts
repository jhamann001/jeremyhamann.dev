import { linkageResponse } from "@/lib/transfer-linkage/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return linkageResponse(request, (await params).id);
}
