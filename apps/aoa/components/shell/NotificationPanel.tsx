"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Measurable = Pick<HTMLElement, "getBoundingClientRect"> & { style: Pick<CSSStyleDeclaration, "setProperty"> };

/**
 * The panel's top moves with the environment banner, the wrapped phone top bar
 * and the phone navigation row, so the CSS cap reads the measured offset.
 */
export function fitNotificationPanel(panel: Measurable) {
  const top = Math.max(0, Math.ceil(panel.getBoundingClientRect().top));
  panel.style.setProperty("--notification-panel-top", `${top}px`);
}

export function NotificationPanel({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = ref.current;
    const menu = panel?.closest("details");
    if (!panel || !menu) return;
    const fit = () => { if (menu.open) fitNotificationPanel(panel); };
    fit();
    menu.addEventListener("toggle", fit);
    window.addEventListener("resize", fit);
    return () => {
      menu.removeEventListener("toggle", fit);
      window.removeEventListener("resize", fit);
    };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}
