import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  width: 18,
  height: 18,
  "aria-hidden": true,
};

export function IconCommandCenter(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
export function IconHouseholds(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}
export function IconClientPortrait(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" />
    </svg>
  );
}
export function IconAssetTransfer(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
export function IconAcat(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <path d="M3.3 7L12 12l8.7-5M12 22V12" />
    </svg>
  );
}
export function IconAssetMapping(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}
export function IconTradeRequests(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M3 3v18h18" />
      <path d="M18 9l-5 5-3-3-4 4" />
      <path d="M14 9h4v4" />
    </svg>
  );
}
export function IconDeals(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  );
}
export function IconDecisionCenter(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
export function IconTasks(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  );
}
export function IconSmartNudges(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
    </svg>
  );
}
export function IconAuditLog(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M12 8v4l3 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
// The demo's Outbox: a tray with an arrow leaving it.
export function IconOutbox(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M4 13h4l1.5 2h5L16 13h4" />
      <path d="M12 3v8M8.5 6.5 12 3l3.5 3.5" />
    </svg>
  );
}
export function IconRelationships(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.3 7.2l2.5 7.5M15.7 7.2l-2.5 7.5M8.5 6h7" />
    </svg>
  );
}
export function IconReporting(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 16v-5M13 16V8M18 16V5" />
    </svg>
  );
}
export function IconSearch(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
export function IconBell(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 01-3.4 0" />
    </svg>
  );
}
