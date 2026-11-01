/**
 * Bounded request-body reading — pure, node only, layer L2.
 *
 * `await req.arrayBuffer()` materialises the WHOLE body before any code can look at its size, so a cap
 * checked on the result is not a cap at all: by the time it is evaluated the allocation has already
 * happened. A declared `content-length` is not a substitute either — it is absent on a chunked request
 * and it is attacker-controlled when present, so it can only ever be an early refusal, never the
 * enforcement.
 *
 * `readBodyWithCap` is the enforcement: it pulls the stream chunk by chunk, adds up what it has taken,
 * and abandons the request the moment the running total passes the cap. Peak memory is bounded by
 * `cap + one chunk` regardless of what the sender claimed or how it framed the request.
 */

/**
 * Reads `body` fully, or gives up at `cap`.
 *
 * Returns the bytes, or `null` when the body is larger than `cap` — at which point the stream is
 * cancelled, so the sender stops rather than being allowed to keep pushing into a socket nobody reads.
 * A `null` body (no request body at all) reads as zero bytes, which every caller here treats as a size
 * mismatch rather than a success.
 */
export async function readBodyWithCap(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> {
  if (!Number.isInteger(cap) || cap < 0) throw new RangeError("cap must be a non-negative integer");
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > cap) {
        // Cancel rather than break: the sender is told to stop, and the chunks collected so far go out
        // of scope on return instead of being assembled into a buffer nobody wanted.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    // Safe after cancel(); it just detaches this reader from an already-closed stream.
    try {
      reader.releaseLock();
    } catch {
      /* the stream errored or was cancelled — nothing to release */
    }
  }

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
