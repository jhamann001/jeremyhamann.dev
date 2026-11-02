import type { AssetMapEditResult, AssetMapReadResult, AssetMapSourceTarget } from "@/app/(authenticated)/asset-mapping/actions";
import type { AssetMapDestinationsView } from "@/lib/data/asset-map-destinations";
import { FAILURE_MS } from "../edits/edit-model";
import { destinationFailureText, destinationKey, type DestinationAction, type DestinationIntent, type DestinationSave } from "./destination-model";

export type DestinationActions = {
  load: (householdId: string) => Promise<AssetMapReadResult<AssetMapDestinationsView>>;
  add: (householdId: string, owner: string | null, targetAccountType: string) => Promise<AssetMapEditResult<{ id: string | null; owner: string | null; targetAccountType: string }>>;
  setNeedsOpen: (targetId: string, needsToBeOpened: boolean) => Promise<AssetMapEditResult<{ needsToBeOpened: boolean }>>;
  setType: (targetId: string, targetAccountType: string) => Promise<AssetMapEditResult<{ targetAccountType: string }>>;
  remove: (targetId: string) => Promise<AssetMapEditResult<{ id: string }>>;
  reassign: (householdId: string, linkId: string, target: AssetMapSourceTarget) => Promise<AssetMapEditResult<{ linkId: string; targetAccountId: string | null }>>;
};

export type DestinationDeps = {
  actions: DestinationActions;
  dispatch: (a: DestinationAction) => void;
  nextSeq: () => number;
  schedule: (fn: () => void, ms: number) => void;
  /** The household open now; a reply for a household the user has left is dropped. */
  currentHousehold: () => string | null;
};

async function call<T, F>(fn: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function loadDestinations(householdId: string, deps: DestinationDeps): Promise<void> {
  const r = await call(() => deps.actions.load(householdId), { ok: false as const, reason: "unavailable" as const });
  if (deps.currentHousehold() !== householdId) return;
  deps.dispatch(r.ok ? { type: "loaded", view: r.data } : { type: "loadFailed" });
}

const UNAVAILABLE = { ok: false as const, reason: "unavailable" as const };

async function save(householdId: string, intent: DestinationIntent, actions: DestinationActions): Promise<AssetMapEditResult<DestinationSave>> {
  switch (intent.kind) {
    case "add": {
      const r = await call(() => actions.add(householdId, intent.owner, intent.targetAccountType), UNAVAILABLE);
      return r.ok ? { ok: true, data: { kind: "add", ...r.data } } : r;
    }
    case "needsOpen": {
      const r = await call(() => actions.setNeedsOpen(intent.targetId, intent.needsToBeOpened), UNAVAILABLE);
      return r.ok ? { ok: true, data: { kind: "needsOpen", targetId: intent.targetId, needsToBeOpened: r.data.needsToBeOpened } } : r;
    }
    case "type": {
      const r = await call(() => actions.setType(intent.targetId, intent.targetAccountType), UNAVAILABLE);
      return r.ok ? { ok: true, data: { kind: "type", targetId: intent.targetId, targetAccountType: r.data.targetAccountType } } : r;
    }
    case "remove": {
      const r = await call(() => actions.remove(intent.targetId), UNAVAILABLE);
      return r.ok ? { ok: true, data: { kind: "remove", targetId: intent.targetId } } : r;
    }
    case "reassign": {
      const r = await call(() => actions.reassign(householdId, intent.linkId, { targetAccountId: intent.targetAccountId }), UNAVAILABLE);
      return r.ok ? { ok: true, data: { kind: "reassign", linkId: intent.linkId, targetAccountId: r.data.targetAccountId, newOwner: null, created: false } } : r;
    }
    case "reassignNew": {
      const r = await call(() => actions.reassign(householdId, intent.linkId, { newOwner: intent.newOwner }), UNAVAILABLE);
      return r.ok ? { ok: true, data: { kind: "reassign", linkId: intent.linkId, targetAccountId: r.data.targetAccountId, newOwner: intent.newOwner, created: true } } : r;
    }
  }
}

export async function performDestinationSave(householdId: string, intent: DestinationIntent, deps: DestinationDeps): Promise<void> {
  const key = destinationKey(intent);
  deps.dispatch({ type: "pending", key });
  const r = await save(householdId, intent, deps.actions);
  if (deps.currentHousehold() !== householdId) return;
  if (!r.ok) {
    const seq = deps.nextSeq();
    deps.dispatch({ type: "failed", key, text: destinationFailureText(intent.kind, r.reason), seq });
    deps.schedule(() => deps.dispatch({ type: "failureExpired", seq }), FAILURE_MS);
    return;
  }
  deps.dispatch({ type: "saved", key, save: r.data });
  await loadDestinations(householdId, deps);
}
