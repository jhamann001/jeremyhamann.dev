"use client";

import { useEffect, useState } from "react";
import type { HouseholdDirectoryPage, HouseholdDirectoryPreviewRow } from "@/lib/data/households";
import { fetchHouseholdPage, HouseholdPageError } from "@/lib/navigation/household-pages";
import { householdDirectoryQueryKey, HOUSEHOLD_DIRECTORY_PAGE_SIZE } from "@/lib/navigation/household-query";
import type { HouseholdDirectoryFilters } from "./directory-results";
import { HouseholdsPreview } from "./HouseholdsPreview";
import { HouseholdsTable } from "./HouseholdsTable";

/** Keep the exact AUM/counts query off the critical path for first-row paint.
 * Hidden or abandoned tabs do not start that expensive read. The paging API
 * reauthenticates and validates the scope before returning any exact data. */
export function DeferredHouseholdsDirectory({
  preview, filters, scope, showFirm,
}: {
  preview: HouseholdDirectoryPreviewRow[];
  filters: HouseholdDirectoryFilters;
  scope: string;
  showFirm: boolean;
}) {
  const [directory, setDirectory] = useState<HouseholdDirectoryPage | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let firstFrame = 0;
    let secondFrame = 0;
    let started = false;
    let paintGatePassed = false;
    const start = () => {
      if (started || !paintGatePassed || document.visibilityState !== "visible" || controller.signal.aborted) return;
      // Start exact cards, filters and balances after the preview's paint gate,
      // without adding an idle window or postponing this tab for another tab.
      started = true;
      void fetchHouseholdPage(filters, 1, null, HOUSEHOLD_DIRECTORY_PAGE_SIZE, controller.signal, scope)
        .then((result) => { if (!controller.signal.aborted) setDirectory(result); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof HouseholdPageError && (error.kind === "unauthorized" || error.kind === "changed")) {
            // Do not keep rows from a former login or changed book visible.
            window.location.reload();
            return;
          }
          setUnavailable(true);
        });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        paintGatePassed = true;
        start();
      });
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      controller.abort();
    };
  }, [filters, scope]);

  if (!directory) return <HouseholdsPreview rows={preview} unavailable={unavailable} />;
  return <HouseholdsTable
    key={`${scope}:${householdDirectoryQueryKey(filters)}:${directory.page}:${directory.snapshot}`}
    initialDirectory={directory}
    initialFilters={filters}
    scope={scope}
    showFirm={showFirm}
  />;
}
