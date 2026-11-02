"use client";

import { Button } from "@/components/ui";

// Client-only trigger for the browser's Print → Save-as-PDF (the @media print
// stylesheet in report.module.css yields the identical approved look). No PDF
// library — the browser does the rendering, same as the standalone generator's
// Chrome --print-to-pdf path.
export function PrintButton() {
  return (
    <Button size="sm" variant="ghost" onClick={() => window.print()}>
      Print / Download PDF
    </Button>
  );
}
