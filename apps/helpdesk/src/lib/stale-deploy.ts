/**
 * A tab opened before a deploy. Every clean build gives each server action a new id, so a page rendered by
 * the previous build calls actions the new one does not have, and Next reports that as an
 * UnrecognizedActionError. Nothing ran on the server, so a reload is the whole fix.
 */
import { unstable_isUnrecognizedActionError } from "next/navigation";

export const isStaleDeployError = (error: unknown): boolean => unstable_isUnrecognizedActionError(error);

const RELOADED_AT_KEY = "wm-helpdesk:stale-deploy-reload";
const LOOP_GUARD_MS = 30_000;

interface ReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  now: number;
}

/**
 * Reloads the tab, at most once per 30 seconds: a page that fails again for another reason shows its error
 * instead of reloading forever. Returns whether it reloaded. With no session storage there is no loop guard,
 * so it leaves the reload to the person.
 */
export function reloadOnceForNewDeploy(deps?: Partial<ReloadDeps>): boolean {
  const now = deps?.now ?? Date.now();
  try {
    const storage = deps?.storage ?? window.sessionStorage;
    const last = Number(storage.getItem(RELOADED_AT_KEY));
    if (last > 0 && now - last < LOOP_GUARD_MS) return false;
    storage.setItem(RELOADED_AT_KEY, String(now));
  } catch {
    return false;
  }
  (deps?.reload ?? (() => window.location.reload()))();
  return true;
}
