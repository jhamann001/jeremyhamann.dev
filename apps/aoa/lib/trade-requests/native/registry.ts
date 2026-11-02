import type { TradeRequestCall, TradeRequestOperation, TradeRequestResult } from "../client";

// The dispatch seam: native handlers by operation. Reads register in ./reads
// (ticket), writes in ./writes (ticket). An operation with no handler keeps
// the delegated call.

export type NativeActor = { aoaUserId: string; email: string; name: string; role: "ADMIN" | "OPERATIONS" | "ADVISOR" };
export type NativeHandler = (call: TradeRequestCall, actor: NativeActor) => Promise<TradeRequestResult<unknown>>;

const handlers = new Map<TradeRequestOperation, NativeHandler>();

export function registerNativeHandler(operation: TradeRequestOperation, handler: NativeHandler): void {
  const existing = handlers.get(operation);
  if (existing && existing !== handler) throw new Error(`native handler already registered: ${operation}`);
  handlers.set(operation, handler);
}

export function nativeHandlerFor(operation: TradeRequestOperation): NativeHandler | undefined {
  return handlers.get(operation);
}

export function registeredNativeOperations(): TradeRequestOperation[] {
  return [...handlers.keys()].sort();
}

/** The standalone role rule (owner ruling D1): ADMIN and OPERATIONS review, ADVISOR submits. */
export function standaloneRole(actor: NativeActor): "trader" | "advisor" {
  return actor.role === "ADVISOR" ? "advisor" : "trader";
}
