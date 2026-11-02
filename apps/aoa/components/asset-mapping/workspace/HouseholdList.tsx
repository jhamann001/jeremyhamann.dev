import { Button } from "@/components/ui";
import { COPY, HOUSEHOLD_STATUS_LABEL, filterClientNames, showRunCountBadge, type RunGroups } from "./workspace-model";
import styles from "./AssetMappingWorkspace.module.css";

export function HouseholdList({
  groups,
  search,
  selectedClient,
  railOpen,
  onSearch,
  onSelectClient,
  onToggleRail,
  footer,
}: {
  groups: RunGroups;
  search: string;
  selectedClient: string | null;
  railOpen: boolean;
  onSearch: (query: string) => void;
  onSelectClient: (name: string) => void;
  onToggleRail: () => void;
  footer?: React.ReactNode;
}) {
  if (!railOpen) {
    return (
      <div className={styles.railCollapsed}>
        <Button variant="ghost" size="sm" title={COPY.expandList} aria-label={COPY.expandList} onClick={onToggleRail}>
          »
        </Button>
      </div>
    );
  }
  const names = filterClientNames(Object.keys(groups), search);
  return (
    <aside className={styles.rail}>
      <div className={styles.railHead}>
        <span>Households</span>
        <Button variant="ghost" size="sm" title={COPY.collapseList} aria-label={COPY.collapseList} onClick={onToggleRail}>
          «
        </Button>
      </div>
      <input
        type="search"
        className={styles.search}
        placeholder={COPY.searchPlaceholder}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <ul className={styles.clients}>
        {names.map((name) => {
          const runs = groups[name];
          const status = runs[0]?.status ?? "neutral";
          return (
            <li key={name}>
              <button
                type="button"
                className={`${styles.client} ${selectedClient === name ? styles.clientActive : ""}`.trim()}
                aria-current={selectedClient === name ? "true" : undefined}
                onClick={() => onSelectClient(name)}
              >
                <span className={styles.clientName}>
                  <span
                    className={styles.statusDot}
                    data-tone={status}
                    role="img"
                    aria-label={HOUSEHOLD_STATUS_LABEL[status]}
                    title={HOUSEHOLD_STATUS_LABEL[status]}
                  />
                  <span>{name}</span>
                </span>
                {showRunCountBadge(runs) ? <span className={styles.count}>{runs.length}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {footer ? <div className={styles.railFoot}>{footer}</div> : null}
    </aside>
  );
}
