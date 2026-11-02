import {
  reconAccountsResponse,
  reconPrelude,
  searchReconAccounts,
} from "@/lib/data/acat-security-recon-server";

// Mapping-account search for one transfer (ticket). Part of the account
// picker, which is a write control, so it needs the edits switch as well.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pre = await reconPrelude(request, "write", id);
  if (!pre.ok) return pre.response;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return reconAccountsResponse(await searchReconAccounts(id, q));
}
