import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetIdTokenClient = vi.fn();
let constructorCallCount = 0;

vi.mock("google-auth-library", () => ({
  GoogleAuth: class MockGoogleAuth {
    getIdTokenClient = mockGetIdTokenClient;
    constructor() {
      constructorCallCount++;
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  constructorCallCount = 0;
  vi.resetModules();
});

describe("getAuthenticatedClient", () => {
  it("returns an ID token client for the given audience", async () => {
    const fakeClient = { request: vi.fn() };
    mockGetIdTokenClient.mockResolvedValue(fakeClient);

    const { getAuthenticatedClient } = await import("./gcp-auth");
    const client = await getAuthenticatedClient("https://my-service.run.app");

    expect(mockGetIdTokenClient).toHaveBeenCalledWith("https://my-service.run.app");
    expect(client).toBe(fakeClient);
  });

  it("reuses the same GoogleAuth instance across calls", async () => {
    const fakeClient = { request: vi.fn() };
    mockGetIdTokenClient.mockResolvedValue(fakeClient);

    const { getAuthenticatedClient } = await import("./gcp-auth");
    await getAuthenticatedClient("https://a.run.app");
    await getAuthenticatedClient("https://b.run.app");

    expect(constructorCallCount).toBe(1);
    expect(mockGetIdTokenClient).toHaveBeenCalledTimes(2);
  });
});
