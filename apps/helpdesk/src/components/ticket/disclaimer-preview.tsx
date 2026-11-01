"use client";

import { useId } from "react";
import type { DisclaimerKey } from "@/types/domain";
import { DISCLAIMERS, PUBLIC_DISCLAIMER_KEYS } from "@/lib/disclaimers";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function isDisclaimerKey(v: string): v is DisclaimerKey {
  return (PUBLIC_DISCLAIMER_KEYS as readonly string[]).includes(v);
}

/**
 * Disclaimer picker for public replies: a Select over every key a
 * PUBLIC reply may carry (never NONE) plus the exact text that will be appended into the stored body.
 * The Select id comes from `useId()` — on phones the inline composer and the dock's composer sheet can
 * both be mounted, and a fixed id would duplicate.
 */
export function DisclaimerPreview({
  disclaimerKey,
  onChange,
}: {
  disclaimerKey: DisclaimerKey;
  onChange: (k: DisclaimerKey) => void;
}): React.JSX.Element {
  const selectId = useId();
  const text = disclaimerKey === "NONE" ? "" : DISCLAIMERS[disclaimerKey].text;

  return (
    <div className="flex flex-col gap-1.5" data-slot="disclaimer-preview">
      <Label htmlFor={selectId}>Disclaimer appended to this reply</Label>
      <Select
        value={disclaimerKey}
        onValueChange={(v) => {
          if (isDisclaimerKey(v)) onChange(v);
        }}
      >
        <SelectTrigger id={selectId} size="sm" className="w-full md:max-w-xs" aria-label="Disclaimer">
          <SelectValue placeholder="Select a disclaimer" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {PUBLIC_DISCLAIMER_KEYS.map((k) => (
            <SelectItem key={k} value={k}>
              {DISCLAIMERS[k].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <blockquote
        className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        data-disclaimer-key={disclaimerKey}
      >
        {text.length > 0 ? text : "Select a disclaimer — a public reply cannot be sent without one."}
      </blockquote>
    </div>
  );
}
