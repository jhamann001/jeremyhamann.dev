"use client";

import { demoMode } from "@/lib/demo/mode";
import { withTheme, type OtherDemo } from "@/lib/demo/links";
import styles from "./DemoRecordLink.module.css";

/**
 * "Open in the … demo ↗": the same record in another public demo (lib/demo/links.ts), in a new tab, starting in the
 * theme the visitor is reading this one in. Renders nothing outside the demo.
 */
export function DemoRecordLink({ href, demo, className }: { href: string; demo: OtherDemo; className?: string }) {
  if (!demoMode()) return null;
  return (
    <a
      className={className ?? styles.link}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-other-demo={demo}
      onClick={(event) => {
        event.currentTarget.href = withTheme(href, document.documentElement.classList.contains("dark"));
      }}
    >
      Open in the {demo} demo ↗
    </a>
  );
}
