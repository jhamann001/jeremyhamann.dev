"use client";

import { Ban, Copy, Link2, ShieldAlert } from "lucide-react";
import type { TicketLinkKind } from "@/types/domain";

/**
 * One icon per link kind.
 *
 * Fix round 2: `linkKindLabel` used to live here and is now in `./link-kind-label.ts`. This module is
 * `"use client"`, so every export it carries is a CLIENT REFERENCE — calling one from the async server
 * component in `links-panel.tsx` threw at render and took the whole ticket page down. Only components
 * belong in here; a plain function a server component calls belongs in a module with no directive.
 *
 * The icon differs per kind on purpose: the panel is read at a glance and three rows that differ only
 * by a word are three rows nobody distinguishes. `BLOCKS` gets the alarm shape because it is the only
 * kind that says "you cannot finish this yet".
 */
const ICONS: Readonly<Record<TicketLinkKind, typeof Link2>> = {
  RELATED: Link2,
  DUPLICATE_OF: Copy,
  BLOCKS: Ban,
};

/** `Blocked by` is the one that changes what an operator does, so it carries the warning icon. */
const INBOUND_ICONS: Readonly<Record<TicketLinkKind, typeof Link2>> = {
  RELATED: Link2,
  DUPLICATE_OF: Copy,
  BLOCKS: ShieldAlert,
};

export function LinkKindIcon({
  kind,
  inbound,
  className,
}: {
  kind: TicketLinkKind;
  inbound: boolean;
  className?: string;
}): React.JSX.Element {
  const Icon = inbound ? INBOUND_ICONS[kind] : ICONS[kind];
  return <Icon aria-hidden className={className} />;
}

