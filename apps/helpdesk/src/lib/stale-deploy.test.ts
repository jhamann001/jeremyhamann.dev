import { describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { isStaleDeployError, reloadOnceForNewDeploy } from "@/lib/stale-deploy";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

describe("isStaleDeployError", () => {
  it("is true only for Next's unrecognized server action", () => {
    expect(isStaleDeployError(new UnrecognizedActionError('Server Action "604a61" was not found on the server.'))).toBe(true);
    expect(isStaleDeployError(new Error('Server Action "604a61" was not found on the server.'))).toBe(false);
    expect(isStaleDeployError(undefined)).toBe(false);
  });
});

describe("reloadOnceForNewDeploy", () => {
  it("reloads the first time", () => {
    const reload = vi.fn();
    expect(reloadOnceForNewDeploy({ storage: memoryStorage(), reload, now: 1_000_000 })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload again within 30 seconds, so a page that keeps failing cannot loop", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    reloadOnceForNewDeploy({ storage, reload, now: 1_000_000 });
    expect(reloadOnceForNewDeploy({ storage, reload, now: 1_029_000 })).toBe(false);
    expect(reloadOnceForNewDeploy({ storage, reload, now: 1_031_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("leaves the reload to the person when session storage is unavailable", () => {
    const reload = vi.fn();
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(reloadOnceForNewDeploy({ storage, reload, now: 1 })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
