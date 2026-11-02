import type { AssetMapDestination, AssetMapDestinationsView } from "@/lib/data/asset-map-destinations";
import { EDIT_COPY, type EditFailureReason } from "../edits/edit-model";

/** The pipeline UI's ATO_TYPES (App.jsx lines 2195–2200), in its order. */
export const DESTINATION_TYPES = [
  "Individual", "JWROS", "JTIC", "Joint Community Property",
  "Roth IRA", "Traditional IRA", "Beneficiary Roth IRA", "Beneficiary Traditional IRA",
] as const;
export const NEW_DESTINATION_TYPE = "Individual";
export const NEW_DESTINATION_VALUE = "__new__";

export function isDestinationType(v: unknown): v is string {
  return typeof v === "string" && (DESTINATION_TYPES as readonly string[]).includes(v);
}

/** The eight types, with an off-list current type (a seeded "Joint", say) first. */
export function destinationTypeOptions(current: string | null): string[] {
  return current && !isDestinationType(current) ? [current, ...DESTINATION_TYPES] : [...DESTINATION_TYPES];
}

export const DESTINATION_COPY = {
  heading: "Accounts to be opened at Apex",
  suggestionNote: "Suggestions checked against each owner's open accounts at Apex",
  addNew: "+ Add new account",
  ownerPlaceholder: "Owner name",
  newTypeLabel: "New account type",
  add: "Add",
  empty: "No destinations yet — they auto-seed when the client is scanned.",
  typeLabel: "Account type to open",
  needsLabel: "Needs to be opened?",
  needsYes: "Yes — new account",
  needsNo: "No — use existing",
  remove: "remove destination",
  moveLabel: "Move to destination",
  movePlaceholder: "move",
  newAccount: "+ New account…",
  transfersTo: "Transfers to",
  saving: "Saving…",
  loading: "Loading…",
  loadFailed: "Destinations could not be loaded.",
  retry: "Try Again",
  exportCsv: "Export CSV",
  failed: {
    add: "Failed to add destination",
    needsOpen: "Failed to update destination",
    type: "Failed to update destination",
    remove: "Failed to remove destination",
    reassign: "Failed to move source account",
  },
} as const;

export type DestinationIntent =
  | { kind: "add"; owner: string; targetAccountType: string }
  | { kind: "needsOpen"; targetId: string; needsToBeOpened: boolean }
  | { kind: "type"; targetId: string; targetAccountType: string }
  | { kind: "remove"; targetId: string }
  | { kind: "reassign"; linkId: string; targetAccountId: string }
  | { kind: "reassignNew"; linkId: string; newOwner: string | null };

export type DestinationSave =
  | { kind: "add"; id: string | null; owner: string | null; targetAccountType: string }
  | { kind: "needsOpen"; targetId: string; needsToBeOpened: boolean }
  | { kind: "type"; targetId: string; targetAccountType: string }
  | { kind: "remove"; targetId: string }
  | { kind: "reassign"; linkId: string; targetAccountId: string | null; newOwner: string | null; created: boolean };

export function destinationKey(intent: DestinationIntent): string {
  switch (intent.kind) {
    case "add": return "add";
    case "needsOpen": return `needsOpen:${intent.targetId}`;
    case "type": return `type:${intent.targetId}`;
    case "remove": return `remove:${intent.targetId}`;
    case "reassign":
    case "reassignNew": return `reassign:${intent.linkId}`;
  }
}

export function destinationFailureText(kind: DestinationIntent["kind"], reason: EditFailureReason): string {
  if (reason === "forbidden") return EDIT_COPY.forbidden;
  return DESTINATION_COPY.failed[kind === "reassignNew" ? "reassign" : kind];
}

export function destinationCountLine(list: AssetMapDestination[]): string {
  return `${list.length} destinations · ${list.filter((d) => d.needsToBeOpened).length} to open`;
}

export function destinationApex(d: AssetMapDestination): string | null {
  return d.existingApexNumber || d.suggestedApexNumber || null;
}

export function destinationTag(d: AssetMapDestination): string {
  if (d.needsToBeOpened) return "new account";
  const apex = destinationApex(d);
  return apex ? `existing · ${apex}` : "existing";
}

export function suggestionText(d: AssetMapDestination): { found: boolean; text: string } {
  const type = d.targetAccountType ?? "";
  if (d.existingCount > 1) return { found: true, text: `${d.existingCount} existing ${type} accounts found — pick one` };
  if (d.existingCount === 1) {
    const apex = destinationApex(d);
    return { found: true, text: `Existing ${type} account found${apex ? ` — ${apex}` : ""}` };
  }
  return { found: false, text: `No open ${type} account for ${d.owner || "this owner"} — suggest opening a new one` };
}

export function fedByText(n: number): string {
  return `fed by ${n} source account${n === 1 ? "" : "s"}`;
}

export function destinationLabel(d: AssetMapDestination, withApex: boolean): string {
  const apex = withApex ? destinationApex(d) : null;
  return `${d.owner || "—"} · ${d.targetAccountType ?? ""}${apex ? ` (${apex})` : ""}`;
}

/** The pipeline's linkForAccount: the first destination with a source on this account. */
export function sourceForAccount(view: AssetMapDestinationsView | null, accountId: string): { linkId: string; destination: AssetMapDestination } | null {
  for (const d of view?.destinations ?? []) {
    const s = d.sources.find((x) => x.accountId === accountId);
    if (s) return { linkId: s.linkId, destination: d };
  }
  return null;
}

export function applyDestinationSave(list: AssetMapDestination[], save: DestinationSave): AssetMapDestination[] {
  switch (save.kind) {
    case "add":
      return save.id == null ? list : [...list, {
        id: save.id, owner: save.owner, targetAccountType: save.targetAccountType, existingApexNumber: null,
        needsToBeOpened: true, existingCount: 0, suggestedApexNumber: null, sources: [],
      }];
    case "needsOpen":
      return list.map((d) => (d.id === save.targetId ? { ...d, needsToBeOpened: save.needsToBeOpened } : d));
    case "type":
      return list.map((d) => (d.id === save.targetId ? { ...d, targetAccountType: save.targetAccountType } : d));
    case "remove":
      return list.filter((d) => d.id !== save.targetId);
    case "reassign": {
      const source = list.flatMap((d) => d.sources).find((s) => s.linkId === save.linkId);
      if (!source || save.targetAccountId == null) return list;
      const targetId = save.targetAccountId;
      const moved = list.map((d) => ({ ...d, sources: d.sources.filter((s) => s.linkId !== save.linkId) }));
      if (moved.some((d) => d.id === targetId)) {
        return moved.map((d) => (d.id === targetId ? { ...d, sources: [...d.sources, source] } : d));
      }
      return save.created ? [...moved, {
        id: targetId, owner: save.newOwner, targetAccountType: NEW_DESTINATION_TYPE, existingApexNumber: null,
        needsToBeOpened: true, existingCount: 0, suggestedApexNumber: null, sources: [source],
      }] : list;
    }
  }
}

export type DestinationState = {
  status: "idle" | "loading" | "loaded" | "failed";
  view: AssetMapDestinationsView | null;
  pending: string[];
  failure: { key: string; text: string; seq: number } | null;
};

export type DestinationAction =
  | { type: "reset" }
  | { type: "loading" }
  | { type: "loaded"; view: AssetMapDestinationsView }
  | { type: "loadFailed" }
  | { type: "pending"; key: string }
  | { type: "saved"; key: string; save: DestinationSave }
  | { type: "failed"; key: string; text: string; seq: number }
  | { type: "failureExpired"; seq: number };

export function initialDestinationState(): DestinationState {
  return { status: "idle", view: null, pending: [], failure: null };
}

export function destinationReducer(state: DestinationState, action: DestinationAction): DestinationState {
  const without = (key: string) => state.pending.filter((k) => k !== key);
  switch (action.type) {
    case "reset": return initialDestinationState();
    case "loading": return { ...state, status: "loading" };
    case "loaded": return { ...state, status: "loaded", view: action.view };
    // A failed re-read after a save keeps the confirmed list; only a first load fails the section.
    case "loadFailed": return state.view ? { ...state, status: "loaded" } : { ...state, status: "failed" };
    case "pending": return { ...state, pending: [...without(action.key), action.key], failure: state.failure?.key === action.key ? null : state.failure };
    case "saved":
      return {
        ...state,
        pending: without(action.key),
        view: state.view ? { ...state.view, destinations: applyDestinationSave(state.view.destinations, action.save) } : state.view,
      };
    case "failed": return { ...state, pending: without(action.key), failure: { key: action.key, text: action.text, seq: action.seq } };
    case "failureExpired": return state.failure?.seq === action.seq ? { ...state, failure: null } : state;
  }
}
