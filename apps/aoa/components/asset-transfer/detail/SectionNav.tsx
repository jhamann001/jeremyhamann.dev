"use client";

import { useEffect, type ReactNode } from "react";
import { btnClass, type BtnStyle } from "@/components/asset-transfer/workspace/ui";
import { CORE_SECTIONS } from "./detail-model";

const RELATED_IDS = ["followups", "history", "transfer-follow-up-panel", "transfer-outcomes-panel"];

/** Mockup openWorkflowSection: opening one core step closes its siblings. */
export function openWorkflowSection(id: string, { scroll = true }: { scroll?: boolean } = {}): void {
  const section = document.getElementById(id);
  if (!section) return;
  if ((CORE_SECTIONS as readonly string[]).includes(id)) {
    for (const other of CORE_SECTIONS) {
      const sibling = document.getElementById(other);
      if (other !== id && sibling instanceof HTMLDetailsElement) sibling.open = false;
    }
  }
  if (id === "related-work" || RELATED_IDS.includes(id)) {
    const parent = document.getElementById("related-work");
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  if (section instanceof HTMLDetailsElement) section.open = true;
  if (scroll) {
    window.history.replaceState(null, "", `#${id}`);
    section.scrollIntoView({ block: "start", behavior: "smooth" });
    section.querySelector("summary")?.focus({ preventScroll: true });
  }
}

export function OpenSectionButton({ target, children, ...style }: BtnStyle & { target: string; children: ReactNode }) {
  return <button type="button" className={btnClass(style)} data-section-open={target} onClick={() => openWorkflowSection(target)}>{children}</button>;
}

export function SectionLink({ target, className, children }: { target: string; className?: string; children: ReactNode }) {
  return (
    <a href={`#${target}`} className={className} onClick={event => { event.preventDefault(); openWorkflowSection(target); }}>{children}</a>
  );
}

/** A deep link such as #mapping opens its section on arrival. */
export function HashSectionOpener() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) openWorkflowSection(id);
  }, []);
  return null;
}
