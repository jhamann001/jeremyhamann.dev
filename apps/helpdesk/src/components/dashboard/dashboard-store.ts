/**
 * Dashboard UI state. UI state only — never record content.
 * The preview sheet's data lives in React Query; this store just remembers which ticket is open.
 */
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";

export type DashboardState = {
  previewTicketId: string | null;
  openPreview(id: string): void;
  closePreview(): void;
};

export const useDashboardStore: UseBoundStore<StoreApi<DashboardState>> = create<DashboardState>()((set) => ({
  previewTicketId: null,
  openPreview: (id) => set({ previewTicketId: id }),
  closePreview: () => set({ previewTicketId: null }),
}));
