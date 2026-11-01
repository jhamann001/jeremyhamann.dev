/**
 * The app-icon badge's only decision.
 *
 * A badge renders OUTSIDE the app, on a dock or a home screen anyone walking past can read, so what
 * it is allowed to carry is a single number — and `badgeValue` is where that number is decided.
 */
import { describe, expect, it } from "vitest";
import { badgeValue } from "@/components/shell/badge-sync";

describe("badgeValue", () => {
  it("clears at zero and below, so a read inbox leaves no number on the icon", () => {
    expect(badgeValue(0)).toBeNull();
    expect(badgeValue(-1)).toBeNull();
  });

  it("passes an ordinary count through", () => {
    expect(badgeValue(1)).toBe(1);
    expect(badgeValue(42)).toBe(42);
    expect(badgeValue(999)).toBe(999);
  });

  it("caps rather than claiming a precision a small disc cannot render", () => {
    expect(badgeValue(1000)).toBe(999);
    expect(badgeValue(4312)).toBe(999);
  });

  it("clears rather than throwing on a value that is not a number", () => {
    expect(badgeValue(Number.NaN)).toBeNull();
    expect(badgeValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(badgeValue(3.7)).toBe(3);
  });
});
