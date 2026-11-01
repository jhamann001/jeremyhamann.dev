/**
 * Unit tests for the bounded body reader. The property that matters is the one the finding named: the
 * cap is applied WHILE reading, so a body that never declares its length — or lies about it — cannot
 * force an unbounded allocation.
 */
import { describe, expect, it, vi } from "vitest";
import { readBodyWithCap } from "@/lib/http-body";

function streamOf(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
    cancel() {
      onCancel?.();
    },
  });
}

const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

describe("readBodyWithCap", () => {
  it("returns the whole body when it fits", async () => {
    const out = await readBodyWithCap(streamOf([bytes(3, 1), bytes(2, 2)]), 10);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([1, 1, 1, 2, 2]);
  });

  it("returns the body when it is exactly the cap", async () => {
    const out = await readBodyWithCap(streamOf([bytes(4)]), 4);
    expect(out?.byteLength).toBe(4);
  });

  it("returns null one byte past the cap", async () => {
    expect(await readBodyWithCap(streamOf([bytes(5)]), 4)).toBeNull();
  });

  it("stops pulling as soon as the running total passes the cap — the chunks after it are never read", async () => {
    const seen: number[] = [];
    let i = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        seen.push(i++);
        controller.enqueue(bytes(1_000));
      },
    });
    expect(await readBodyWithCap(huge, 2_500)).toBeNull();
    // 3 pulls take the total to 3,000 > 2,500 and the read ends there; an unbounded stream does not
    // get to keep feeding us. (One extra pull may be in flight from the queuing strategy.)
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it("cancels the stream when the cap is exceeded, so the sender is told to stop", async () => {
    const onCancel = vi.fn();
    expect(await readBodyWithCap(streamOf([bytes(9)], onCancel), 4)).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reads a null body (no request body) as zero bytes, never as a failure", async () => {
    const out = await readBodyWithCap(null, 100);
    expect(out?.byteLength).toBe(0);
  });

  it("accepts a zero cap only for an empty body", async () => {
    expect((await readBodyWithCap(streamOf([]), 0))?.byteLength).toBe(0);
    expect(await readBodyWithCap(streamOf([bytes(1)]), 0)).toBeNull();
  });

  it("skips empty chunks instead of counting them as progress", async () => {
    const out = await readBodyWithCap(streamOf([bytes(0), bytes(2, 5), bytes(0)]), 2);
    expect(Array.from(out!)).toEqual([5, 5]);
  });

  it("refuses a nonsensical cap rather than guessing", async () => {
    await expect(readBodyWithCap(streamOf([]), -1)).rejects.toBeInstanceOf(RangeError);
    await expect(readBodyWithCap(streamOf([]), 1.5)).rejects.toBeInstanceOf(RangeError);
    await expect(readBodyWithCap(streamOf([]), Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });
});
