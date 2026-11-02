"use client";

import {
  Children,
  isValidElement,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./Tabs.module.css";

export type TabDef = { id: string; label: string; badge?: ReactNode };
export type TabPaneProps = { tabId: string; children: ReactNode };

// Optional keyed pane wrapper for dynamic tab sets. Tabs with a fixed set may
// continue using positional children. Dynamic screens should use TabPane so a
// missing/conditional pane can never shift another tab's content.
export function TabPane({ children }: TabPaneProps) {
  return <>{children}</>;
}

// Uncontrolled tabs (B0 seam; B3 imports this unchanged). Local state owns the
// active tab. `children` is one pane per tab, index-aligned with `tabs`.
// Accessible: role="tablist" with roving arrow-key focus + Enter/Space activation.
// `disabled` keeps the current tab and ignores clicks and keys on the others.
export function Tabs({ tabs, children, activeId, onActiveChange, label = "Tabs", disabled = false }: {
  tabs: TabDef[]; children?: ReactNode; activeId?: string; onActiveChange?: (id: string) => void; label?: string; disabled?: boolean;
}) {
  const [localActive, setLocalActive] = useState(0);
  const active = activeId === undefined ? localActive : Math.max(0, tabs.findIndex(tab => tab.id === activeId));
  function setActive(index: number) {
    if (disabled) return;
    setLocalActive(index);
    if (tabs[index]) onActiveChange?.(tabs[index].id);
  }
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panes = Children.toArray(children);
  const keyedPanes = new Map<string, ReactNode>();
  for (const pane of panes) {
    if (
      isValidElement<TabPaneProps>(pane) &&
      typeof pane.props.tabId === "string"
    ) {
      keyedPanes.set(pane.props.tabId, pane.props.children);
    }
  }
  const usesKeyedPanes = keyedPanes.size > 0;

  function focusTab(index: number) {
    if (disabled) return;
    const next = (index + tabs.length) % tabs.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusTab(index + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusTab(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTab(tabs.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActive(index);
    }
  }

  return (
    <div className={styles.tabs}>
      <div role="tablist" className={styles.tablist} aria-label={label}>
        {tabs.map((tab, i) => {
          const selected = i === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              id={`${baseId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-disabled={disabled && !selected ? true : undefined}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`${styles.tab} ${selected ? styles.active : ""}`.trim()}
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          id={`${baseId}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={i !== active}
          className={styles.panel}
        >
          {usesKeyedPanes ? keyedPanes.get(tab.id) : panes[i]}
        </div>
      ))}
    </div>
  );
}
