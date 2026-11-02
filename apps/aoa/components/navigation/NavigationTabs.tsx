"use client";

import { useSearchParams } from "next/navigation";
import { Children, isValidElement, type ReactNode } from "react";
import { Tabs, type TabDef, type TabPaneProps } from "@/components/ui/Tabs";
import { normalizePortraitTab, resolvePortraitTab, replacePortraitTab } from "@/lib/navigation/portrait-tabs";
import styles from "./NavigationTabs.module.css";

/** URL metadata only: changing an already rendered pane performs no server read. */
export function NavigationTabs({ tabs, children, parameter = "portraitTab", standaloneTab }: {
  tabs: TabDef[]; children?: ReactNode; parameter?: "portraitTab"; standaloneTab?: TabDef;
}) {
  const search = useSearchParams();
  const requested = standaloneTab
    ? resolvePortraitTab(search.get(parameter))
    : normalizePortraitTab(search.get(parameter));
  const active = tabs.find(tab => tab.id === requested)?.id ?? tabs[0]?.id;
  const submenu = <Tabs tabs={tabs} activeId={active} onActiveChange={id => replacePortraitTab(id)}>{children}</Tabs>;
  if (!standaloneTab) return submenu;

  const standalonePane = Children.toArray(children).find(child =>
    isValidElement<TabPaneProps>(child) && child.props.tabId === standaloneTab.id,
  );
  const standaloneActive = requested === standaloneTab.id;
  return <>
    <div className={styles.submenu} hidden={standaloneActive}>{submenu}</div>
    <section aria-label={standaloneTab.label} hidden={!standaloneActive}>
      {standalonePane}
    </section>
  </>;
}
