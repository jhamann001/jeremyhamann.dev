"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The md+ topbar's dropdown icon button (moved verbatim from topbar.tsx in the mobile-first pass). */
export function ThemeToggle(): React.JSX.Element {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Change theme">
              {/* CSS-driven so SSR and the first client paint agree without a mounted flag. */}
              <Sun aria-hidden className="dark:hidden" />
              <Moon aria-hidden className="hidden dark:block" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setTheme("light")}>
          <Sun aria-hidden /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme("dark")}>
          <Moon aria-hidden /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme("system")}>
          <Monitor aria-hidden /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ThemeValue = "light" | "dark" | "system";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeValue; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const subscribeNever = () => () => {};

/** true only after hydration — next-themes' `theme` is client-only, so it is never read during SSR. */
function useMounted(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

/**
 * Segmented Light / Dark / System control for the Account sheet (phones). role="radiogroup" with three
 * role="radio" Buttons, each ≥ 44px. Only ever rendered inside an opened sheet, never on first paint.
 */
export function ThemeSegmented({ className }: { className?: string }): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const current: ThemeValue | null = mounted ? ((theme as ThemeValue | undefined) ?? "system") : null;

  return (
    <div role="radiogroup" aria-label="Theme" className={cn("flex gap-1 rounded-lg border p-1", className)}>
      {THEME_OPTIONS.map((opt) => {
        const selected = current === opt.value;
        const Icon = opt.icon;
        return (
          <Button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            variant={selected ? "secondary" : "ghost"}
            className="min-h-11 flex-1"
            onClick={() => setTheme(opt.value)}
          >
            <Icon aria-hidden />
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
}
