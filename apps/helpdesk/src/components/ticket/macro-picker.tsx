"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { QUEUE_LABELS, type CommentVisibility, type DisclaimerKey, type MacroDTO, type MacroVars } from "@/types/domain";
import { renderMacroTemplate } from "@/lib/macro-template";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ResponsivePopover } from "@/components/shell/responsive-sheet";

/**
 * Macro insertion: a Command
 * list over the macros on the requested channel, inside a Popover from `md` and a bottom sheet on phones
 * (`ResponsivePopover` — the same Command tree in both modes). Rendering is client-side pure templating;
 * the `macroId` rides along with the comment so MACRO_APPLIED is audited at write time.
 */
export function MacroPicker({
  macros,
  channel,
  vars,
  onInsert,
  disabled,
}: {
  macros: MacroDTO[];
  channel: CommentVisibility;
  vars: MacroVars;
  onInsert: (r: { body: string; disclaimerKey: DisclaimerKey; macroId: string }) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => macros.filter((m) => m.channel === channel), [macros, channel]);
  const heading = channel === "INTERNAL" ? "Internal note macros" : "Public reply macros";

  function pick(id: string): void {
    const m = options.find((o) => o.id === id);
    setOpen(false);
    if (!m) return;
    onInsert({ body: renderMacroTemplate(m.body, vars), disclaimerKey: m.disclaimerKey, macroId: m.id });
  }

  return (
    <ResponsivePopover
      open={open}
      onOpenChange={setOpen}
      title={heading}
      align="start"
      className="w-80 p-0"
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || options.length === 0}
          aria-label={`Insert ${channel === "INTERNAL" ? "internal" : "public"} macro`}
          data-channel={channel}
        >
          <Sparkles aria-hidden />
          {options.length === 0 ? "No macros" : "Insert macro"}
        </Button>
      }
    >
      <Command>
        <CommandInput placeholder="Search macros…" />
        {/* Phone: the list scrolls inside the 90svh sheet (header + input ≈ 8rem); md+: shadcn's max-h-72. */}
        <CommandList className="max-md:max-h-[min(24rem,calc(90svh-8rem))]">
          <CommandEmpty>No macro matches.</CommandEmpty>
          <CommandGroup heading={heading}>
            {options.map((m) => (
              <CommandItem key={m.id} value={m.id} keywords={[m.title, m.key]} onSelect={pick}>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{m.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {m.queueKey ? QUEUE_LABELS[m.queueKey] : "All queues"} · {m.key}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </ResponsivePopover>
  );
}
