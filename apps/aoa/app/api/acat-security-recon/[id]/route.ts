import {
  loadRecon,
  parseReconActionBody,
  readBoundedBody,
  reconEnvelopeResponse,
  reconFailureResponse,
  reconPrelude,
  runReconAction,
} from "@/lib/data/acat-security-recon-server";
import { RECON_INVALID, RECON_UNAVAILABLE } from "@/lib/data/acat-security-recon-contract";

// Security reconciliation for one transfer (ticket). Dark unless the drawer
// and both reconciliation switches are on; then session, role and, for a
// write, the edits switch decide. The tracker owns every position.
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  const pre = await reconPrelude(request, "read", id);
  if (!pre.ok) return pre.response;
  return reconEnvelopeResponse(await loadRecon(id));
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const pre = await reconPrelude(request, "write", id);
  if (!pre.ok) return pre.response;
  const body = await readBoundedBody(request);
  if (!body.ok) return reconFailureResponse(413, RECON_INVALID, false);
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return reconFailureResponse(400, RECON_INVALID, false);
  }
  const parsed = parseReconActionBody(raw);
  if (!parsed.ok) return reconFailureResponse(400, parsed.reason, false);
  try {
    return reconEnvelopeResponse(await runReconAction(id, parsed.body));
  } catch {
    console.error("[acat-security-recon] action_failed");
    return reconFailureResponse(502, RECON_UNAVAILABLE, true);
  }
}

