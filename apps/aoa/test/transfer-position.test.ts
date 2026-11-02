import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { resolvePositionTransferring } from "@/lib/data/transfer-asset-map";

// Pure resolver for the partial-ACAT is-transferring flag: the AOA per-position
// override wins; absent that, the pipeline's flag; absent that, false.
describe("resolvePositionTransferring", () => {
  it("override wins over the pipeline, both directions", () => {
    expect(resolvePositionTransferring(true, false)).toBe(true);
    expect(resolvePositionTransferring(false, true)).toBe(false);
  });

  it("falls back to the pipeline flag when there is no override", () => {
    expect(resolvePositionTransferring(null, true)).toBe(true);
    expect(resolvePositionTransferring(null, false)).toBe(false);
  });

  it("defaults to false when neither the override nor the pipeline is set", () => {
    expect(resolvePositionTransferring(null, null)).toBe(false);
  });
});
