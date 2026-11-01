// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetDemoData = vi.fn();
const syncClientDirectory = vi.fn();
const postToSlack = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/demo/seed", () => ({ resetDemoData }));
vi.mock("@/lib/demo/universe", () => ({ loadUniverse: () => ({}) }));
vi.mock("@/lib/client-directory/sync", () => ({ syncClientDirectory }));
vi.mock("@/lib/slack-webhook", () => ({ postToSlack }));
vi.mock("@/lib/prisma", () => ({ prisma: { acatRecord: { findMany } } }));

const { POST } = await import("./route");
const call = (authorization?: string) =>
  POST(new Request("http://localhost/api/internal/demo-reset", { method: "POST", headers: authorization ? { authorization } : {} }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
  vi.stubEnv("DEMO_RESET_TOKEN", "reset-secret");
  resetDemoData.mockResolvedValue({ transfers: 124 });
  syncClientDirectory.mockResolvedValue({ status: "published", snapshotId: "abc" });
  findMany.mockResolvedValue([]);
  postToSlack.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/internal/demo-reset", () => {
  it("does not exist outside the demo", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    expect((await call("Bearer reset-secret")).status).toBe(404);
    expect(resetDemoData).not.toHaveBeenCalled();
  });

  it("is unavailable without a configured token, and refuses a wrong one", async () => {
    vi.stubEnv("DEMO_RESET_TOKEN", "");
    expect((await call("Bearer reset-secret")).status).toBe(503);
    vi.stubEnv("DEMO_RESET_TOKEN", "reset-secret");
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect(resetDemoData).not.toHaveBeenCalled();
  });

  it("reseeds, syncs the directory and sends the digest", async () => {
    const res = await call("Bearer reset-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transfers: 124, directory: "published", digestSent: true });
    expect(resetDemoData).toHaveBeenCalledOnce();
    expect(postToSlack).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Transfer Tracker daily status") }));
  });

  it("reports a failed sync as a failed reset, so the Worker retries", async () => {
    syncClientDirectory.mockRejectedValue(Object.assign(new Error("x"), { name: "DirectorySourceError" }));
    const res = await call("Bearer reset-secret");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.directory).toBe("DIRECTORY_SYNC_FAILED");
    expect(body.digestSent).toBe(true);
  });

  it("reports a failed digest as a failed reset", async () => {
    postToSlack.mockRejectedValue(new Error("stand-in down"));
    const res = await call("Bearer reset-secret");
    expect(res.status).toBe(500);
    expect((await res.json()).digestSent).toBe(false);
  });
});
