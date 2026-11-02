import { afterEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ run: null as null | (() => void), dependencies: [] as unknown[] }));
vi.mock("react", () => ({ useEffect: (run: () => void, dependencies: unknown[]) => { effects.run = run; effects.dependencies = dependencies; } }));
import ReviewFocus from "@/app/(authenticated)/acat-link-review/review-focus";
afterEach(() => vi.unstubAllGlobals());
describe("selected review card focus", () => {
  it("finds the exact DOM id, scrolls without animation and moves keyboard focus without a second scroll", () => {
    const card = { scrollIntoView: vi.fn(), focus: vi.fn() }; const getElementById = vi.fn().mockReturnValue(card);
    vi.stubGlobal("document", { getElementById });
    expect(ReviewFocus({ decisionId: "decision-1", revision: "2:APPLIED:applied" })).toBeNull(); effects.run?.();
    expect(getElementById).toHaveBeenCalledWith("decision-decision-1");
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    expect(card.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(effects.dependencies).toEqual(["decision-1", "2:APPLIED:applied"]);
  });
  it("ignores invalid IDs and an absent card", () => {
    const getElementById = vi.fn().mockReturnValue(null); vi.stubGlobal("document", { getElementById });
    ReviewFocus({ decisionId: "bad[id]", revision: "0" }); effects.run?.(); expect(getElementById).not.toHaveBeenCalled();
    ReviewFocus({ decisionId: "missing", revision: "0" }); expect(() => effects.run?.()).not.toThrow();
  });
});
