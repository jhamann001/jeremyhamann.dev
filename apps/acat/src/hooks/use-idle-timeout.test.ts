import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockSignOut = vi.fn();
let mockSession: { data: unknown } = { data: null };

vi.mock("next-auth/react", () => ({
  useSession: () => mockSession,
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

import {
  useIdleTimeout,
  IDLE_TIMEOUT_MS,
  WARNING_AT_MS,
} from "./use-idle-timeout";

// Pin to one minute for a few readability-oriented tests below.
const MIN = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  mockSignOut.mockClear();
  mockSession = { data: null };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useIdleTimeout", () => {
  it("does not sign out when there is no session", () => {
    mockSession = { data: null };
    const { result } = renderHook(() => useIdleTimeout());

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 60 * MIN);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(result.current.showWarning).toBe(false);
  });

  it("signs out after the idle timeout elapses", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    renderHook(() => useIdleTimeout());

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + MIN);
    expect(mockSignOut).toHaveBeenCalledWith({
      callbackUrl: "/login?reason=timeout",
    });
  });

  it("does not sign out before the idle timeout elapses", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    renderHook(() => useIdleTimeout());

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - MIN);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("shows warning once WARNING_AT_MS is reached", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    const { result } = renderHook(() => useIdleTimeout());

    expect(result.current.showWarning).toBe(false);

    act(() => {
      vi.advanceTimersByTime(WARNING_AT_MS + 1000);
    });

    expect(result.current.showWarning).toBe(true);
    expect(result.current.secondsLeft).toBeGreaterThan(0);
    expect(result.current.secondsLeft).toBeLessThanOrEqual(
      Math.ceil((IDLE_TIMEOUT_MS - WARNING_AT_MS) / 1000)
    );
  });

  it("countdown decreases over time", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    const { result } = renderHook(() => useIdleTimeout());

    act(() => {
      vi.advanceTimersByTime(WARNING_AT_MS + 30 * 1000);
    });

    const first = result.current.secondsLeft;

    act(() => {
      vi.advanceTimersByTime(30 * 1000);
    });

    expect(result.current.secondsLeft).toBeLessThan(first);
  });

  it("staySignedIn dismisses the warning and resets the timer", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    const { result } = renderHook(() => useIdleTimeout());

    act(() => {
      vi.advanceTimersByTime(WARNING_AT_MS + MIN);
    });

    expect(result.current.showWarning).toBe(true);

    act(() => {
      result.current.staySignedIn();
    });

    expect(result.current.showWarning).toBe(false);
    expect(result.current.secondsLeft).toBe(0);

    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });

    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("resets the timer on pointer/keyboard activity", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    renderHook(() => useIdleTimeout());

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 5 * MIN);
    expect(mockSignOut).not.toHaveBeenCalled();

    vi.advanceTimersByTime(31 * 1000);
    document.dispatchEvent(new Event("mousemove"));

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 5 * MIN);
    expect(mockSignOut).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6 * MIN);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("resets the timer when the tab becomes visible again", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    renderHook(() => useIdleTimeout());

    // Almost at the warning threshold — user has been passively reading.
    vi.advanceTimersByTime(WARNING_AT_MS - MIN);

    // Simulate tab going to background and coming back.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // From the visibility event we should be far from timeout again.
    vi.advanceTimersByTime(WARNING_AT_MS - MIN);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("resets the timer when the window regains focus", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    renderHook(() => useIdleTimeout());

    vi.advanceTimersByTime(WARNING_AT_MS - MIN);
    window.dispatchEvent(new Event("focus"));

    vi.advanceTimersByTime(WARNING_AT_MS - MIN);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("only calls signOut once even after multiple interval ticks", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    renderHook(() => useIdleTimeout());

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 60 * MIN);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("cleans up listeners on unmount", () => {
    mockSession = { data: { user: { email: "test@test.com" } } };
    const docRemoveSpy = vi.spyOn(document, "removeEventListener");
    const winRemoveSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useIdleTimeout());

    unmount();

    const removedDocEvents = docRemoveSpy.mock.calls.map((c) => c[0]);
    expect(removedDocEvents).toContain("mousemove");
    expect(removedDocEvents).toContain("keydown");
    expect(removedDocEvents).toContain("mousedown");
    expect(removedDocEvents).toContain("touchstart");
    expect(removedDocEvents).toContain("scroll");
    expect(removedDocEvents).toContain("visibilitychange");

    const removedWinEvents = winRemoveSpy.mock.calls.map((c) => c[0]);
    expect(removedWinEvents).toContain("focus");

    docRemoveSpy.mockRestore();
    winRemoveSpy.mockRestore();
  });
});
