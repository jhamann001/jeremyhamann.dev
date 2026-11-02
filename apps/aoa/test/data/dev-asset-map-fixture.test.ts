import { describe, expect, it } from "vitest";
import { DEV_ASSET_MAP_FIXTURE } from "../../prisma/fixtures/asset-map";

describe("development asset-map fixture", () => {
  it("is visibly synthetic and internally reconciled", () => {
    const fixture = DEV_ASSET_MAP_FIXTURE;
    const positionValue = fixture.positions.reduce(
      (sum, position) => sum + position.marketValue,
      0,
    );

    expect(fixture.household.id).toMatch(/^DEMO-/);
    expect(fixture.household.sourceFolderId).toMatch(/^DEMO-/);
    expect(fixture.account.id).toMatch(/^DEMO-/);
    expect(fixture.account.accountHolder).toContain("Example");
    expect(positionValue).toBe(fixture.account.totalValue);
    expect(fixture.account.totalValue).toBe(fixture.household.totalValue);
  });

  it("contains both a transferable path and an excluded-position blocker", () => {
    const positions = DEV_ASSET_MAP_FIXTURE.positions;

    expect(
      positions.some(
        (position) =>
          position.effectiveStatus === "ACAT" && position.transferring,
      ),
    ).toBe(true);
    expect(
      positions.some(
        (position) =>
          position.effectiveStatus !== "ACAT" && !position.transferring,
      ),
    ).toBe(true);
    expect(new Set(positions.map((position) => position.id)).size).toBe(
      positions.length,
    );
    expect(new Set(positions.map((position) => position.symbol)).size).toBe(
      positions.length,
    );
  });
});
