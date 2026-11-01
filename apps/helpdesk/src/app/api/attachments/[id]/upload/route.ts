/**
 * PUT /api/attachments/[id]/upload — the LOCAL-DEVELOPMENT receiver for a signed upload URL.
 *
 * CONTRACT DEVIATION, recorded in the build record: §8's route table does
 * not list this path, because on GCS it does not exist — the browser PUTs straight at the V4 signed
 * URL and this route answers 404. It exists so that the filesystem backend the contract mandates for
 * local development (`ATTACHMENTS_BUCKET` unset) is actually usable: a signed PUT URL needs something
 * to receive the PUT, and on a laptop that something can only be the app itself.
 *
 * It is a STAFF surface behind the session middleware, exactly like the download route, and it never
 * uses the integration bearer. Four independent gates, all of which must pass:
 *   1. the session, and `attachment:write` on the ticket's queue — the same check `createUploadIntent`
 *      made, re-made here, because a URL is not an authorization;
 *   2. the HMAC-ed, expiring token minted with the URL, bound to the object key, the content type and
 *      the byte cap;
 *   3. the row: it must still be PENDING, on a ticket that is not CLOSED;
 *   4. the bytes: declared content type must match the row, and the body must be exactly the size the
 *      intent declared and within the 25 MiB cap. The cap is applied WHILE the body is read
 *      (`readBodyWithCap`), never to a buffer that has already been materialised — `await
 *      req.arrayBuffer()` would allocate the whole request before any limit could be consulted, so a
 *      chunked PUT with no `content-length` (or a lying one) could drive the Next process's heap to
 *      whatever the sender felt like sending. A body with no declared length is refused outright: the
 *      browser `fetch` PUT of a Blob that this route exists to receive always sets `content-length`.
 *
 * It writes NO audit row. The audited event is `ATTACHMENT_ADDED`, written by `finalizeUpload` when
 * the object has been verified — bytes landing in a scratch directory are not yet an attachment.
 */
import type { Viewer } from "@/types/domain";
import { INGEST_LIMITS } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { UnauthorizedError } from "@/lib/errors";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { canWriteAttachment } from "@/lib/rbac";
import { requireViewerOrThrow } from "@/lib/session";
import { readBodyWithCap } from "@/lib/http-body";
import { attachmentStore, verifyLocalUploadToken } from "@/lib/storage";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const store = attachmentStore();
  // With a bucket configured the browser uploads to GCS directly; this path is then not a route at
  // all, and says so the same way an unknown path does.
  if (store.backend !== "filesystem") return fail(404, "not_found");

  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) return fail(401, "unauthenticated");
    throw e;
  }

  const { id } = await ctx.params;
  const rc = getRequestContextFromRequest(req);

  const row = await prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      ticketId: true,
      state: true,
      mime: true,
      size: true,
      objectKey: true,
      ticket: { select: { status: true, queue: { select: { key: true } } } },
    },
  });
  if (!row) return fail(404, "not_found");

  if (!canWriteAttachment(viewer.groups, row.ticket.queue.key)) {
    await recordDenied(actorFromViewer(viewer), rc, "attachment:write", row.ticketId);
    return fail(404, "not_found");
  }
  if (row.ticket.status === "CLOSED") return fail(409, "ticket_closed");
  if (row.state !== "PENDING") return fail(409, "already_uploaded");

  const url = new URL(req.url);
  const contentType = url.searchParams.get("ct") ?? "";
  const maxBytes = Number.parseInt(url.searchParams.get("max") ?? "", 10);
  const expiresAtEpoch = Number.parseInt(url.searchParams.get("exp") ?? "", 10);
  const signature = url.searchParams.get("sig") ?? "";
  if (!Number.isFinite(maxBytes) || !Number.isFinite(expiresAtEpoch)) return fail(403, "bad_signature");

  const ok = verifyLocalUploadToken(
    { key: row.objectKey, contentType, maxBytes, expiresAtEpoch },
    signature,
  );
  if (!ok) return fail(403, "bad_signature");

  // The signed content type is what the intent committed to; the row is the second opinion.
  if (contentType !== row.mime) return fail(403, "bad_signature");
  const headerType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (headerType !== row.mime) return fail(415, "unsupported_media_type");

  const cap = Math.min(maxBytes, INGEST_LIMITS.attachmentMaxBytes);

  // A declared length is REQUIRED, not merely honoured. It is attacker-controlled, so it can only ever
  // be an early refusal — but its absence is what turns "read the body" into "read an unbounded body",
  // and every client this route serves (the browser's `fetch` PUT of a Blob, and the upload test) sets
  // it. 411 says exactly what is wrong instead of failing later on a size that never arrives.
  const declaredHeader = req.headers.get("content-length")?.trim() ?? null;
  // Strict: `Number.parseInt` would read "12abc" as 12 and let a malformed header through on a
  // coincidence. RFC 9110 says the field is digits only, so digits only is what is accepted.
  if (declaredHeader === null || !/^\d{1,15}$/.test(declaredHeader)) return fail(411, "length_required");
  const declared = Number(declaredHeader);
  // Refuse before reading a byte when the sender tells us it is too big, or not the size it promised at
  // intent time. The row's size is the contract `createUploadIntent` recorded; nothing else is accepted.
  if (declared > cap) return fail(413, "too_large");
  if (declared !== row.size) return fail(400, "size_mismatch");

  // The enforcement: the cap is checked against the RUNNING total, so peak memory is bounded by the cap
  // plus one chunk no matter what the headers claimed. `null` means the sender went past it and the
  // stream was cancelled.
  const bytes = await readBodyWithCap(req.body, Math.min(cap, row.size));
  if (bytes === null) return fail(413, "too_large");
  if (bytes.byteLength !== row.size) return fail(400, "size_mismatch");

  await store.put(row.objectKey, bytes, row.mime);
  return Response.json({ ok: true, size: bytes.byteLength }, { status: 200, headers: NO_STORE });
}
