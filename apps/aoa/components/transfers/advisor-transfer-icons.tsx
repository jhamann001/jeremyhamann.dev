import type { ReactNode, SVGProps } from "react";

// Icon nodes copied from lucide-react v1.24.0 (ISC), the version the Transfer Tracker
// advisor page renders, so glyphs match without adding a runtime dependency.
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
export const ChevronRight = icon("chevron-right", <path d="m9 18 6-6-6-6" />);
export const Search = icon("search", <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>);
export const LoaderCircle = icon("loader-circle", <path d="M21 12a9 9 0 1 1-6.219-8.56" />);
export const RefreshCw = icon("refresh-cw", <>
  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
  <path d="M21 3v5h-5" />
  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
  <path d="M8 16H3v5" />
</>);
