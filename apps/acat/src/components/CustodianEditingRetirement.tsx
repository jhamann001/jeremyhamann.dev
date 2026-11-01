"use client";

import { createContext, useContext } from "react";

const CustodianEditingRetiredContext = createContext(false);

export function CustodianEditingRetirementProvider({
  retired,
  children,
}: {
  retired: boolean;
  children: React.ReactNode;
}) {
  return (
    <CustodianEditingRetiredContext.Provider value={retired}>
      {children}
    </CustodianEditingRetiredContext.Provider>
  );
}

export function useCustodianEditingRetired(): boolean {
  return useContext(CustodianEditingRetiredContext);
}
