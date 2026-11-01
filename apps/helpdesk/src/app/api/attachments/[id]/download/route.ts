/**
 * GET /api/attachments/[id]/download — the only way to an attachment's bytes
 *.
 *
 * This is a STAFF surface and it stays INSIDE the session middleware matcher on purpose: it is not a
 * machine route and it never uses the integration bearer (guardrail G3b asserts both halves).
 *
 * Order, and the order matters:
 *   1. session               — no viewer, no answer (401).
 *   2. RBAC + state          — `getAttachmentForDownload` returns null for missing, unreadable and
 *                              not-READY alike, so a 404 never tells the caller which it was. A
 *                              denial on a row that exists is recorded as AUTHZ_DENIED in there.
 *   3. ATTACHMENT_VIEWED     — AWAITED, before any URL is minted or any byte is served. An audit
 *                              failure fails the request; that is the point of I3.
 *   4. the bytes             — on GCS a 302 to a 5-minute V4 signed URL that carries
 *                              `Content-Disposition: attachment` in its signature; on the local
 *                              filesystem backend the route streams the object itself, because
 *                              on a laptop there is no third party to redirect to.
 *
 * Never cached, never inline, never sniffed.
 */
import type { Viewer } from "@/types/domain";
import { recordMaterialRead, actorFromViewer } from "@/lib/audit";
import { UnauthorizedError } from "@/lib/errors";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { requireViewerOrThrow } from "@/lib/session";
import { attachmentStore, contentDispositionAttachment } from "@/lib/storage";
import { getAttachmentForDownload } from "@/server/attachments";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    }
    throw e;
  }

  const { id } = await ctx.params;
  const rc = getRequestContextFromRequest(req);

  const found = await getAttachmentForDownload(viewer, id, rc);
  if (!found) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const { attachment, objectKey } = found;
  const store = attachmentStore();

  // I3: the read of client material is evidence and it is written BEFORE the material is produced.
  // An insert failure propagates, so nothing is served when the ledger cannot record the view.
  await recordMaterialRead(actorFromViewer(viewer), rc, {
    action: "ATTACHMENT_VIEWED",
    entityType: "ATTACHMENT",
    entityId: attachment.id,
    ticketId: attachment.ticketId,
    metadata: { filename: attachment.filename, mime: attachment.mime, size: attachment.size, backend: store.backend },
  });

  if (store.backend === "filesystem") {
    const bytes = await store.get(objectKey);
    // Copy into a fresh ArrayBuffer: the Uint8Array may be a view into a larger pooled buffer.
    const body = new Uint8Array(bytes).slice().buffer;
    return new Response(body, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": attachment.mime,
        "Content-Length": String(attachment.size),
        "Content-Disposition": contentDispositionAttachment(attachment.filename),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const signed = await store.signedGetUrl(objectKey, {
    filename: attachment.filename,
    contentType: attachment.mime,
  });
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, Location: signed.url, "X-Content-Type-Options": "nosniff" },
  });
}
