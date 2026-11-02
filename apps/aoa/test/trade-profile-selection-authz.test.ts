import { describe, expect, it } from "vitest";
import { canConfirmTradeProfile } from "@/lib/data/trade-profile-selection";

describe("canConfirmTradeProfile", () => {
  it.each(["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"])(
    "allows %s",
    (role) => expect(canConfirmTradeProfile(role)).toBe(true),
  );

  it.each(["HEAD_OF_ADVISORY", "VIEWER", "UNKNOWN", "", null, undefined])(
    "fails closed for %s",
    (role) => expect(canConfirmTradeProfile(role)).toBe(false),
  );
});
