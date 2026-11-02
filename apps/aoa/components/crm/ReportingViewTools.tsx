"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CrmReportDatasetId } from "@/lib/crm/reporting-contracts";
import type { SavedReportShortcut } from "@/lib/reporting/saved-reports";
import { SavedReportLinks } from "@/components/reporting/SavedReportShortcuts";
import {
  CRM_PINNED_REPORT_VIEWS,
  crmPinnedReportHref,
} from "@/lib/crm/reporting-query";
import {
  MAX_SAVED_REPORT_VIEWS,
  normalizeSavedReportViewName,
  parseSavedReportViews,
  type SavedCrmReportView,
} from "@/lib/crm/reporting-saved-views";
import styles from "./ReportingViewTools.module.css";

const DATASET_LABELS: Record<CrmReportDatasetId, string> = {
  household_aum: "Households & AUM",
  deal_pipeline: "Deal pipeline",
  client_engagement: "Client engagement",
  transfers_funding: "Transfers & funding",
};

type ReportingViewToolsProps = {
  currentHref: string;
  saveHref: string;
  dataset: CrmReportDatasetId;
  storageScope: string;
  savedReports?: readonly SavedReportShortcut[];
};

export function ReportingViewTools({
  currentHref,
  saveHref,
  dataset,
  storageScope,
  savedReports = [],
}: ReportingViewToolsProps) {
  const storageKey = useMemo(
    () => `aoa.reporting.savedViews.v1.${storageScope}`,
    [storageScope],
  );
  const [savedViews, setSavedViews] = useState<SavedCrmReportView[]>([]);
  const [viewName, setViewName] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setSavedViews(parseSavedReportViews(window.localStorage.getItem(storageKey)));
    } catch {
      setSavedViews([]);
      setMessage("Saved views are unavailable in this browser.");
    }
    setReady(true);
  }, [storageKey]);

  const persist = (next: SavedCrmReportView[]): boolean => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      setSavedViews(next);
      return true;
    } catch {
      setMessage("This browser could not save the view. Copy the current link instead.");
      return false;
    }
  };

  const saveCurrentView = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = normalizeSavedReportViewName(viewName);
    if (!name) {
      setMessage("Give this view a name before saving it.");
      return;
    }
    if (savedViews.some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setMessage("A saved view already uses that name.");
      return;
    }
    if (savedViews.length >= MAX_SAVED_REPORT_VIEWS) {
      setMessage(`Remove a saved view before adding another. The limit is ${MAX_SAVED_REPORT_VIEWS}.`);
      return;
    }
    const next = [
      {
        id: globalThis.crypto?.randomUUID?.() ?? `view-${Date.now()}`,
        name,
        href: saveHref,
        dataset,
        createdAt: new Date().toISOString(),
      },
      ...savedViews,
    ];
    if (!persist(next)) return;
    setViewName("");
    setMessage(`Saved “${name}” on this browser.`);
  };

  const removeView = (id: string) => {
    const removed = savedViews.find((view) => view.id === id);
    if (persist(savedViews.filter((view) => view.id !== id))) {
      setMessage(removed ? `Removed “${removed.name}”.` : "Saved view removed.");
    }
  };

  const copyCurrentView = async () => {
    try {
      const url = new URL(currentHref, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setMessage("Current filtered view copied. Access still follows each user’s AOA permissions.");
    } catch {
      setMessage("The link could not be copied. Copy the current browser address instead.");
    }
  };

  return (
    <section className={styles.tools} aria-labelledby="report-view-tools-title">
      <div className={styles.headingRow}>
        <div>
          <span className={styles.eyebrow}>Report views</span>
          <h2 id="report-view-tools-title">Return to the reports you use</h2>
        </div>
        <button type="button" className={`btn ${styles.copyButton}`} onClick={copyCurrentView}>
          Copy current link
        </button>
      </div>

      <div className={styles.viewLane}>
        <span className={styles.laneLabel}>Pinned</span>
        <div className={styles.viewLinks}>
          {CRM_PINNED_REPORT_VIEWS.map((view) => (
            <Link prefetch={false}
              key={view.id}
              href={crmPinnedReportHref(view)}
              className={styles.viewLink}
              title={view.description}
            >
              <span>{view.label}</span>
              <small>{DATASET_LABELS[view.dataset]}</small>
            </Link>
          ))}
        </div>
      </div>

      {savedReports.length > 0 && (
        <div className={styles.viewLane}>
          <span className={styles.laneLabel}>Saved reports</span>
          <div className={styles.viewLinks}><SavedReportLinks reports={savedReports} /></div>
        </div>
      )}

      <div className={styles.savedLane}>
        <div className={styles.savedViews}>
          <span className={styles.laneLabel}>My saved views</span>
          {!ready ? (
            <span className={styles.empty}>Loading saved views…</span>
          ) : savedViews.length === 0 ? (
            <span className={styles.empty}>None saved on this browser yet.</span>
          ) : (
            <div className={styles.viewLinks}>
              {savedViews.map((view) => (
                <span className={styles.savedView} key={view.id}>
                  <Link prefetch={false} href={view.href} title={DATASET_LABELS[view.dataset]}>{view.name}</Link>
                  <button type="button" onClick={() => removeView(view.id)} aria-label={`Remove saved view ${view.name}`}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <form className={styles.saveForm} onSubmit={saveCurrentView}>
          <label htmlFor="report-view-name">Save this view</label>
          <div>
            <input
              id="report-view-name"
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              maxLength={60}
              placeholder="Name this filtered view"
              autoComplete="off"
            />
            <button type="submit" className="btn">Save</button>
          </div>
        </form>
      </div>
      <p className={styles.message} aria-live="polite">{message || "Saved views stay on this browser; copied links remain read-only and permission-scoped."}</p>
    </section>
  );
}
