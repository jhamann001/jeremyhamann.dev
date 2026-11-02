import { Tabs } from "@/components/ui";
import { CLIENT_LINK_COPY } from "./client-link-model";
import styles from "./ClientLinking.module.css";

export type WorkspaceSection = "households" | "linking";

const SECTIONS = [
  { id: "households", label: CLIENT_LINK_COPY.tabHouseholds },
  { id: "linking", label: CLIENT_LINK_COPY.tabLinking },
] as const;

function isSection(id: string): id is WorkspaceSection {
  return SECTIONS.some((s) => s.id === id);
}

export function WorkspaceSectionNav({
  visible,
  active,
  onSelect,
}: {
  visible: boolean;
  active: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}) {
  if (!visible) return null;
  return (
    <div className={styles.nav}>
      <Tabs
        tabs={[...SECTIONS]}
        activeId={active}
        onActiveChange={(id) => {
          if (isSection(id)) onSelect(id);
        }}
      />
    </div>
  );
}
