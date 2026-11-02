import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushAddress, replaceAddress } from "@/components/asset-mapping/workspace/history";

// `node` environment (see vitest.config.ts): stand in a minimal History class and a
// `window.history` instance whose own pushState/replaceState mimic the framework patch.
class FakeHistory {
  pushState(_state: unknown, _unused: string, _url?: string): void {}
  replaceState(_state: unknown, _unused: string, _url?: string): void {}
}

describe("asset-mapping address writes", () => {
  let instance: FakeHistory;
  let patchedPush: ReturnType<typeof vi.fn<FakeHistory["pushState"]>>;
  let patchedReplace: ReturnType<typeof vi.fn<FakeHistory["replaceState"]>>;

  beforeEach(() => {
    instance = new FakeHistory();
    patchedPush = vi.fn<FakeHistory["pushState"]>();
    patchedReplace = vi.fn<FakeHistory["replaceState"]>();
    instance.pushState = patchedPush;
    instance.replaceState = patchedReplace;
    vi.stubGlobal("History", FakeHistory);
    vi.stubGlobal("window", { history: instance });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pushAddress writes through the prototype method, not the patched instance method", () => {
    const protoPush = vi.spyOn(FakeHistory.prototype, "pushState");
    pushAddress("/asset-mapping?run=r2");
    expect(patchedPush).not.toHaveBeenCalled();
    expect(protoPush).toHaveBeenCalledTimes(1);
    expect(protoPush).toHaveBeenCalledWith(null, "", "/asset-mapping?run=r2");
    expect(protoPush.mock.contexts[0]).toBe(instance);
  });

  it("replaceAddress writes through the prototype method, not the patched instance method", () => {
    const protoReplace = vi.spyOn(FakeHistory.prototype, "replaceState");
    replaceAddress("/asset-mapping");
    expect(patchedReplace).not.toHaveBeenCalled();
    expect(protoReplace).toHaveBeenCalledTimes(1);
    expect(protoReplace).toHaveBeenCalledWith(null, "", "/asset-mapping");
    expect(protoReplace.mock.contexts[0]).toBe(instance);
  });
});

describe("AssetMappingWorkspace address writes", () => {
  it("never calls the instance history methods directly", () => {
    const source = readFileSync("components/asset-mapping/workspace/AssetMappingWorkspace.tsx", "utf8");
    expect(source).not.toContain("window.history.pushState");
    expect(source).not.toContain("window.history.replaceState");
    expect(source).toContain("pushAddress(");
    expect(source).toContain("replaceAddress(");
  });
});
