"use client";

import { createContext, useContext } from "react";

const NoPlanCopyContext = createContext(false);

// The server's no-plan copy switch (ticket), provided by the workspace
// layout. Without a provider the form shows today's copy.
export function NoPlanCopyProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return <NoPlanCopyContext.Provider value={enabled}>{children}</NoPlanCopyContext.Provider>;
}

export function useNoPlanCopy(): boolean {
  return useContext(NoPlanCopyContext);
}
