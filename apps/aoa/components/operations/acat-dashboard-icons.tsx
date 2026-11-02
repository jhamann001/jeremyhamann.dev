import type { ReactNode, SVGProps } from "react";

// Icon nodes copied from lucide-react v1.24.0 (ISC), the version the Transfer Tracker
// dashboard renders, so glyphs match without adding a runtime dependency.
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function icon(name: string, nodes: ReactNode) {
  function Icon({ size = 24, className, ...props }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className ? `lucide lucide-${name} ${className}` : `lucide lucide-${name}`}
        {...props}
      >
        {nodes}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const ChevronDown = icon("chevron-down", <path d="m6 9 6 6 6-6" />);
export const ArrowRight = icon("arrow-right", <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>);
export const ArrowDownLeft = icon("arrow-down-left", <><path d="M17 7 7 17" /><path d="M17 17H7V7" /></>);
export const ArrowUpRight = icon("arrow-up-right", <><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>);
export const CircleDollarSign = icon("circle-dollar-sign", <>
  <circle cx="12" cy="12" r="10" />
  <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
  <path d="M12 18V6" />
</>);
export const TriangleAlert = icon("triangle-alert", <>
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
  <path d="M12 9v4" />
  <path d="M12 17h.01" />
</>);
export const ChartColumn = icon("chart-column", <>
  <path d="M3 3v16a2 2 0 0 0 2 2h16" />
  <path d="M18 17V9" />
  <path d="M13 17V5" />
  <path d="M8 17v-3" />
</>);
export const CircleCheck = icon("circle-check", <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>);
export const Database = icon("database", <>
  <ellipse cx="12" cy="5" rx="9" ry="3" />
  <path d="M3 5V19A9 3 0 0 0 21 19V5" />
  <path d="M3 12A9 3 0 0 0 21 12" />
</>);
export const ShieldCheck = icon("shield-check", <>
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  <path d="m9 12 2 2 4-4" />
</>);
export const RefreshCw = icon("refresh-cw", <>
  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
  <path d="M21 3v5h-5" />
  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
  <path d="M8 16H3v5" />
</>);
