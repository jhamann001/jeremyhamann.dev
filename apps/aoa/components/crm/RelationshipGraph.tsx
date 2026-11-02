"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { CrmExplorerLink } from "./CrmExplorerLink";
import styles from "./CrmPreview.module.css";

export type RelationshipGraphNode = {
  id: string;
  identityType: string;
  label: string;
  href: string | null;
  depth: number;
  root: boolean;
};

export type RelationshipGraphEdge = {
  id: string;
  relationshipType: string;
  parentId: string;
  childId: string;
};

export type RelationshipWorkspaceData = {
  rootIdentityId: string;
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
  totalNodeCount: number;
};

type PositionedNode = RelationshipGraphNode & {
  kind: "node";
  x: number;
  y: number;
};

type PositionedGroup = {
  kind: "group";
  id: string;
  identityType: string;
  label: string;
  count: number;
  x: number;
  y: number;
};

type PositionedItem = PositionedNode | PositionedGroup;
type UnpositionedItem =
  | Omit<PositionedNode, "x" | "y">
  | Omit<PositionedGroup, "x" | "y">;

const GROUP_THRESHOLD = 6;
const MAX_NODES_PER_ROW = 5;
const TYPE_ORDER = ["HOUSEHOLD", "CONTACT", "DEAL", "TRANSFER"];

const TYPE_LABELS: Record<string, string> = {
  HOUSEHOLD: "Household",
  CONTACT: "Person",
  DEAL: "Deal",
  TRANSFER: "Asset transfer",
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  HOUSEHOLD_HAS_MEMBER: "Household member",
  DEAL_FOR_HOUSEHOLD: "Household deal",
  TRANSFER_FOR_HOUSEHOLD: "Household transfer",
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.toLowerCase().replaceAll("_", " ");
}

function pluralTypeLabel(type: string, count: number): string {
  const label = typeLabel(type);
  if (count === 1) return label;
  if (label === "Person") return "People";
  return `${label}s`;
}

function typeRank(type: string): number {
  const rank = TYPE_ORDER.indexOf(type);
  return rank === -1 ? TYPE_ORDER.length : rank;
}

export function positionRelationshipItems(
  nodes: RelationshipGraphNode[],
  expandedTypes: ReadonlySet<string>,
): {
  items: PositionedItem[];
  collapsedTypes: Map<string, number>;
  rowCount: number;
  widestRow: number;
} {
  const nodesByType = new Map<string, RelationshipGraphNode[]>();
  for (const node of nodes) {
    nodesByType.set(node.identityType, [...(nodesByType.get(node.identityType) ?? []), node]);
  }

  const rows: UnpositionedItem[][] = [];
  const collapsedTypes = new Map<string, number>();
  const orderedTypes = [...nodesByType.keys()].sort(
    (a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b),
  );

  for (const identityType of orderedTypes) {
    const typeNodes = (nodesByType.get(identityType) ?? []).sort((a, b) => {
      if (a.root !== b.root) return a.root ? -1 : 1;
      return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
    });
    const rootNodes = typeNodes.filter((node) => node.root);
    const groupableNodes = typeNodes.filter((node) => !node.root);
    const shouldCollapse = groupableNodes.length >= GROUP_THRESHOLD && !expandedTypes.has(identityType);
    const rowItems: UnpositionedItem[] = rootNodes.map((node) => ({
      ...node,
      kind: "node" as const,
    }));

    if (shouldCollapse) {
      collapsedTypes.set(identityType, groupableNodes.length);
      rowItems.push({
        kind: "group",
        id: `group:${identityType}`,
        identityType,
        label: pluralTypeLabel(identityType, groupableNodes.length),
        count: groupableNodes.length,
      });
    } else {
      rowItems.push(...groupableNodes.map((node) => ({ ...node, kind: "node" as const })));
    }

    for (let start = 0; start < rowItems.length; start += MAX_NODES_PER_ROW) {
      rows.push(rowItems.slice(start, start + MAX_NODES_PER_ROW));
    }
  }

  const rowCount = Math.max(1, rows.length);
  const items = rows.flatMap((rowItems, rowIndex) => {
    const y = rowCount === 1 ? 50 : 10 + (rowIndex * 80) / (rowCount - 1);
    return rowItems.map((item, itemIndex) => ({
      ...item,
      x: ((itemIndex + 1) * 100) / (rowItems.length + 1),
      y,
    } as PositionedItem));
  });

  return {
    items,
    collapsedTypes,
    rowCount,
    widestRow: Math.max(1, ...rows.map((row) => row.length)),
  };
}

export function RelationshipWorkspaceView({
  data,
  compact = false,
}: {
  data: RelationshipWorkspaceData;
  compact?: boolean;
}) {
  return (
    <section className={compact ? styles.compact : undefined}>
      <div className={styles.liveNotice}>
        <div>
          <strong>Live CRM relationships</strong>
          <p>Exact, active parent and child links from the CRM registry. These links do not grant access or modify CRM.</p>
        </div>
        <Pill tone="green" dot>Current</Pill>
      </div>
      <RelationshipGraph
        compact={compact}
        rootIdentityId={data.rootIdentityId}
        nodes={data.nodes}
        edges={data.edges}
        totalNodeCount={data.totalNodeCount}
      />
    </section>
  );
}

export function RelationshipGraph({
  rootIdentityId,
  nodes,
  edges,
  totalNodeCount,
  compact = false,
}: {
  rootIdentityId: string;
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
  totalNodeCount: number;
  compact?: boolean;
}) {
  const [selectedId, setSelectedId] = useState(rootIdentityId);
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(() => new Set());
  const [mapExpanded, setMapExpanded] = useState(false);
  const layout = useMemo(
    () => positionRelationshipItems(nodes, expandedTypes),
    [nodes, expandedTypes],
  );
  const positionedNodes = useMemo(
    () => layout.items.filter((item): item is PositionedNode => item.kind === "node"),
    [layout.items],
  );
  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const positionById = useMemo(
    () => new Map(layout.items.map((item) => [item.id, item])),
    [layout.items],
  );
  const selected = nodeById.get(selectedId) ?? nodes[0];
  const connected = edges.filter(
    (edge) => edge.parentId === selected?.id || edge.childId === selected?.id,
  );
  const canvasWidth = Math.max(760, layout.widestRow * 190 + 80);
  const canvasHeight = Math.max(compact ? 440 : 520, layout.rowCount * 120 + 80);
  const collapsibleTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.root) counts.set(node.identityType, (counts.get(node.identityType) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= GROUP_THRESHOLD)
      .sort(([a], [b]) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  }, [nodes]);
  const collapsedNodeToGroup = useMemo(() => {
    const result = new Map<string, string>();
    for (const node of nodes) {
      if (!node.root && layout.collapsedTypes.has(node.identityType)) {
        result.set(node.id, `group:${node.identityType}`);
      }
    }
    return result;
  }, [layout.collapsedTypes, nodes]);
  const visibleEdges = useMemo(() => {
    const seen = new Set<string>();
    return edges.flatMap((edge) => {
      const parentId = collapsedNodeToGroup.get(edge.parentId) ?? edge.parentId;
      const childId = collapsedNodeToGroup.get(edge.childId) ?? edge.childId;
      const coordinate = `${parentId}:${childId}`;
      if (parentId === childId || seen.has(coordinate)) return [];
      seen.add(coordinate);
      return [{ ...edge, parentId, childId }];
    });
  }, [collapsedNodeToGroup, edges]);

  function toggleType(identityType: string) {
    setExpandedTypes((current) => {
      const next = new Set(current);
      if (next.has(identityType)) next.delete(identityType);
      else next.add(identityType);
      return next;
    });
  }

  useEffect(() => {
    const selectedIsVisible = positionedNodes.some((node) => node.id === selectedId);
    if (!selectedIsVisible) setSelectedId(rootIdentityId);
  }, [positionedNodes, rootIdentityId, selectedId]);

  useEffect(() => {
    if (!mapExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMapExpanded(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mapExpanded]);

  return (
    <div
      className={`${styles.relationshipLayout} ${mapExpanded ? styles.relationshipLayoutExpanded : ""}`.trim()}
      role="region"
      aria-label={mapExpanded ? "Expanded CRM relationship map" : "CRM relationship map"}
    >
      <Card className={styles.graphCard}>
        <CardHeader className={styles.cardTitle}>
          <div>
            <h2>Parent and child map</h2>
            <p>Select any node to inspect its confirmed relationships.</p>
          </div>
          <div className={styles.mapActions}>
            <Pill tone="green">{edges.length} links</Pill>
            <button
              type="button"
              className={styles.mapAction}
              aria-expanded={mapExpanded}
              onClick={() => setMapExpanded((current) => !current)}
            >
              {mapExpanded ? "Close expanded view" : "Expand map"}
            </button>
          </div>
        </CardHeader>
        <CardBody className={styles.graphBody}>
          {collapsibleTypes.length > 0 ? (
            <div className={styles.groupControls} aria-label="Relationship record groups">
              <span>Record groups</span>
              {collapsibleTypes.map(([identityType, count]) => {
                const expanded = expandedTypes.has(identityType);
                return (
                  <button
                    type="button"
                    key={identityType}
                    aria-expanded={expanded}
                    onClick={() => toggleType(identityType)}
                  >
                    {expanded ? "Collapse" : "Expand"} {count} {pluralTypeLabel(identityType, count).toLowerCase()}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className={styles.graphScroller}>
            <div
              className={`${styles.graph} ${compact ? styles.graphCompact : ""}`.trim()}
              style={{ width: `max(100%, ${canvasWidth}px)`, minHeight: canvasHeight }}
              role="group"
              aria-label="Live CRM parent and child relationship map"
            >
            <svg className={styles.edges} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="relationship-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L6,3 z" className={styles.edgeArrow} />
                </marker>
              </defs>
              {visibleEdges.map((edge) => {
                const parent = positionById.get(edge.parentId);
                const child = positionById.get(edge.childId);
                if (!parent || !child) return null;
                const active = edge.parentId === selected?.id || edge.childId === selected?.id;
                return (
                  <line
                    key={edge.id}
                    x1={parent.x}
                    y1={parent.y}
                    x2={child.x}
                    y2={child.y}
                    markerEnd="url(#relationship-arrow)"
                    className={active ? styles.edgeActive : styles.edge}
                  />
                );
              })}
            </svg>
            {layout.items.map((item) => item.kind === "group" ? (
              <button
                key={item.id}
                type="button"
                data-type={item.identityType.toLowerCase()}
                className={`${styles.node} ${styles.groupNode}`}
                style={{ left: `${item.x}%`, top: `${item.y}%` }}
                aria-expanded="false"
                onClick={() => toggleType(item.identityType)}
              >
                <strong>{item.count} {item.label.toLowerCase()}</strong>
                <span>Select to expand</span>
              </button>
            ) : (
              <button
                key={item.id}
                type="button"
                data-type={item.identityType.toLowerCase()}
                className={`${styles.node} ${item.id === selected?.id ? styles.nodeSelected : ""}`.trim()}
                style={{ left: `${item.x}%`, top: `${item.y}%` }}
                aria-pressed={item.id === selected?.id}
                onClick={() => setSelectedId(item.id)}
              >
                <strong title={item.label}>{item.label}</strong>
                <span>{typeLabel(item.identityType)}{item.root ? " · Starting record" : ""}</span>
              </button>
            ))}
            </div>
          </div>
          {totalNodeCount > nodes.length ? (
            <p className={styles.truncated}>Showing {nodes.length} of {totalNodeCount} connected CRM records. Open the CRM record for the complete direct-connection list.</p>
          ) : null}
        </CardBody>
      </Card>

      <aside className={styles.details} aria-live="polite">
        {selected ? (
          <Card>
            <CardHeader><h2>Selected record</h2></CardHeader>
            <CardBody>
              <dl className={styles.detailList}>
                <div><dt>Name</dt><dd>{selected.label}</dd></div>
                <div><dt>Type</dt><dd>{typeLabel(selected.identityType)}</dd></div>
                <div><dt>CRM ID</dt><dd><code>{selected.id}</code></dd></div>
              </dl>
              <div className={styles.nodeLinks}>
                <CrmExplorerLink href={`/crm/${encodeURIComponent(selected.id)}`}>Open in CRM Explorer →</CrmExplorerLink>
                {selected.href ? <CrmExplorerLink href={selected.href}>Open AOA record →</CrmExplorerLink> : null}
              </div>
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader><h2>Connected records</h2></CardHeader>
          <CardBody>
            <ul className={styles.relationshipList}>
              {connected.map((edge) => {
                const selectedIsParent = edge.parentId === selected?.id;
                const other = nodeById.get(selectedIsParent ? edge.childId : edge.parentId);
                return (
                  <li key={edge.id}>
                    <small>{RELATIONSHIP_LABELS[edge.relationshipType] ?? edge.relationshipType.replaceAll("_", " ")}</small>
                    <strong>{other?.label ?? "CRM record"}</strong>
                    <span className={styles.nodeRole}>{selectedIsParent ? "Child node" : "Parent node"}</span>
                  </li>
                );
              })}
              {connected.length === 0 ? <li>No connected records.</li> : null}
            </ul>
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}
