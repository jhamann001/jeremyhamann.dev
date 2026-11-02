"use client";

import { useState } from "react";
import { loadClientExclusions } from "@/app/(authenticated)/trade-requests/new/actions";
import { Button } from "@/components/ui";
import {
  EXCLUSIONS_COPY,
  exclusionClientTargets,
  manageExclusionsEnabled,
  manageExclusionsTitle,
  standingExclusionsText,
  withExclusionsNotice,
  withStandingExclusions,
} from "@/lib/trade-requests/new-request-exclusions";
import { useNewRequestDraft } from "../NewRequestDraft";
import { ManageExclusionsDialog } from "./ManageExclusionsDialog";
import styles from "./Exclusions.module.css";

/**
 * "Manage exclusions" beside the client label. After the dialog closes with a
 * saved change, both exclusion fields are replaced with the selected clients'
 * updated standing lists, typed text included (AC-119). If that re-read
 * fails, the text is kept and the refresh notice is shown.
 */
export function ManageExclusionsButton() {
  const { context, updateDraft } = useNewRequestDraft();
  const [open, setOpen] = useState(false);
  const enabled = manageExclusionsEnabled(context);
  const clients = exclusionClientTargets(context);

  function replaceFields() {
    const snapshot = exclusionClientTargets(context);
    if (snapshot.length === 0) return;
    const failed = () => updateDraft((draft) => withExclusionsNotice(draft, EXCLUSIONS_COPY.refreshFailed));
    loadClientExclusions(snapshot.map((client) => client.id))
      .then((result) => {
        if (result.ok) updateDraft((draft) => withStandingExclusions(draft, standingExclusionsText(result.data, snapshot), "replace"));
        else failed();
      })
      .catch(failed);
  }

  return (
    <>
      <Button
        variant="ghost" size="sm" className={styles.manage} disabled={!enabled} title={manageExclusionsTitle(context)}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">⚙</span>
        {EXCLUSIONS_COPY.manageExclusions}
      </Button>
      {open && enabled && (
        <ManageExclusionsDialog
          scope="client"
          entities={clients.map((client) => ({ id: client.id, label: client.name, shortLabel: client.name }))}
          onClose={() => setOpen(false)}
          onSavedChanges={replaceFields}
        />
      )}
    </>
  );
}
