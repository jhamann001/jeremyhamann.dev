"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  addAssetMapDestination, loadAssetMapDestinations, reassignAssetMapSource,
  removeAssetMapDestination, setAssetMapDestinationNeedsOpen, setAssetMapDestinationType,
} from "@/app/(authenticated)/asset-mapping/actions";
import { destinationReducer, initialDestinationState, type DestinationIntent } from "./destination-model";
import { loadDestinations, performDestinationSave, type DestinationDeps } from "./run-destination";

/** `householdId` is null while the destinations flag is off, so nothing is read. */
export function useAssetMapDestinations(householdId: string | null) {
  const [state, dispatch] = useReducer(destinationReducer, undefined, initialDestinationState);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const current = useRef<string | null>(null);
  const deps = useMemo<DestinationDeps>(() => ({
    actions: {
      load: loadAssetMapDestinations,
      add: addAssetMapDestination,
      setNeedsOpen: setAssetMapDestinationNeedsOpen,
      setType: setAssetMapDestinationType,
      remove: removeAssetMapDestination,
      reassign: reassignAssetMapSource,
    },
    dispatch,
    nextSeq: () => ++seq.current,
    schedule: (fn, ms) => {
      const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
      timers.current.add(t);
    },
    currentHousehold: () => current.current,
  }), []);

  useEffect(() => {
    current.current = householdId;
    dispatch({ type: "reset" });
    if (householdId == null) return;
    dispatch({ type: "loading" });
    void loadDestinations(householdId, deps);
  }, [householdId, deps]);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  return {
    state,
    save: (intent: DestinationIntent) => { if (householdId) void performDestinationSave(householdId, intent, deps); },
    retry: () => {
      if (!householdId) return;
      dispatch({ type: "loading" });
      void loadDestinations(householdId, deps);
    },
  };
}
