import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { request, client } = vi.hoisted(() => ({ request: vi.fn(), client: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: vi.fn(function () { return { getIdTokenClient: client }; }) }));
import { fetchAcatList } from "@/lib/data/acat-status";
describe("optional ACAT badge cancellation", () => {
  beforeEach(() => { vi.resetAllMocks(); client.mockResolvedValue({ request }); });
  it("starts no work for an already aborted signal", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchAcatList({ signal: controller.signal })).rejects.toMatchObject({ reason: "transport_error" });
    expect(client).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it("stops awaiting credential discovery and does not start a late tracker read", async () => {
    let finish!: (value: { request: typeof request }) => void;
    client.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const read = fetchAcatList({ signal: controller.signal });
    const rejection = expect(read).rejects.toMatchObject({ reason: "transport_error" });
    controller.abort(); await rejection;
    finish({ request }); await Promise.resolve(); await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });
  it("passes cancellation into tracker transport, refuses retry and ignores a late response", async () => {
    let finish!: (value: unknown) => void;
    request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const read = fetchAcatList({ signal: controller.signal });
    const rejection = expect(read).rejects.toMatchObject({ reason: "transport_error" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0]).toMatchObject({ signal: controller.signal, retry: false, method: "GET" });
    controller.abort(); await rejection;
    finish({ status: 200, data: [{ id: "not-rendered" }] });
    await Promise.resolve(); expect(request).toHaveBeenCalledTimes(1);
  });
});
