/**
 * PUT /api/attachments/[id]/upload — the body-size gate.
 *
 * The finding this covers: the route used to call `await req.arrayBuffer()` and only then compare the
 * result's length to the cap, so a chunked request with no `content-length` (or a lying one) could
 * materialise an unbounded buffer in the Next process before any limit was consulted. The cap now
 * applies to the running total as the body is read, and a body that declares no length is refused
 * outright — the browser `fetch` PUT this route exists to receive always sets one.
 *
 * No database and no filesystem: the row lookup, the session, the signed-token check and the object
 * store are all mocked, because what is under test is the order and the arithmetic of the gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIME = "application/pdf";
const OBJECT_KEY = "tkt_1/att_1";
const SIZE = 12;

const mockSession = vi.hoisted(() => ({ requireViewerOrThrow: vi.fn() }));
vi.mock("@/lib/session", () => mockSession);

const mockDb = vi.hoisted(() => ({ prisma: { attachment: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db", () => mockDb);

const mockStore = vi.hoisted(() => ({
  put: vi.fn(async () => ({ size: 12, sha256: "x" })),
}));

/** `vi.fn(async () => …)` infers a zero-arg signature, so the recorded call is read back explicitly. */
function putCall(index: number): [key: string, body: Uint8Array, mime: string] {
  return mockStore.put.mock.calls[index] as unknown as [string, Uint8Array, string];
}
const mockStorage = vi.hoisted(() => ({
  attachmentStore: vi.fn(),
  verifyLocalUploadToken: vi.fn(() => true),
}));
vi.mock("@/lib/storage", () => mockStorage);

const mockAudit = vi.hoisted(() => ({
  actorFromViewer: vi.fn(() => ({ id: "u_ops", email: "ops@wm-helpdesk.local", groups: [] })),
  recordDenied: vi.fn(async () => {}),
}));
vi.mock("@/lib/audit", () => mockAudit);

import { PUT } from "@/app/api/attachments/[id]/upload/route";

const VIEWER = {
  id: "u_ops",
  email: "ops@wm-helpdesk.local",
  name: "Mia Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};

const ROW = {
  id: "att_1",
  ticketId: "tkt_1",
  state: "PENDING",
  mime: MIME,
  size: SIZE,
  objectKey: OBJECT_KEY,
  ticket: { status: "OPEN", queue: { key: "OPERATIONS" } },
};

/** A body that hands out `chunks` and counts how many were actually pulled. */
function countingStream(chunks: readonly Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  /** Chunks handed out. A stream prefetches one on its own, so this counts DELIVERY, not reading. */
  pulled: () => number;
  /** Whether the route acquired a reader at all — i.e. whether it touched the body. */
  read: () => boolean;
} {
  let i = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      pulls++;
      controller.enqueue(chunks[i++]);
    },
  });
  const getReader = vi.fn(body.getReader.bind(body)) as unknown as ReadableStream<Uint8Array>["getReader"];
  body.getReader = getReader;
  return { body, pulled: () => pulls, read: () => (getReader as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0 };
}

/**
 * The route touches only `url`, `headers` and `body`, so a duck-typed Request keeps the test honest
 * about what it is exercising — and lets a body exist with NO declared length, which a constructed
 * `Request` will not do.
 */
function put(opts: { body: ReadableStream<Uint8Array> | null; contentLength?: string | null }): Request {
  const headers = new Headers({ "content-type": MIME });
  if (opts.contentLength !== undefined && opts.contentLength !== null) {
    headers.set("content-length", opts.contentLength);
  }
  return {
    url: `http://localhost/api/attachments/att_1/upload?ct=${encodeURIComponent(MIME)}&max=26214400&exp=9999999999&sig=deadbeef`,
    headers,
    body: opts.body,
  } as unknown as Request;
}

const params = { params: Promise.resolve({ id: "att_1" }) };
const bytes = (n: number, fill = 9): Uint8Array => new Uint8Array(n).fill(fill);

beforeEach(() => {
  mockSession.requireViewerOrThrow.mockResolvedValue(VIEWER);
  mockDb.prisma.attachment.findUnique.mockResolvedValue({ ...ROW });
  mockStorage.attachmentStore.mockReturnValue({ backend: "filesystem", ...mockStore });
  mockStorage.verifyLocalUploadToken.mockReturnValue(true);
  mockStore.put.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("upload body gate", () => {
  it("stores a body that matches the declared and recorded size", async () => {
    const { body } = countingStream([bytes(SIZE)]);
    const res = await PUT(put({ body, contentLength: String(SIZE) }), params);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, size: SIZE });
    expect(mockStore.put).toHaveBeenCalledTimes(1);
    const [storedKey, storedBody, storedMime] = putCall(0);
    expect(storedKey).toBe(OBJECT_KEY);
    expect(storedBody.byteLength).toBe(SIZE);
    expect(storedMime).toBe(MIME);
  });

  it("refuses a body with NO declared length — never reads it", async () => {
    const { body, read } = countingStream([bytes(SIZE)]);
    const res = await PUT(put({ body, contentLength: null }), params);
    expect(res.status).toBe(411);
    await expect(res.json()).resolves.toEqual({ error: "length_required" });
    expect(read()).toBe(false);
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it("refuses a non-numeric or negative declared length the same way", async () => {
    for (const value of ["", "abc", "-1", "12abc"]) {
      const { body } = countingStream([bytes(SIZE)]);
      const res = await PUT(put({ body, contentLength: value }), params);
      expect(res.status, `content-length: ${JSON.stringify(value)}`).toBe(411);
      expect(mockStore.put).not.toHaveBeenCalled();
    }
  });

  it("refuses a declared length over the cap before a byte is read", async () => {
    const { body, read } = countingStream([bytes(SIZE)]);
    const res = await PUT(put({ body, contentLength: String(26_214_401) }), params);
    expect(res.status).toBe(413);
    expect(read()).toBe(false);
  });

  it("refuses a declared length that is not the size the intent recorded", async () => {
    const { body, read } = countingStream([bytes(SIZE)]);
    const res = await PUT(put({ body, contentLength: String(SIZE + 1) }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "size_mismatch" });
    expect(read()).toBe(false);
  });

  it("a LYING content-length cannot get more than the cap into memory: the read stops at the limit", async () => {
    // Declares the recorded size, then tries to push far more. The running total ends the read.
    const chunks = Array.from({ length: 50 }, () => bytes(SIZE));
    const { body, pulled } = countingStream(chunks);
    const res = await PUT(put({ body, contentLength: String(SIZE) }), params);

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "too_large" });
    // One chunk fills the allowance, the next one exceeds it, and nothing after that is pulled.
    expect(pulled()).toBeLessThanOrEqual(3);
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it("a truthful declaration that under-delivers is a size mismatch, not a silent short file", async () => {
    const { body } = countingStream([bytes(SIZE - 4)]);
    const res = await PUT(put({ body, contentLength: String(SIZE) }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "size_mismatch" });
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it("is not a route at all on the GCS backend, whatever the body says", async () => {
    mockStorage.attachmentStore.mockReturnValue({ backend: "gcs", ...mockStore });
    const { body, read } = countingStream([bytes(SIZE)]);
    const res = await PUT(put({ body, contentLength: String(SIZE) }), params);
    expect(res.status).toBe(404);
    expect(read()).toBe(false);
  });

  it("still refuses a bad signature before it looks at the body", async () => {
    mockStorage.verifyLocalUploadToken.mockReturnValue(false);
    const { body, read } = countingStream([bytes(SIZE)]);
    const res = await PUT(put({ body, contentLength: String(SIZE) }), params);
    expect(res.status).toBe(403);
    expect(read()).toBe(false);
  });
});
