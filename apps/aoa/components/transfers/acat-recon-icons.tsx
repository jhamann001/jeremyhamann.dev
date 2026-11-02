import type { ReactNode, SVGProps } from "react";

export { Database, RefreshCw, TriangleAlert } from "@/components/operations/acat-dashboard-icons";

// Icon nodes copied from lucide-react v1.24.0 (ISC), the version the ACAT
// tracker Security Recon slide-out renders, so glyphs match without adding a
// runtime dependency (same factory shape as acat-dashboard-icons.tsx).
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

export const Upload = icon("upload", <>
  <path d="M12 3v12" />
  <path d="m17 8-5-5-5 5" />
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
</>);
export const Download = icon("download", <>
  <path d="M12 15V3" />
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  <path d="m7 10 5 5 5-5" />
</>);
export const FileSpreadsheet = icon("file-spreadsheet", <>
  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M8 13h2" />
  <path d="M14 13h2" />
  <path d="M8 17h2" />
  <path d="M14 17h2" />
</>);
export const Trash2 = icon("trash-2", <>
  <path d="M10 11v6" />
  <path d="M14 11v6" />
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  <path d="M3 6h18" />
  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
</>);
export const Pencil = icon("pencil", <>
  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  <path d="m15 5 4 4" />
</>);
export const Check = icon("check", <path d="M20 6 9 17l-5-5" />);
export const X = icon("x", <>
  <path d="M18 6 6 18" />
  <path d="m6 6 12 12" />
</>);
export const Save = icon("save", <>
  <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
  <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
  <path d="M7 3v4a1 1 0 0 0 1 1h7" />
</>);
export const LoaderCircle = icon("loader-circle", <path d="M21 12a9 9 0 1 1-6.219-8.56" />);
export const CloudDownload = icon("cloud-download", <>
  <path d="M12 13v8l-4-4" />
  <path d="m12 21 4-4" />
  <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" />
</>);
export const ArrowRightLeft = icon("arrow-right-left", <>
  <path d="m16 3 4 4-4 4" />
  <path d="M20 7H4" />
  <path d="m8 21-4-4 4-4" />
  <path d="M4 17h16" />
</>);
export const TrendingUp = icon("trending-up", <>
  <path d="M16 7h6v6" />
  <path d="m22 7-8.5 8.5-5-5L2 17" />
</>);
export const TrendingDown = icon("trending-down", <>
  <path d="M16 17h6v-6" />
  <path d="m22 17-8.5-8.5-5 5L2 7" />
</>);
export const CircleQuestionMark = icon("circle-question-mark", <>
  <circle cx="12" cy="12" r="10" />
  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
  <path d="M12 17h.01" />
</>);
export const CircleAlert = icon("circle-alert", <>
  <circle cx="12" cy="12" r="10" />
  <line x1="12" x2="12" y1="8" y2="12" />
  <line x1="12" x2="12.01" y1="16" y2="16" />
</>);
export const CircleCheck = icon("circle-check", <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>);
