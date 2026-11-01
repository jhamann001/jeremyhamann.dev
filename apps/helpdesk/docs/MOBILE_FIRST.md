# WM Help Desk — Mobile-First Contract

**Status:** binding design for the mobile-first pass (S4 shell/primitives, S5 dashboard + new ticket, S6 ticket detail, S7 audit). Companion to `docs/ARCHITECTURE.md`; where the two disagree on layout, this file wins; on behaviour, invariants and RBAC, ARCHITECTURE wins.
**Written:** 2026-09-17 by the Principal Architect after reading §g S4–S7, every file under `src/app/(app)/**`, `src/components/{app-sidebar,topbar,providers}.tsx`, `src/components/{tickets,dashboard,ticket,audit}/*`, `src/app/sign-in/page.tsx`, `src/app/no-access/page.tsx`, `src/app/globals.css` and every installed shadcn source in `src/components/ui/*.tsx`. Signatures below are against the real props as of that read; the concurrent fix pack wins any signature it changes — rebase before branching.
**Inputs judged:** Proposal A ("Operator UX first") scored **84/100**; Proposal B ("Engineering, minimal-diff first") scored **78/100**. A is the spine; B's mechanisms are grafted where they are simpler or more correct (see §8 and the Appendix).

**Wave A amendment (2026-09-19, extended in fix round 2).** The LegacyDesk-parity wave added surfaces this file predates. The deltas below are folded into the text and each is marked **(Wave A)** where it appears, so the §7 checklist and the shipped code describe the same product. Round 1 folded in three: (1) the ticket dock is **five** items — `← Queue · Details · Actions · Note · Reply` (§2 route rule, §4.5); (2) `navItemsFor` returns an **`admin`** array that the sidebar renders as its own section and the phone shows inside the **Account sheet** rather than as a sixth bottom tab (§2, §3.2, §7); (3) the `data-tap="none"` allowlist is unchanged at one entry, and §7 now states the rule — a bare `<Link>` under 44 px is fixed with `min-h-11`, never with an opt-out.

Fix round 2 folded in four more, found by re-reading the shipped tree against this file: (4) **the composer never says "sent"** — `Save reply to ticket` / `Save reply and set Pending client`, confirm `Save reply`, toast "Reply saved to the ticket" (§4.5, §7; CONTRACT §10 S3, CROSSWALK P16), so the old "Send to client" / "Reply sent to client" lines were failing correct code; (5) §4.5's binding render block gains the two **streamed panels** — `AttachmentsPanel` in the main column and `RequesterHistory` (`inline` in the aside, `sheet` in a phone-only block above the dock) — plus the header's `requesterEmailChangedAt` prop and the aside's `flex-col` stacking (§2 inventory too); (6) §4.3's dashboard header carries `ExportTicketsButton` at every width, with the phone consequence and its bound stated; (7) §7's Actions assertion matches `TicketMoveQueueControl`, which degrades to a read-only `QueueBadge` plus a visible reason, not to a disabled Select. Everything else in this file stands as written on 2026-09-17.

**`docs/ARCHITECTURE.md` §g S6 still carries the pre-Wave-A `Composer` paragraph** (old signature, "Send to client", no `addPublicReplyAndSetPending`). That file is shared and is not amended here; the exact replacement text is filed in the build record. Until it lands, **this file wins on the composer's copy and props** — which is what §1's precedence rule already says for layout, and what §7 is run against.

---

## (1) Principles and hard rules

Binding on every slice. Violations fail review regardless of how the screen looks.

- **R1 — Phone is the base.** Base Tailwind classes target 360 px. Enhancement goes upward with `sm:` / `md:` / `lg:`. **Exactly one layout flip: `md` (768 px).** Below `md` = phone layout; `md` and up = the existing desktop layout (sidebar, TanStack tables, side sheets, popovers). `sm:` (640) may only change density (grid columns, button rows, dialog width) — never navigation, list presentation or sheet side. 768×1024 therefore exercises the **desktop** layout.
- **R2 — No horizontal page scroll** at 360, 390, 430, 768, 1280. `document.documentElement.scrollWidth <= window.innerWidth` and the same for `body` on every screen, with every sheet open and closed. The only horizontal scrollers are element-level and marked: `[data-snap-row]` (counter carousel, active-filter chip row), shadcn's `[data-slot=table-container]` (md+ tables), `[data-slot=markdown] pre|table`. **Never** put `overflow-x: hidden|clip` on `html`, `body`, the `(app)` root or `main` — it would hide regressions from the probe (D8).
- **R3 — Touch targets ≥ 44×44 px on phones.** Enforced once, globally, by the unlayered phone rule in §6 on shadcn `data-slot` controls, plus explicit `min-h-11` (and `min-w-11` where the label can be narrower than 44 px) on elements without a `data-slot` — bare `<Link>`s, label rows, bottom-nav tabs. Opt-out is `data-tap="none"`, permitted **only** for inline prose links, and every opt-out is listed in §7's allowlist.
- **R4 — Text controls ≥ 16 px on phones** (iOS focus-zoom guard), enforced by the global rule on `input|textarea|select`. Density (`md:text-sm`) returns at `md`.
- **R5 — Safe areas.** `viewportFit: "cover"` is exported from the root layout (without it every `env(safe-area-inset-*)` is 0 on iOS). Every bottom-fixed bar and every bottom-sheet footer pads by `env(safe-area-inset-bottom)`; the topbar pads by `env(safe-area-inset-top)`; phone gutters use `max(1rem, env(safe-area-inset-left|right))`.
- **R6 — CSS decides breakpoints.** There is exactly **one** hook, `useMediaQuery` (`src/hooks/use-media-query.ts`, S4), `useSyncExternalStore`-based with an SSR default of **false (phone)**. Its permitted consumers are `ResponsiveSheet` and `ResponsivePopover` (a Radix `side` and a Popover→Sheet swap are props, not CSS). Any other import of `useMediaQuery` fails review. Nothing else reads `window.innerWidth`/`matchMedia`.
- **R7 — Same data, same state.** Phone card lists and desktop tables render the **same DTO arrays** (`TicketListPage.rows`; `flattenRows(chunks)` of `AuditRow`) inside the **same component** and write the **same URL** through the **same serializers** (`ticketQueryHref`/`ticketQueryToParams`, `auditQueryToParams`). No new fetch, no new query key, no second pagination writer.
- **R8 — Behaviour invariants are untouched** (layout containers change, nothing else): every `/tickets/…` `<Link>` is `prefetch={false}` (G6 — this includes `BottomNav`'s New tab and every card "Open" link); one preview open = one `TICKET_PREVIEWED` (`PreviewBody` mounts only while open, `gcTime: 0`); one detail render = one `TICKET_VIEWED`, one mutation = one `router.refresh()` (G12); RBAC gates unchanged (nav is convenience, pages re-check); `INTERNAL_NOTE_CLASSES` stays the only amber left edge in the app; `PiiIndicator` always gets the real count; public reply = non-NONE disclaimer + acknowledgement + `AlertDialog`; audit filters commit explicitly on Apply.
- **R9 — No new dependencies.** Only the installed shadcn components (alert-dialog alert avatar badge button card checkbox command dialog dropdown-menu input-group input label popover progress scroll-area select separator sheet skeleton sonner switch table tabs textarea tooltip). `src/components/ui/*` is never edited.
- **R10 — Accessibility.** Visible focus (`focus-visible:ring-2 focus-visible:ring-ring/50`) on every custom interactive element; `aria-label` on every icon-only control; every Sheet/Dialog has a title (`sr-only` allowed); `prefers-reduced-motion` respected globally (§6); nothing that matters is tooltip-only on phones — the Account sheet prints the dual-role sentence, the Details sheet prints the SLA facts, badges carry their value as text. A `title` attribute is **not** a visible explanation — it is the tooltip this rule forbids — so a disabled dock item carries its reason as an `sr-only` node it points at with `aria-describedby`, and the reason is *seen* in the sheet that item leads to (the composer prints the disabled channel's reason under its `TabsList`). A bar cannot paint it: it is `position: fixed` at exactly one `--wm-bottom-bar-h`, which is all `<main>` reserves.
- **R11 — Ownership.** Every file belongs to exactly one slice (§5). Other slices **import** only. A slice that needs a prop a primitive lacks stubs locally and files the delta for S4 — it never edits `src/components/shell/*` or `src/components/tickets/*`. Rebase onto the fix pack before branching.
- **R12 — Status language.** Never "done". Report the furthest evidenced stage: code complete → typecheck/lint/test green → build green → QA at the five widths (§7) → merged.

---

## (2) Navigation model

### Phone (< 768 px)

**Bottom tab bar** — `BottomNav` (S4), `position: fixed; bottom: 0`, `md:hidden`, height `var(--wm-bottom-bar-h)` (56 px) + `env(safe-area-inset-bottom)`. Tabs come from the pure `navItemsFor(viewer)` helper the sidebar also uses, so the two navigations can never disagree:

| Tab | Shown when | Behaviour |
|---|---|---|
| Dashboard | always | `<Link href="/dashboard" prefetch={false}>`; active when `pathname === "/dashboard"` |
| Queues | `readableQueues(groups).length > 0` | 1 queue → direct `<Link href="/queues/<slug>">`; ≥ 2 → button opening `QueuesSheet` (bottom sheet, one 48 px `<Link>` per queue with `QueueBadge`, `aria-current="page"` on the current one, closes on navigation). Active when `pathname.startsWith("/queues")` |
| New | `creatableQueues(groups).length > 0` | `<Link href="/tickets/new" prefetch={false}>` — `Plus` in a filled primary circle (center emphasis) |
| Audit | `canViewAudit(groups)` | `<Link href="/compliance/audit" prefetch={false}>` |
| Account | always | button opening `AccountSheet` |

Max 5 tabs (only a real Okta user holding compliance **and** an operational group reaches 5). Every tab `<Link>` carries `prefetch={false}`. Icons: `LayoutDashboard`, `Inbox`, `Plus`, `ScrollText`, `CircleUser` (lucide, all present in 1.46.0).

**(Wave B) The tab bar is UNCHANGED, and the persona × tab matrix below still holds** (Decision #108). Wave B adds two app-wide surfaces that could each have argued for a tab, and neither gets one:

- **Inbox** is a **topbar action on phones** — a `Bell` beside the brand mark, `md:hidden`, with an unread **dot** rather than a number (20 px of chrome cannot carry "17" legibly) and the count in its `aria-label` ("Inbox, 17 unread"). It is a sidebar entry with a real count `Badge` at md+. A sixth tab was the obvious move and was rejected on merit: five is the hard ceiling (R3 — a sixth tab at 360 px is 60 px, which cannot carry a 44 px target and a label), and the only persona a sixth would have evicted something from is the dual-role compliance officer, whose evicted tab would have been **Audit**. Taking the ledger off the thumb rail of the person whose job is the ledger, to make room for their own notifications, is the wrong trade.
- **Reports** and **Reply reviews** go in the Account sheet's overflow (`navOverflowFor`), above the Admin block: reports are a sit-down activity on a large screen, and the review queue is a supervisor's errand. Both are ordinary sidebar entries at md+. The portfolio demo adds a third, **Outbox**, in demo mode only (`NEXT_PUBLIC_DEMO_MODE=on`).

**(Wave A) Admin is not a sixth tab.** `navItemsFor` gained `admin: AdminNavItem[]` (§3.2). Five is the hard ceiling for a phone tab bar and the supervisor persona already reaches five, so `bottomTabsFor(items)` ignores `admin` and `adminOverflowFor(items)` puts the same entries in the **Account sheet**, where the other settings-shaped controls already live. One derivation, two surfaces — the sidebar's Admin section and the Account sheet's Admin block render the identical array, so they can no more disagree than the queue lists can.

**Route rule (binding):** `BottomNav` returns `null` when `/^\/tickets\//.test(pathname)` (the pure predicate is `hidesBottomNav(pathname)` in `nav-items.ts`). The ticket detail and new-ticket screens own the bottom edge with a `StickyActionBar` instead (detail: **← Queue · Details · Actions · Note · Reply** — **(Wave A)** five items, see §4.5; new ticket: **Cancel · Create ticket**). Two stacked bars would take 112 px + safe area — 18 % of a 360×800 screen — and a tab bar under a form invites a "New" tap while already on New. Both bars share `--wm-bottom-bar-h`, so `<main>` reserves one bar height on every phone route (`pb-bar-safe md:pb-5`).

**Compact topbar** — `Topbar` (S4), still `sticky top-0 z-40`, now `pt-safe`. Env banner stays (it is a safety cue) but shows `shortText` at `h-5 text-[10px]` on phones (`md:h-6 md:text-[11px]` with the long text). Row is `h-11 md:h-12`: brand mark "WM · Help Desk" (`<Link href="/dashboard">`, `md:hidden` — the sidebar brand is gone on phones) · **Dual role** chip (`data-dual-role`) · **DEV LOGIN** chip (`data-dev-login`). Group chips, avatar, theme toggle and sign-out become `hidden md:flex` (they live in the Account sheet on phones). The hamburger button and the left navigation `Sheet` are **removed**. **(fix round 2)** That `hidden md:flex` cluster also carries a **Settings** button (`variant="ghost" size="icon-sm" aria-label="Settings"`, `Settings` icon) opening a `Popover` that renders `NotificationSettingsControls` — the SAME component the Account sheet renders — and, from it, `NotificationPrefsSheet`. Until then notification preferences, out of office and the push opt-in existed only inside the phone-only Account sheet, so nobody on a laptop could set them at all.

**Account sheet** — identity (avatar, name, email), group chips (`GROUP_LABELS`, `data-group`; dashed "No groups" when empty), Dual role chip + the sentence "Compliance plus an operational group. Every audit row you write is flagged." as visible text, DEV LOGIN chip, **(Wave A)** the **Admin** block, Theme segmented control (Light / Dark / System), Sign out (`signOutAction`), footer "Every ticket view and change is recorded., **(Wave B)** the **More** overflow (Reports, Reply reviews) and the **Notifications** block — a `Notification settings` button opening `NotificationPrefsSheet` (per-kind/per-channel preferences, `outOfOfficeUntil` and `backupUserId`) plus `PushSubscribe`, both from `NotificationSettingsControls`, which the md+ topbar Settings popover renders too. **(fix round 2)** That block was in this sheet and nowhere else, and this sheet is `md:hidden`: the inventory did not list it and nothing said that out of office — the pair of columns B4's handover job reads — was unreachable above 768 px.

**(Wave A) Admin block in the Account sheet** — rendered only when `adminOverflowFor(navItemsFor(viewer)).length > 0`; an empty array means the whole block is absent, not an empty heading. An uppercase `Admin` label over one `<Button asChild variant="outline" className="min-h-11 w-full justify-start">` per entry, each wrapping a `<Link prefetch={false}>` that closes the sheet on tap: **Macros** (`MessageSquareQuote`, `/admin/macros`, `canAdminMacros` = `ops_team || compliance_officers`), **Users** (`Users`, `/admin/users`, `canAdminUsers` = `ops_team`) and **(round-2 integration)** **Held mail** (`/admin/intake`, `canReviewHeldIntake` = `ops_team || compliance_officers`, capability `intake:review`). A `Separator` above it, the Theme block below. Three entries WAS the ceiling; **(Wave B)** it is eight, and it still fits, because the block is a vertical list inside a sheet rather than a tab bar. The five Wave B entries, each gated by its own capability (Decision #102): **SLA policy** (`Timer`, `/admin/sla`, `sla:admin` = `ops_team`), **Webhooks** (`Webhook`, `/admin/webhooks`, `webhooks:admin` = `ops_team`), **API tokens** (`KeyRound`, `/admin/api-tokens`, `tokens:admin` = `ops_team`), **Suppression** (`MailX`, `/admin/suppression`, `suppression:admin` = `ops_team`) and **Capabilities** (`Flag`, `/admin/flags`, `flags:read` = `ops_team || compliance_officers`). Compliance therefore gains exactly one of the five — the read-only capability view — and none of the four that mint, revoke or stop anything. **(fix round 2)** An entry may carry a trailing count `Badge` (`variant="secondary" className="ml-auto min-w-5 px-1.5 tabular-nums"` + an `<span className="sr-only"> waiting</span>`, so the accessible name reads "Held mail 11 waiting" and not a bare number). Today only **Held mail** does: the `(app)` layout reads `heldIntakeCounts(viewer).total` — the `NEW` backlog, the same number the page's default view shows — for viewers holding `intake:review`, and hands it to the sidebar's Admin section and this block alike. **No badge at zero**, and none when the read fails: a `0` chip reads as "reviewed", and an absent count is also what the fail-soft path produces, so "no badge" means "nothing waiting, or we could not tell".

**Sidebar** — unchanged markup, `hidden md:flex`; its item derivation is replaced by `navItemsFor`. **(Wave A)** it renders an **Admin** section (same `SectionLabel` + `NavLink` recipe as Compliance) from `items.admin`, below the Compliance section and above the "Every ticket view and change is recorded." footer; absent entirely when `items.admin` is empty.

### Tablet / desktop (≥ 768 px)

Unchanged: sticky `AppSidebar`, full topbar, TanStack tables, right-hand sheets (560 px preview), popovers, inline composer + properties panel (two columns from `lg`). `BottomNav` and every `StickyActionBar` are `md:hidden`.

### Screen inventory — what is primary on a phone

| Screen | Primary (above the fold at 360×800, one thumb) | Secondary (one tap away) |
|---|---|---|
| Sign-in | Okta CTA (sticky bottom when Okta is configured), error alert | Dev personas (stacked rows) |
| No-access | Message, "Go to dashboard" / "Sign out" (2-col, 44 px) | — |
| Dashboard / Queue page | Search box, **Filters (n)**, counter carousel (1.15 cards visible), first 2–3 ticket cards with the SLA badge top-right | Filter sheet, active-filter chips, per-card Assign / Open, preview sheet |
| Ticket preview | Bottom sheet 90 svh: badges + SLA, subject, requester grid, assignee control, description, last 5 comments, full-width **Open ticket** | — |
| Ticket detail | Header (SLA badge first), description, timeline, **(Wave A)** attachments panel (streamed, own skeleton); dock **← Queue · Details · Actions · Note · Reply** **(Wave A)** | Details sheet (properties + SLA), **(Wave A)** Actions sheet (Assign to me · Record client contact · Move to queue), Composer sheet (internal / public), macro sheet, **(Wave A)** Edit-fields sheet (header pencil), **(Wave A)** Requester-history sheet (phone-only trigger above the dock; the same panel is inline in the md+ properties column) |
| New ticket | Single-column form; sticky **Cancel · Create ticket** | — |
| Audit log | **Filters (n)** + chips, Verify chain / Export CSV (2-col), audit cards | Filter sheet, row dialog, Load more |

### Persona × tab matrix (dev personas as seeded in `src/lib/dev-login.ts`)

| Persona | Groups | Tabs |
|---|---|---|
| ops | ops_team | Dashboard · Queues (3) · New · Account |
| advisor | advisors | Dashboard · Queues (3) · New · Account |
| cs | client_services | Dashboard · Queues (2) · New · Account |
| compliance | compliance_officers | Dashboard · Queues (3) · **Audit** · Account |
| supervisor | ops_team + client_services + advisors | Dashboard · Queues (3) · New · Account — **not dual-role, no Audit** |

No seeded persona is dual-role (`isDualRole` needs compliance_officers **plus** an operational group), so the Dual role chip and the 5-tab bar cannot be verified with seed data alone (§7).

**(Wave A) Persona × Admin entries** (Account sheet on phones, sidebar Admin section at md+ — the same array both places):

| Persona | Groups | Admin entries |
|---|---|---|
| ops | ops_team | Macros · Users · Held mail |
| advisor | advisors | *(no Admin block)* |
| cs | client_services | *(no Admin block)* |
| compliance | compliance_officers | Macros · Held mail |
| supervisor | ops_team + client_services + advisors | Macros · Users · Held mail |

Admin never changes the tab count: ops, advisor, cs and supervisor stay at four tabs, compliance at four.

---

## (3) Shared primitives — S4-owned

All new files live in `src/components/shell/` (plus the hook in `src/hooks/`). Import layers per ARCHITECTURE convention 2: L0/L1 (`@/types/domain`, `@/lib/rbac`, `@/lib/format`, `@/lib/utils`), `@/components/ui/*`, `@/components/tickets/*`, `next/*`, `lucide-react`, `radix-ui` (already a dependency — `Slot` is what `Button` uses), and `@/app/sign-in/sign-in.actions` (AccountSheet only). G1-clean by construction. Return types are `React.JSX.Element` (or `| null` where stated).

### 3.1 `src/hooks/use-media-query.ts` (`"use client"`)

```ts
/** Tailwind `md`. Keep equal to the `md:` utilities the shell uses (48rem = 768px at 16px root). */
export const MD_UP = "(min-width: 48rem)";

/**
 * SSR-safe matchMedia. `ssrDefault` (default false = phone) is what the server and the hydrating
 * render return; the real value takes over right after hydration. useSyncExternalStore: subscribe
 * adds/removes a "change" listener on window.matchMedia(query). PERMITTED CONSUMERS: ResponsiveSheet,
 * ResponsivePopover. Everything else is CSS (R6).
 */
export function useMediaQuery(query: string, ssrDefault?: boolean): boolean;
```

### 3.2 `src/components/shell/nav-items.ts` (pure; imports `@/types/domain`, `@/lib/rbac`)

```ts
export type AdminNavItem = { key: "macros" | "users" | "intake"; href: string; label: string; count?: number };   // (Wave A); `count` added fix round 2
export type NavCounts = { heldIntake?: number };                 // server-supplied; the (app) layout does the read (G1 forbids @/server/* here)
export type NavItems = {
  queues: Array<{ key: QueueKey; href: string; label: string }>; // readableQueues → `/queues/${queueSlug(k)}`, QUEUE_LABELS[k]
  canCreate: boolean;                                            // creatableQueues(groups).length > 0
  showAudit: boolean;                                            // canViewAudit(groups)
  admin: AdminNavItem[];                                         // (Wave A) canAdminMacros → Macros; canAdminUsers → Users; canReviewHeldIntake → Held mail; [] = no Admin section
};
export function navItemsFor(viewer: Pick<Viewer, "groups">, counts?: NavCounts): NavItems;   // counts defaults to {}
/** The sidebar's isActive, lifted: exact → pathname === href; else pathname === href || pathname.startsWith(`${href}/`). */
export function isActivePath(pathname: string, href: string, exact?: boolean): boolean;

// (Wave A) phone tab derivation + the Admin overflow rule + the §2 route rule, all pure:
export type BottomTab = "dashboard" | "queues" | "new" | "audit" | "account";
export function bottomTabsFor(items: NavItems): BottomTab[];        // never more than five; ignores `admin`
export function adminOverflowFor(items: NavItems): AdminNavItem[];  // what the Account sheet renders
export function hidesBottomNav(pathname: string): boolean;          // /^\/tickets\//
```

`AppSidebar` and `BottomNav` both consume it; the sidebar's diff is replacing its inline derivation. **(Wave A)** `AccountSheet` consumes it too, for the Admin block.

### 3.3 `src/components/shell/responsive-sheet.tsx` (`"use client"`)

Wraps `Sheet`, `SheetContent` (real props: `side`, `showCloseButton`, plus `React.ComponentProps<typeof SheetPrimitive.Content>`), `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetFooter`, and `Popover`, `PopoverTrigger`, `PopoverContent`; `Slot` from `radix-ui`.

```ts
export type ResponsiveSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rendered as <SheetTitle> inside a ResponsiveSheetHeader. OMIT only when the consumer renders its own
   *  <SheetTitle> in children (sr-only allowed) — a title is mandatory for a11y either way. */
  title?: React.ReactNode;
  titleHidden?: boolean;                 // default false → SheetTitle gets "sr-only"
  description?: React.ReactNode;         // <SheetDescription>; when omitted, aria-describedby={undefined} is passed to SheetContent
  side?: "right" | "left";               // md+ side; phones are ALWAYS side="bottom". Default "right".
  size?: "md" | "lg";                    // md+ width: "md" = shadcn default (data-[side=right]:sm:max-w-sm); "lg" = 560px. Default "md".
  height?: "auto" | "full";              // phone: "auto" = content height capped at 90svh; "full" = exactly 90svh (scrolling bodies). Default "auto".
  showCloseButton?: boolean;             // default true (the X is data-slot="sheet-close" → 44×44 on phones via the §6 rule)
  className?: string;                    // extra classes for SheetContent
  contentProps?: Omit<React.ComponentProps<typeof SheetContent>, "side" | "className" | "children" | "showCloseButton">; // e.g. onInteractOutside
  children: React.ReactNode;             // compose ResponsiveSheetBody / ResponsiveSheetFooter
};
export function ResponsiveSheet(props: ResponsiveSheetProps): React.JSX.Element;

/** <SheetHeader className={cn("flex flex-col gap-1 px-4 pt-3 pb-3 pr-14", className)}> — pr-14 clears the 44px X. */
export function ResponsiveSheetHeader({ className, children }: { className?: string; children: React.ReactNode }): React.JSX.Element;
/** <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4", className)}> */
export function ResponsiveSheetBody({ className, children }: { className?: string; children: React.ReactNode }): React.JSX.Element;
/** <SheetFooter className={cn("mt-auto flex flex-row items-center gap-2 border-t bg-muted/30 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] md:pb-3", className)}> — keeps data-slot="sheet-footer" for QA. */
export function ResponsiveSheetFooter({ className, children }: { className?: string; children: React.ReactNode }): React.JSX.Element;
```

Implementation (binding):

```tsx
const desktop = useMediaQuery(MD_UP);
<Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent
    side={desktop ? side : "bottom"}
    showCloseButton={showCloseButton}
    data-responsive-sheet
    data-height={height}
    className={cn(
      "flex flex-col gap-0 p-0",
      "data-[side=bottom]:max-h-[90svh] data-[side=bottom]:rounded-t-2xl",           // phone
      height === "full" && "data-[side=bottom]:h-[90svh]",                          // twMerge collapses the base h-auto (same variant)
      size === "lg" && "data-[side=right]:sm:max-w-[560px] data-[side=left]:sm:max-w-[560px]", // collapses the base sm:max-w-sm
      className,
    )}
    {...(description === undefined ? { "aria-describedby": undefined } : {})}       // the shadcn way to silence Radix's description warning
    {...contentProps}
  >
    <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-(--wm-sheet-handle) md:hidden" />
    {title !== undefined ? (
      <ResponsiveSheetHeader>
        <SheetTitle className={titleHidden ? "sr-only" : undefined}>{title}</SheetTitle>
        {description !== undefined ? <SheetDescription>{description}</SheetDescription> : null}
      </ResponsiveSheetHeader>
    ) : null}
    {children}
  </SheetContent>
</Sheet>
```

Why a prop and not CSS: the Radix/shadcn `side` drives `data-side`, the enter/exit animation direction and the base positioning recipe; re-skinning a permanently-bottom sheet into a right sheet at `md` needs ~25 prefixed overrides that lie to QA (`data-side="bottom"` on desktop) and break silently on the next `shadcn add sheet`. `side` is exactly the "hook is unavoidable" case R6 allows. No sheet is ever open at first paint, so the SSR default (phone) causes no flash.

```ts
export function ResponsivePopover({ open, onOpenChange, trigger, title, align = "start", sideOffset = 4, className, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactElement;   // a <Button>; receives onClick/aria-expanded/aria-haspopup via Slot.Root (phone) or PopoverTrigger asChild (md+)
  title: string;                 // visible SheetTitle on phone; not rendered in the desktop popover
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;            // PopoverContent classes at md+ (e.g. "w-80 p-0")
  children: React.ReactNode;     // the same content in both modes
}): React.JSX.Element;
```

Phone → `<Slot.Root onClick={() => onOpenChange(true)} aria-haspopup="dialog" aria-expanded={open}>{trigger}</Slot.Root>` + `<ResponsiveSheet open onOpenChange title={title} height="auto"><ResponsiveSheetBody className="px-0 pb-safe">{children}</ResponsiveSheetBody></ResponsiveSheet>`. md+ → `<Popover open onOpenChange><PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent align sideOffset className>{children}</PopoverContent></Popover>`. A `disabled` trigger button never fires the Slot's onClick.

### 3.4 `src/components/shell/bottom-nav.tsx` (`"use client"`)

Wraps `Link`, `Badge`, `QueueBadge`, `ResponsiveSheet` (+Body), `SheetTitle`, `AccountSheet`, `navItemsFor`, `isActivePath`.

```ts
/** null on /tickets/** (the StickyActionBar owns the bottom edge there). */
export function BottomNav({ viewer }: { viewer: Viewer }): React.JSX.Element | null;
```

Root: `<nav aria-label="Primary (phone)" data-bottom-nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 supports-backdrop-filter:backdrop-blur pb-safe px-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] md:hidden">` → `<ul className="grid h-(--wm-bottom-bar-h) auto-cols-fr grid-flow-col">`. Each tab (`<Link prefetch={false}>` or `<button type="button">`): `className="flex h-full min-w-11 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-expanded:text-foreground [&_svg]:size-5"`, icon `aria-hidden`, visible label (no icon-only tabs). The New tab's icon sits in `<span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">`. Private `QueuesSheet` in the same file: `ResponsiveSheet height="auto" title="Queues"`, `<ul>` of `<Link href={`/queues/${slug}`} prefetch={false} aria-current className="flex min-h-12 items-center gap-3 px-4 text-base">` with `QueueBadge` + label. State `useState<"queues" | "account" | null>`; a `useEffect` on `usePathname()` closes any open sheet on navigation.

### 3.5 `src/components/shell/account-sheet.tsx` (`"use client"`)

Wraps `ResponsiveSheet` (+Body/Footer), `Badge`, `Button`, `Separator`, `UserAvatar`, `ThemeSegmented`, `signOutAction`, `isDualRole`, `GROUP_LABELS`.

```ts
export function AccountSheet({ viewer, open, onOpenChange }: { viewer: Viewer; open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element;
```

`ResponsiveSheet height="auto" title="Account"`. Body order: `UserAvatar size="md"` + email → chips row (`Badge variant="secondary" data-group` per group; dashed "No groups"; Dual role `Badge className="gap-1 border-transparent bg-red-600 text-white dark:bg-red-700" data-dual-role` followed by the visible sentence; DEV LOGIN `Badge className="border-transparent bg-amber-400 font-semibold text-amber-950 dark:bg-amber-500" data-dev-login`) → `Separator` → "Theme" label + `<ThemeSegmented />` → footer: `<form action={signOutAction}><Button type="submit" variant="outline" className="w-full"><LogOut aria-hidden />Sign out</Button></form>` + muted "Every ticket view and change is recorded."

### 3.6 `src/components/shell/theme-toggle.tsx` (`"use client"`)

```ts
export function ThemeToggle(): React.JSX.Element;     // the topbar's private DropdownMenu+Tooltip icon button, moved verbatim (md+ topbar)
/** role="radiogroup" aria-label="Theme"; three Buttons (Sun Light / Moon Dark / Monitor System) role="radio" aria-checked,
 *  variant "secondary" when selected else "ghost", className="min-h-11 flex-1". Reads useTheme().theme after a mounted flag
 *  (safe: only ever rendered inside an opened sheet, never on first paint). */
export function ThemeSegmented({ className }: { className?: string }): React.JSX.Element;
```

### 3.7 `src/components/shell/sticky-action-bar.tsx` (no `"use client"` — RSC-safe so the sign-in page can render it)

```ts
/** <div role="toolbar" aria-label={label} data-sticky-action-bar className={cn(
 *    "fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t bg-background/95 supports-backdrop-filter:backdrop-blur",
 *    "px-safe pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] min-h-[calc(var(--wm-bottom-bar-h)+env(safe-area-inset-bottom,0px))] md:hidden", className)}>
 *  Children are Buttons (forms) or StickyActionItems (dock); form bars give each Button "flex-1". May be rendered INSIDE a <form>
 *  (position:fixed does not break form association, so a type="submit" child submits). */
export function StickyActionBar({ label, className, children }: { label: string; className?: string; children: React.ReactNode }): React.JSX.Element;

/** Icon-over-label item, same look as a BottomNav tab. Renders <Link prefetch={false}> when `href` is given, else <button type="button">.
 *  className="flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium
 *  text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 aria-expanded:text-foreground [&_svg]:size-5"
 *  disabled → `disabled` + aria-disabled="true" + opacity-50 + an sr-only reason node referenced by
 *  aria-describedby, plus title={disabledReason} for a pointer. NOT painted on the bar: see R10. */
export function StickyActionItem(
  props: { icon: LucideIcon; label: string; active?: boolean; disabled?: boolean; disabledReason?: string; className?: string } &
    ({ href: string } | { onClick: () => void; "aria-expanded"?: boolean; "aria-haspopup"?: "dialog" }),
): React.JSX.Element;
```

### 3.8 `src/components/shell/mobile-card.tsx` (`"use client"`)

```ts
/** Clicks on these never activate the card: the element has its own action. Lifted from ticket-table.tsx (S5 re-imports it). */
export const INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[role=combobox],[role=option],[role=menuitem],[data-slot=select-trigger],[data-card-action]";

export function MobileCard({
  as = "li", label, onActivate, tone = "default", actions, className, children, ...dataAttrs
}: {
  as?: "li" | "div";
  label: string;                        // accessible name of the tappable region, e.g. "Ticket HD-1042: Wire not received"
  onActivate: () => void;               // tap / Enter / Space on the body, outside INTERACTIVE_SELECTOR
  tone?: "default" | "alarm" | "muted"; // alarm = "ring-destructive/40 bg-destructive/[0.03]" (mirrors the table row tint); muted = "text-muted-foreground"
  actions?: React.ReactNode;            // rendered OUTSIDE the tappable region, inside <MobileCardActions>
  className?: string;
  children: React.ReactNode;            // the tappable body
} & { [key: `data-${string}`]: string | undefined }): React.JSX.Element;

/** <div data-card-action className={cn("flex items-center gap-2 border-t px-3 py-2", className)}> — a sibling of the body, never its child. */
export function MobileCardActions({ className, children }: { className?: string; children: React.ReactNode }): React.JSX.Element;
```

Structure (binding): `<li {...dataAttrs} className={cn("rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10", toneClass, className)}><div role="button" tabIndex={0} aria-label={label} onClick onKeyDown className="flex min-h-11 flex-col gap-2 rounded-t-xl p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-muted/40">{children}</div>{actions ? <MobileCardActions>{actions}</MobileCardActions> : null}</li>`. Interactive controls (AssigneeSelect, Open link) live in `actions`, **not** inside the `role="button"` region — that is what makes the card valid for screen readers and what keeps a Select tap from opening the preview. The amber left edge is reserved for `INTERNAL_NOTE_CLASSES`; `tone="alarm"` uses the destructive ring, never amber.

### 3.9 `src/components/shell/filter-sheet.tsx` (`"use client"`)

Wraps `Button`, `Badge`, `ResponsiveSheet` (+Header/Body/Footer).

```ts
/** ResponsiveSheet height="full". Header: title + count Badge; "Clear all" ghost Button when onClearAll && activeCount > 0.
 *  children → ResponsiveSheetBody (FilterSections); footer → ResponsiveSheetFooter. Content mounts only while open (Radix). */
export function FilterSheet({ open, onOpenChange, title = "Filters", activeCount, onClearAll, children, footer }: {
  open: boolean; onOpenChange: (open: boolean) => void; title?: string; activeCount: number;
  onClearAll?: () => void; children: React.ReactNode; footer: React.ReactNode;
}): React.JSX.Element;

/** <Button type="button" variant="outline" aria-haspopup="dialog" aria-expanded={expanded} aria-label={`${label}, ${activeCount} active`}
 *  className={cn("shrink-0 md:hidden", className)}><SlidersHorizontal aria-hidden />{label}{activeCount > 0 ? <Badge variant="secondary" className="tabular-nums">{activeCount}</Badge> : null}</Button> */
export function FilterSheetTrigger({ activeCount, onClick, expanded, label = "Filters", className }: {
  activeCount: number; onClick: () => void; expanded?: boolean; label?: string; className?: string;
}): React.JSX.Element;

/** <fieldset className={cn("flex flex-col gap-2 py-3 not-last:border-b", className)}><legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</legend><div className="flex flex-wrap gap-2">{children}</div></fieldset> */
export function FilterSection({ label, className, children }: { label: string; className?: string; children: React.ReactNode }): React.JSX.Element;

export type ActiveFilterChip = { key: string; label: string; onRemove: () => void };
/** null when empty. <ul aria-label="Active filters" data-snap-row className={cn(SNAP_ROW_CLASSES, "md:hidden", className)}>; each chip:
 *  <li className="snap-start shrink-0"><Button type="button" size="sm" variant="secondary" className="min-w-11 max-w-[70vw] font-normal"
 *  aria-label={`Remove filter: ${label}`} onClick={onRemove}><span className="truncate">{label}</span><X aria-hidden /></Button></li>;
 *  trailing "Clear all" ghost Button when onClearAll && chips.length > 1. */
export function ActiveFilterChips({ chips, onClearAll, className }: {
  chips: readonly ActiveFilterChip[]; onClearAll?: () => void; className?: string;
}): React.JSX.Element | null;

/** Element-level horizontal snap scroller; children add "snap-start shrink-0"; consumers also set data-snap-row (QA allowlist + hidden scrollbar). */
export const SNAP_ROW_CLASSES = "flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain scroll-px-4 -mx-4 px-4";
```

### 3.10 Changed S4 files (signature deltas only)

- `src/components/tickets/assignee-select.tsx` — signature unchanged; `SelectTrigger className="w-full min-w-40 max-w-64"` → `"w-full min-w-40 md:max-w-64"` (full width in cards and sheets, capped only in table cells / desktop panel).
- `src/components/app-sidebar.tsx` — signature unchanged; derive items with `navItemsFor` / `isActivePath`; markup unchanged.
- `src/components/topbar.tsx` — signature unchanged; remove `Sheet`/`Menu`/`navOpen`/`AppSidebar`; import `ThemeToggle` from `@/components/shell/theme-toggle`; `ENV_BANNER` entries gain `shortText` ("LOCAL · NOT PRODUCTION", "DEV · NOT PRODUCTION"); header `pt-safe`; phone brand; `hidden md:flex` on group chips and the right cluster.
- `src/components/providers.tsx` — signature unchanged; `<Toaster richColors closeButton position="top-right" mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 4.5rem)" }} />`. No hook: Sonner already renders toasts full-width at the top below 600 px; the offset clears the compact topbar (20 + 44 px).
- `src/app/layout.tsx` — add `export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" }` (`import type { Metadata, Viewport } from "next"`). `maximumScale` is deliberately not set (pinch zoom stays available, WCAG 1.4.4).
- `src/app/(app)/layout.tsx` — `<main id="main" className="flex-1 px-safe pt-4 pb-bar-safe md:px-6 md:py-5">`; `<BottomNav viewer={viewer} />` after `</main>` inside the flex column.

---

## (4) Per-screen spec

Legend: **Phone** = base classes (< 768); **md+** = `md:` enhancements. "44 via rule" = the §6 phone rule sizes it; "explicit 44" = the component adds `min-h-11` itself because the element has no `data-slot`.

### 4.0 Shell — S4 (`src/app/(app)/layout.tsx`, `src/app/layout.tsx`, `src/app/(app)/error.tsx`, `src/components/topbar.tsx`)

- **Phone:** see §2. `<main>` reserves one bar height (`pb-bar-safe`) on every phone route. `error.tsx`: `mt-8 md:mt-16`; Retry `className="w-full sm:w-auto"` (44 via rule).
- **md+:** as today.

### 4.1 Sign-in — `src/app/sign-in/page.tsx` (S4 edits it this pass; layout only, no auth logic — §g lists it under S1, ownership amendment recorded in ARCHITECTURE)

- **Phone:** `<main className="flex min-h-svh flex-col items-center bg-background px-safe pt-6 pb-bar-safe sm:justify-center sm:py-10 md:pb-10">`; cards full width. When `okta` is true the in-card "Continue with Okta" becomes `hidden md:flex` and a `<StickyActionBar label="Sign in">` (phone only) holds `<form action={signInWithOkta.bind(null, target)} className="flex-1"><Button type="submit" size="lg" className="w-full">Continue with Okta</Button></form>`. When Okta is not configured there is **no** sticky bar (a disabled sticky CTA is noise; the personas are the actions). Dev persona rows: `<form className="flex flex-col gap-1.5">` → `<Button type="submit" variant="outline" className="w-full justify-between">{p.name}<ChevronRight aria-hidden /></Button>` + `<div className="flex flex-wrap gap-1">` of group Badges beneath (no more 160 px button beside wrapping badges).
- **md+:** identical to today (centered `max-w-md`, inline Okta button, no sticky bar).
- Components: `Card`, `Alert`, `Button`, `Badge`, `Separator`, `StickyActionBar`.

### 4.2 No-access — `src/app/no-access/page.tsx` (S4)

- **Phone:** `<main className="flex min-h-svh items-start justify-center bg-background px-safe pt-6 pb-safe text-foreground sm:items-center">`; action row `grid grid-cols-2 gap-2 sm:flex sm:justify-start`, both Buttons default size (44 via rule), email `dd` `break-all sm:truncate`. Server-side `recordDenied` untouched.
- **md+:** as today.

### 4.3 Dashboard + Queue page — S5 (`dashboard-view.tsx`, `queue-counters.tsx`, `ticket-filters.tsx`, `ticket-table.tsx`, new `ticket-card.tsx`, `ticket-preview-sheet.tsx`; pages unchanged)

`DashboardView` signature unchanged.

1. **Header:** `<header className="flex flex-wrap items-end justify-between gap-2">` — title/subtitle block on the left, actions on the right in `<div className="flex flex-wrap items-center justify-end gap-2">`. "New ticket" is `Button asChild size="sm" className="hidden md:inline-flex"` (the tab bar owns New on phones). Title/subtitle unchanged.
   - **(Wave A)** the actions group also carries `<ExportTicketsButton query={query} viewer={viewer} />` at **every** width (contract §8 — the CSV of exactly what the filters select). It renders `null` unless `canExportTickets(viewer.groups)`, so for ops/advisor/cs the phone header is still title-only; for **compliance and supervisor** it is an `Export scope` `SelectTrigger size="sm" className="min-w-36"` + an `Export CSV` `Button` + the `Export is itself audited` caption. At 390 px that group wraps onto its own row under the title, i.e. **one extra row** between the operator and the counter carousel on the screen this section calls primary. That is the accepted cost of keeping one export control rather than a phone copy; it is bounded by two rules that are binding here: the group must stay inside R2/R3 (the `min-w-36` trigger and the button are both ≥ 44 via the §6 rule, and neither may force horizontal scroll at 360), and it may never grow to a second wrapped row — a third control in this header belongs in the filter sheet. *Recommended default, pending confirmation:* if the phone header is meant to stay title-only for every persona, the change is one class on the export block in `dashboard-view.tsx` (`hidden md:flex`) plus a mirrored `Export CSV` row inside the filter sheet; see the build record.
2. **Counters (`QueueCounters`, signature unchanged) — phone: snap carousel.** Container `cn(SNAP_ROW_CLASSES, "pb-1 sm:mx-0 sm:grid sm:gap-3 sm:overflow-visible sm:px-0 sm:pb-0 sm:snap-none", gridCols)` with `data-snap-row`; both `QueueCard` branches add `w-[85%] shrink-0 snap-start sm:w-auto` so ~1.15 cards show (peek affordance) and numerals never squash. `Stat` link: `min-h-11 justify-center md:min-h-0` (explicit 44), label `text-xs`; `CardTitle` queue `<Link>`: `min-h-11 flex items-center md:min-h-0`. Stat values `text-lg md:text-base`. **md+:** the existing grid.
3. **Filters (`TicketFilters`) — new optional prop `total?: number` (S5-internal; exports `ticketQueryToParams`, `ticketQueryHref`, `hasActiveFilters`, `PAGE_SIZE_OPTIONS` unchanged).**
   - Row A (all widths): search `Input` (`type="search"`, className `"pl-8 md:h-7 md:text-sm"` — the current `h-7 text-sm md:text-sm` is removed: 14 px triggers iOS zoom) + `<FilterSheetTrigger activeCount expanded onClick />` (`md:hidden`) + the existing md+ controls in `<div className="hidden md:flex md:items-center md:gap-1.5">` (queue Select, assignee Select, sort Select, direction button, Clear).
   - Row B phone: `<ActiveFilterChips chips onClearAll={clearAll} />` — one chip per active status (only when `!sameSet(statuses, DEFAULT_STATUS_FILTER)`), per priority, per SLA status, assignee ("Me" / "Unassigned" / name), queue (dashboard only), sort ≠ default (`Sort: ${SORT_LABELS[sort]} ↑|↓`). Search is not a chip (the box is visible). Removal writes the URL through `write()`. Row B md+: the existing `ChipGroup`s in `hidden md:flex`.
   - Controls are extracted into private components rendered in both places (`QueueSelect`, `AssigneeFilterSelect`, `SortControls`, `StatusChips`, `PriorityChips`, `SlaChips`, each `{ query, write, layout: "bar" | "sheet" }`). In the sheet: `FilterSection`s Status / Priority / SLA with chips as `Button type="button" size="sm" variant={pressed ? "secondary" : "outline"} aria-pressed className="min-w-11"` (44 via rule); Queue (dashboard only) and Assignee `Select`s `className="w-full"`; Sort `Select` + direction `Button` in `grid grid-cols-[1fr_auto] gap-2`.
   - `<FilterSheet open onOpenChange activeCount onClearAll={clearAll} footer={<Button type="button" className="flex-1" aria-busy={pending || undefined} onClick={() => setOpen(false)}>{pending ? "Updating…" : total !== undefined ? `Show ${total} tickets` : "Done"}</Button>}>`. Every change writes the URL immediately (`router.replace`, page reset) exactly as today; the sheet stays open because `open` is local state on the same component.
   - `activeCount = chips.length`.
4. **List (`TicketTable`, signature unchanged) — one component, two presentations, one `useReactTable`, one footer.** The existing `<div className="rounded-lg border bg-card …"><Table>…</Table></div>` gains `hidden md:block`; beside it `<ol className="flex flex-col gap-2 md:hidden" aria-label="Tickets">{table.getRowModel().rows.map((r) => <TicketCard key={r.id} row={r.original} viewer assignees={assigneesByQueue[r.original.queueKey] ?? []} showQueue onPreview />)}</ol>` (rows come from the same `table.getRowModel()`). Import `INTERACTIVE_SELECTOR` from `@/components/shell/mobile-card`; delete the local copy. Empty state shared (`"No tickets match these filters."` + Clear filters, 44 via rule) rendered once above both presentations when `rows.length === 0`. Footer `flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between`; the four `icon-xs` pager Buttons stay `icon-xs` (44 via rule on phones; dense at md+), rows-per-page `SelectTrigger` drops `h-6` (`className="min-w-16 px-1.5 md:h-6 md:text-xs"`).
   - **`TicketCard`** (`src/components/dashboard/ticket-card.tsx`, S5):
     ```ts
     export function TicketCard({ row, viewer, assignees, showQueue, onPreview }: {
       row: TicketListRow; viewer: Viewer; assignees: AssigneeOption[]; showQueue: boolean; onPreview: (id: string) => void;
     }): React.JSX.Element;
     ```
     `<MobileCard as="li" label={`Ticket ${formatTicketNumber(row.number)}: ${row.subject}`} onActivate={() => onPreview(row.id)} tone={row.sla.status === "BREACHED" && row.status !== "CLOSED" ? "alarm" : row.status === "CLOSED" ? "muted" : "default"} data-ticket-id={row.id} data-status={row.status} data-sla-status={row.sla.status} actions={…}>`. Body rows: (1) `<span className="font-mono text-xs text-muted-foreground">{HD-n}</span>` (plain text) · `<SlaBadge timers initial={row.sla} />` right-aligned — the glance target; (2) subject `text-[15px] font-medium leading-snug line-clamp-2` + `<PiiIndicator count={row.piiRedactionCount} scope="ticket" />`; (3) `<PriorityBadge /> <StatusBadge /> {showQueue && <QueueBadge />}` … `<time>` `formatRelative(updatedAt)` right; (4) `<span className="text-xs text-muted-foreground truncate">{requesterName} · {CATEGORY_LABELS[category]}</span>`. Actions: `editable = canWriteQueue(viewer.groups, row.queueKey) && row.status !== "CLOSED"` → `<AssigneeSelect ticketId version={row.version} value={row.assignee} options={assignees} disabled={!editable} />` (or `<UserAvatar user={row.assignee} size="sm" />` when not editable) + `<Button asChild variant="outline" size="sm" className="min-w-11 shrink-0"><Link href={`/tickets/${row.id}`} prefetch={false} aria-label={`Open ticket ${HD-n}`}>Open<ArrowRight aria-hidden /></Link></Button>`. **No inline text links on cards:** body tap = preview, Open = detail — zero mis-taps between the two.
   - `columns.tsx` unchanged.
5. **Preview (`TicketPreviewSheet`, signature unchanged):** `<ResponsiveSheet open={open && ticketId !== null} onOpenChange size="lg" height="full">` (no `title` prop — `PreviewBody` owns the title: `PreviewSkeleton` gains `<SheetTitle className="sr-only">Loading preview</SheetTitle>`; error/not-found already render one; the loaded state keeps `SheetTitle` = subject). `PreviewBody` replaces its `SheetHeader`/scroll div/`SheetFooter` with `ResponsiveSheetHeader` / `ResponsiveSheetBody` / `ResponsiveSheetFooter className="flex-col items-stretch gap-2 md:flex-row md:items-center md:justify-between"`; "Open ticket" `Button className="w-full md:w-auto"`; `Field` `dd` `break-words md:truncate`; the `dl` stays `grid-cols-2`. Fetch / one-open-one-view logic untouched.
6. `AutoRefresh` unchanged.
- **md+ (768/1280):** unchanged except the shell. Queue page (`showQueue=false`): no queue badge on cards, no queue select in the sheet, `queueKey` never written.

### 4.4 New ticket — S5 (`new-ticket-form.tsx`; page unchanged)

- **Phone:** sections already stack (`md:grid-cols-2`). Selects `w-full` (44 via rule); description `Textarea className="min-h-40 leading-relaxed md:font-mono md:text-[13px]"` (16 px on phone). The bottom `<div className="flex items-center justify-end gap-2">` becomes `hidden md:flex md:items-center md:justify-end md:gap-2`; additionally, **inside the `<form>`**, `<StickyActionBar label="Create ticket"><Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>Cancel</Button><Button type="submit" className="flex-1" disabled={pending}>{pending ? <LoaderCircle className="animate-spin" /> : null}{pending ? "Creating…" : "Create ticket"}</Button></StickyActionBar>`. Field errors stay under their fields; the form-level Alert remains at the top. Bottom nav is hidden on this route (§2).
- **md+:** as today.

### 4.5 Ticket detail — S6 (`src/app/(app)/tickets/[id]/page.tsx`, new `ticket-action-dock.tsx`, new `composer-store.ts`, `ticket-header.tsx`, `properties-panel.tsx`, `composer.tsx`, `macro-picker.tsx`, `disclaimer-preview.tsx`, `markdown-renderer.tsx`)

RSC order (prefetch guard → `getTicketDetail(DETAIL)` → parallel loads) unchanged. Render:

```tsx
<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 md:gap-5">
  {/* (Wave B) above the header: it asks whether this ticket should be worked at all */}
  <Suspense fallback={null}><DuplicateBanner ticket={ticket} viewer={viewer} /></Suspense>
  {/* (Wave A) the header takes the REDIRECT instant from the ledger; a client-reachable component may not read it */}
  <TicketHeader ticket={ticket} requesterEmailChangedAt={requesterEmailChanged?.toISOString() ?? null} />
  {/* (Wave B) phone-only facts strip: a `title` tooltip is not a visible explanation (R10) */}
  <div className="flex flex-wrap items-center gap-2 md:hidden">
    <SlaDetailPopover sla={ticket.sla} ticketNumber={ticket.number} />
    <PresenceChip ticketId={ticket.id} />
  </div>
  <div className="grid gap-4 md:gap-5 lg:grid-cols-[1fr_340px]">
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      {/* description section unchanged */}
      {/* (Wave B) `commentSlot` puts B6's review control under each comment without B3's CommentItem importing it */}
      <Timeline comments={comments} activity={activity} commentSlot={(c) => <ReviewStamp comment={c} viewer={viewer} />} />
      {/* (Wave A) mount point: streams behind its own skeleton, every width */}
      <Suspense fallback={<PanelSkeleton label="Loading attachments…" className="h-40" />}>
        <AttachmentsPanel ticket={ticket} viewer={viewer} />
      </Suspense>
      {/* (Wave B) two more streamed panels, same rules */}
      <Suspense fallback={<PanelSkeleton label="Loading linked tickets…" className="h-24" />}>
        <TicketLinksPanel ticket={ticket} viewer={viewer} />
      </Suspense>
      <Suspense fallback={<PanelSkeleton label="Loading identity verification…" className="h-24" />}>
        <IdentityVerificationPanel ticket={ticket} viewer={viewer} />
      </Suspense>
      <div className="hidden md:block"><Composer ticket={ticket} macros={macros} viewer={viewer} /></div>
    </div>
    {/* (Wave A) the aside is a column now, not a single block — it stacks the panel and the history */}
    <div className="hidden flex-col gap-4 md:flex md:gap-5 lg:sticky lg:top-4 lg:self-start">
      <PropertiesPanel ticket={ticket} assignees={assignees} viewerId={viewer.id} />
      <Suspense fallback={<PanelSkeleton label="Loading requester history…" className="h-32" />}>
        <RequesterHistory ticket={ticket} viewer={viewer} variant="inline" />
      </Suspense>
      {/* (Wave B) who is watching this ticket */}
      <Suspense fallback={<PanelSkeleton label="Loading followers…" className="h-20" />}>
        <TicketFollowers ticket={ticket} viewer={viewer} />
      </Suspense>
    </div>
  </div>
  {/* (Wave A) phone-only: the same panel as a sheet trigger, directly above the dock */}
  {/* (Wave B fix round 2) `TicketFollowers` joins it, for the same reason: mounted only in the md+
      column its follow toggle measured 0x0 at 360/390/430 (R1/R3) and the dashboard bulk bar was a
      phone's only route to following a ticket. `variant="sheet"` = full-width toggle + a sheet
      trigger for the list; the component caches its load, so this is not a second pair of queries. */}
  <div className="flex flex-col gap-2 md:hidden">
    <Suspense fallback={<PanelSkeleton label="Loading requester history…" className="h-11" />}>
      <RequesterHistory ticket={ticket} viewer={viewer} variant="sheet" />
    </Suspense>
    <Suspense fallback={<PanelSkeleton label="Loading followers…" className="h-11" />}>
      <TicketFollowers ticket={ticket} viewer={viewer} variant="sheet" />
    </Suspense>
  </div>
  <TicketActionDock ticket={ticket} macros={macros} viewer={viewer} assignees={assignees} />
  {/* (Wave B) both render null until their slice lands; neither adds a bar or a tab */}
  <VoidTicketSheet ticket={ticket} viewer={viewer} />
  <SwipeNav prevHref={null} nextHref={null} />
</div>
```

**(Wave B) the eight new mounts change no layout rule.** `DuplicateBanner`, `TicketLinksPanel`,
`IdentityVerificationPanel` and `TicketFollowers` are async server components behind their own
`Suspense` boundaries, on exactly the Wave A terms above — own data load, own skeleton, no audit row,
never blocking the audited `TICKET_VIEWED`. The dock still has **five** items and the bottom edge is
still one bar at one `--wm-bottom-bar-h`. `Timeline`'s `commentSlot` renders as a SIBLING of
`CommentItem` inside the timeline's `<ol>`, so whatever it returns must be an `<li>` or null.

**(fix round 1) What the last two mounts actually paint.** The paragraph above described the STUB
state — "client components that render `null` until their slice lands", "`VoidTicketSheet` opens from
the Actions sheet", "`SwipeNav` paints nothing at all" — and both halves are now false. §4.5 is what a
§7 QA pass is run against, so a reviewer following the stale text recorded a PASS on "SwipeNav paints
nothing" without looking, and never checked the void control's placement against the fixed dock.

- **`VoidTicketSheet` renders its own trigger, inline at the foot of the ticket column.** A ghost
  `Button` reading **Entered in error**, `min-h-11 self-start`, after `<TicketActionDock>` in DOM
  order. It is **not** in the Actions sheet. Below `md` it must clear the fixed dock (G10 at 360x800).
- **`SwipeNav` renders a visible two-button `<nav aria-label="Adjacent tickets in the list you came
  from">`**, `md:hidden`, whenever the sessionStorage list snapshot resolves a neighbour. The visible
  affordance is mandatory — a gesture with no control is a gesture nobody discovers.
- The mount still passes `prevHref={null} nextHref={null}`: the hrefs come from the list snapshot the
  operator arrived with, not from the props, and the comment beside the mount says so.

Both belong in §7's ticket-detail per-screen checks, including a G10 assertion that the swipe nav and
the **Entered in error** button clear the fixed dock at 360x800.

**(Wave A) the two streamed panels are binding, not decoration.** `AttachmentsPanel` and
`RequesterHistory` are async server components that own their own data load, each wrapped in its own
`Suspense` so neither holds the page (and therefore the audited `TICKET_VIEWED`) back. `PanelSkeleton`
is local to the page: `<div aria-busy="true">` + an `sr-only` `role="status"` line + a `Skeleton` of a
fixed height, so the column does not jump when the real panel lands (G13). Streaming a panel is **not**
a second view and neither panel writes an audit row. `RequesterHistory` renders twice per page with two
variants — `inline` in the md+ aside, `sheet` in the phone-only block — never both visible at once.

- **`TicketHeader`:** on phone the badge row moves above the subject and leads with SLA: `<div className="flex flex-wrap items-center gap-1.5 md:order-last md:justify-end"><SlaBadge …/><PriorityBadge/><StatusBadge/><QueueBadge/></div>`; `<h1 className="text-lg md:text-xl">`; requester `dd` `break-words md:truncate`.
- **`TicketActionDock`** (`src/components/ticket/ticket-action-dock.tsx`, `"use client"`):
  ```ts
  export function TicketActionDock({ ticket, macros, viewer, assignees }: {
    ticket: TicketDetailDTO; macros: MacroDTO[]; viewer: Viewer; assignees: AssigneeOption[];
  }): React.JSX.Element;
  ```
  **(Wave A)** State `useState<DockSheet>` where `type DockSheet = null | "details" | "actions" | "note" | "reply"`, plus a second `useState(false)` for the hoisted `RecordContactSheet`. `<StickyActionBar label="Ticket actions">` with **five** `StickyActionItem`s — the bar's ceiling at 360 px, which is why the three Wave A actions became one sheet rather than three more items:

  1. **← Queue** — `{ href: `/queues/${queueSlug(ticket.queueKey)}`, icon: ChevronLeft, label: QUEUE_LABELS[ticket.queueKey] }` (deterministic back target; the browser gesture still works).
  2. **Details** (`SlidersHorizontal`, `aria-haspopup="dialog"`, `aria-expanded`).
  3. **Actions** (`Zap`) — rendered when `canAct = (permissions.canWrite && !closed) || permissions.canMove`.
  4. **Note** (`Lock`, disabled unless `permissions.canInternalNote`).
  5. **Reply** (`Send`, disabled unless `permissions.canPublicReply`; `disabledReason` = the Composer's own reason strings).

  Note and Reply render as a pair, gated on `permissions.canInternalNote || permissions.canPublicReply`; a reader with neither and no move right sees only **← Queue · Details**. Sheets: `<ResponsiveSheet open={open === "details"} title="Details" height="full">` → `<ResponsiveSheetBody><PropertiesPanel ticket assignees viewerId={viewer.id} variant="plain" /></ResponsiveSheetBody>`; **(Wave A)** `<ResponsiveSheet open={open === "actions"} title="Actions" description="The same actions the desktop properties panel offers." height="auto">` → `<TicketQuickActions ticket viewerId={viewer.id} layout="stacked" onRecordContact={…} onDone={() => setOpen(null)} />` over an uppercase **Move to queue** label + `<TicketMoveQueueControl ticket />` — which, when the ticket is CLOSED or `!permissions.canMove`, renders a read-only `<QueueBadge queueKey={ticket.queueKey} />` in place of the Select (**not** a disabled Select) with the plain-text reason under it: "Closed tickets cannot be moved." or "Your groups cannot hand this ticket to another queue."; `<ResponsiveSheet open={open === "note" || open === "reply"} title={open === "reply" ? "Reply to client" : "Internal note"} height="full">` → `<ResponsiveSheetBody><Composer key={open} ticket macros viewer layout="sheet" initialChannel={open === "reply" ? "public" : "internal"} onSubmitted={() => setOpen(null)} /></ResponsiveSheetBody>`. Mutations inside call `router.refresh()` as today; the dock's `open` state survives the RSC re-render.

  **Why a sheet and not three items (Wave A, binding):** Decision #67 opened Move-to-queue to Client Service, so it has to be reachable from a phone and not only from the Details panel's Queue field — but the bar was already at four and five is the ceiling. The Actions sheet holds *Assign to me*, *Record client contact* and *Move to queue*, and it hosts the properties panel's **own exported components**, so there is one implementation of each action rather than a phone copy. `RecordContactSheet` is owned by the dock, not by `TicketQuickActions`, so it opens at the top level **after** the Actions sheet closes — two stacked bottom sheets over a 360 px screen is not a usable dialog.
- **`PropertiesPanel`** — `PropertiesPanel({ ticket, assignees, viewerId, variant = "card" }: { ticket: TicketDetailDTO; assignees: AssigneeOption[]; viewerId?: string; variant?: "card" | "plain" })` (**(Wave A)** `viewerId` lets "Assign to me" hide itself when the ticket is already theirs; the module also exports `TicketQuickActions` and `TicketMoveQueueControl` for the dock's Actions sheet): `plain` drops `rounded-lg border bg-card p-4` (the sheet supplies chrome). `id="sla-heading"` → `useId()` (two instances coexist on phone while the Details sheet is open). Selects already `w-full` (44 via rule). Move-queue `AlertDialog` unchanged (Radix supports nesting).
- **`Composer`** — `Composer({ ticket, macros, viewer, initialChannel, layout = "inline", onSubmitted }: { ticket: TicketDetailDTO; macros: MacroDTO[]; viewer: Viewer; initialChannel?: "internal" | "public"; layout?: "inline" | "sheet"; onSubmitted?: () => void })`. `initialChannel` seeds the channel only when that channel is permitted (else `defaultChannel`). Draft text and macro ids move to `useComposerStore` keyed by `ticket.id` (below); `disclaimerKey`, `acknowledged`, `mode`, `confirmOpen` stay local — the acknowledgement is a per-send confirmation and deliberately resets. `layout="sheet"`: `TabsList className="w-full"` (44 via rule; `[data-slot=tabs-list]{height:auto}`), textareas `min-h-40 text-base`, the submit row (`Add internal note` on the Internal tab; **(Wave A)** `Save reply to ticket` plus, when `canTransition(ticket.status, "PENDING_CLIENT")`, `Save reply and set Pending client` on the Public tab) is `sticky bottom-0 -mx-4 border-t bg-popover px-4 py-2` inside the scrolling body so it is always thumb-reachable, buttons `className="w-full"`. All layouts: the acknowledgement row becomes `<Label htmlFor={ids.ack} className="flex min-h-11 items-start gap-3 py-1 text-sm leading-snug font-normal"><Checkbox …/>I confirm …</Label>` (explicit 44 tap area). `Write`/`Preview` toggle stays `size="xs"` (44 via rule on phones). `onSubmitted?.()` fires in `handleResult` after the success toasts and before `router.refresh()`. **(Wave A) the public-reply gate and its copy are binding.** The gate itself is unchanged — non-NONE disclaimer + acknowledgement + `AlertDialog`, whose `flex-col-reverse` footer already puts "Keep editing" nearest the thumb — but **no control on this surface may say "sent"** (the build record S3; the build record P16). Saving a reply writes an immutable record and *queues* a delivery; whether anything left the building is the `DeliveryChip` on the comment, the one component allowed to print Sent. So: both buttons read **Save reply…**, the confirm action reads **Save reply** / **Save and set Pending client**, and the success toast reads **"Reply saved to the ticket"** / **"Reply saved — ticket set to Pending client"**, followed by a second toast that is either "Queued for delivery to the client" or "No email address on file — this reply was recorded but will not be emailed". The second button takes `ticket.version` (it moves the ticket in the same transaction, I13); the plain save deliberately does not. §7 asserts these literal strings, and `src/components/shell/mobile-first-doc.test.ts` asserts that §7 and the shipped component still agree — reintroducing "Send to client" anywhere fails that test.
- **`src/components/ticket/composer-store.ts`** (zustand, **memory only — no `persist`, no storage**):
  ```ts
  export type ComposerDraft = { note: string; noteMacroId: string | null; reply: string; replyMacroId: string | null };
  export type ComposerStore = {
    drafts: Record<string, ComposerDraft>;                              // keyed by ticket id
    setDraft(ticketId: string, patch: Partial<ComposerDraft>): void;
    clearDraft(ticketId: string, channel: "internal" | "public"): void;
  };
  export const useComposerStore: UseBoundStore<StoreApi<ComposerStore>>;
  ```
  Dismissing the sheet (overlay, Escape, X) keeps the draft; success clears its channel; a draft typed on the phone sheet is the same draft the inline composer shows at `md`.
- **`MacroPicker`** — signature unchanged. `Popover/PopoverTrigger/PopoverContent` → `<ResponsivePopover open onOpenChange={setOpen} title={channel === "INTERNAL" ? "Internal note macros" : "Public reply macros"} align="start" className="w-80 p-0" trigger={<Button …same props… />}>` around the same `Command` tree; `CommandList className="max-h-72 md:max-h-72 max-md:max-h-[min(24rem,calc(90svh-8rem))]"`. Command input is a native `<input>` → 16 px via the §6 rule; `CommandItem`s 44 via rule.
- **`DisclaimerPreview`** — `id="disclaimer-select"` → `useId()`; `SelectTrigger className="w-full md:max-w-xs"`.
- **`MarkdownRenderer`** — append `[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto md:[&_table]:table` to `MARKDOWN_CLASSES` so a wide GFM table scrolls inside its card (`[&_pre]:overflow-x-auto` already covers code). `remarkRedactionMarks` untouched.
- `Timeline`, `CommentItem`, `ActivityRow`: unchanged (headers already `flex-wrap`; the full `INTERNAL_NOTE_LABEL` wrapping onto its own line at 360 is intended — it is the compliance message).
- **md+:** dock hidden; inline Composer + PropertiesPanel as today (panel stacks below at 768–1023, two columns from `lg`).

### 4.6 Audit log — S7 (`src/app/(app)/compliance/audit/page.tsx`, `audit-filters.tsx`, `audit-table.tsx`, new `audit-row-card.tsx`, `audit-row-dialog.tsx`, `chain-verify-button.tsx`, `export-button.tsx`)

- **Header:** `<header className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">`; title block; `<div className="grid grid-cols-2 gap-2 md:contents"><ChainVerifyButton /><ExportButton query={q} /></div>`. `ChainVerifyButton`'s Alert gains `col-span-full` beside `order-last basis-full`; its Button `className="w-full md:w-auto"`. `ExportButton` wrapper `items-stretch md:items-end`, anchor Button `className="w-full md:w-auto"`.
- **`AuditFilters`** (signature unchanged): fields extracted into private `AuditFilterFields({ draft, setDraft, idPrefix }: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>>; idPrefix: string })` with `useId()`-prefixed ids (the fixed `audit-from`… ids would duplicate across the two renders). Phone: `<div className="flex flex-col gap-2 md:hidden">` → `<FilterSheetTrigger activeCount expanded onClick label="Filters" />` + `<FilterSheet title="Audit filters" activeCount footer={<><Button type="button" variant="ghost" onClick={onReset}>Reset</Button><Button type="button" className="flex-1" onClick={() => { navigate(queryFromDraft(draft, query.limit)); setOpen(false); }}>Apply filters</Button></>}>` containing `AuditFilterFields` in `FilterSection`s (From/To `datetime-local` 16 px, Actor, Actions `DropdownMenu` — its checkbox items 44 via rule —, Entity `Select w-full`, Ticket), then `<ActiveFilterChips chips />` built from the **applied** `query` (From `formatDateTime`, To, `Actor: x`, `${n} actions` or the single label, `labelize(entityType)`, `HD-n`); a chip's `onRemove` navigates with that key deleted (cursor dropped) and updates `draft`. Desktop: the existing `<form onSubmit className="hidden md:grid …">` with the same fields and Reset/Apply. Semantics unchanged: edits are local until Apply; each Apply or chip removal is one URL change = one `AUDIT_LOG_VIEWED`.
- **`AuditTable`** (signature unchanged) keeps `mergePage`/`flattenRows`/Load more/dialog and renders both presentations from the same `rows`: `<div className="hidden md:block rounded-lg border"><Table>…</Table></div>` + `<ol className="flex flex-col gap-2 md:hidden" aria-label="Audit rows">{rows.map((r) => <AuditRowCard key={r.seq} row={r} onOpen={openRow} />)}</ol>`. Empty state rendered once. Footer `flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between`; Load more `className="w-full sm:w-auto"`. "Start from the newest row" (`variant="link" size="xs"`, inline in a sentence) gets `data-tap="none"` — allowlisted inline text link.
- **`AuditRowCard`** (`src/components/audit/audit-row-card.tsx`, S7):
  ```ts
  export function AuditRowCard({ row, onOpen }: { row: AuditRow; onOpen: (row: AuditRow) => void }): React.JSX.Element;
  ```
  `<MobileCard as="li" label={`Open audit row ${row.seq}`} onActivate={() => onOpen(row)} tone={row.action === "AUTHZ_DENIED" ? "alarm" : "default"} data-seq={row.seq} data-dual-role={row.dualRole ? "true" : undefined} actions={row.ticketId && row.ticketNumber !== null ? <Button asChild variant="outline" size="sm" className="min-w-11"><Link href={`/tickets/${row.ticketId}`} prefetch={false}>Open {HD-n}<ArrowRight aria-hidden /></Link></Button> : undefined}>`. Body: (1) `#seq` mono + `<AuditActionBadge />`; (2) `<time>` `formatDateTime` `text-xs tabular-nums`; (3) actor email `break-all font-medium` + group Badges + Dual role Badge (same markup as the table cell); (4) `labelize(entityType)` + `HD-n` text or `entityId` mono `break-all`; (5) `fieldChanged` code + `old → new` (`truncate()` values, `break-words`). IP omitted (the dialog has it).
- **`AuditRowDialog`** — stays a centered `Dialog` (already fits: `max-w-[calc(100%-2rem)] max-h-[90svh] overflow-y-auto`; old/new stack below `sm`). Only change: footer caption `className="text-xs text-muted-foreground sm:mr-auto sm:self-center"` so it reads above the 44 px Close in the phone column. Ticket `Link` keeps `prefetch={false}`.
- **md+:** as today.

---

## (5) File ownership by slice

All paths are relative to `apps/helpdesk/`. **Every file appears exactly once.** Files another slice owns may only be imported. Nobody touches `src/components/ui/*`, `src/lib/**` (the one S4-owned module there, `format.ts`, is listed below as unchanged), `src/server/**`, `src/types/**`, `prisma/**`, `package.json`, configs, or `src/lib/*.test.ts`. The repo has no commits yet: establish a baseline commit of the fix-pack state first; every slice branches from it and keeps diffs surgical.

### S4 — shell & shared primitives

**Create**
- `src/hooks/use-media-query.ts`
- `src/components/shell/nav-items.ts`
- `src/components/shell/responsive-sheet.tsx` (`ResponsiveSheet`, `ResponsiveSheetHeader`, `ResponsiveSheetBody`, `ResponsiveSheetFooter`, `ResponsivePopover`)
- `src/components/shell/bottom-nav.tsx` (`BottomNav`, private `QueuesSheet`)
- `src/components/shell/account-sheet.tsx`
- `src/components/shell/theme-toggle.tsx` (`ThemeToggle` moved from topbar, `ThemeSegmented`)
- `src/components/shell/sticky-action-bar.tsx` (`StickyActionBar`, `StickyActionItem`)
- `src/components/shell/mobile-card.tsx` (`MobileCard`, `MobileCardActions`, `INTERACTIVE_SELECTOR`)
- `src/components/shell/filter-sheet.tsx` (`FilterSheet`, `FilterSheetTrigger`, `FilterSection`, `ActiveFilterChips`, `SNAP_ROW_CLASSES`)

**Change**
- `src/app/layout.tsx` (export `viewport`)
- `src/app/(app)/layout.tsx` (main padding, `<BottomNav />`)
- `src/app/(app)/error.tsx`
- `src/app/sign-in/page.tsx` (layout only; ownership amendment recorded)
- `src/app/no-access/page.tsx`
- `src/components/topbar.tsx`
- `src/components/app-sidebar.tsx`
- `src/components/providers.tsx`
- `src/components/tickets/assignee-select.tsx` (`md:max-w-64`)
- `src/app/globals.css` (append inside the `/* wm-helpdesk tokens */ … /* end wm-helpdesk tokens */` block only — §6)
- `docs/ARCHITECTURE.md` (§g S4 module entries; sign-in ownership note; "md is the only flip" convention; pointer to this file. S5–S7 append one bullet each under their own §g section in their PRs)

**Unchanged, S4-owned:** `src/app/page.tsx`, `src/components/tickets/internal-note-styles.ts`, `src/components/tickets/sla-badge.tsx`, `src/components/tickets/sla-badge-label.ts`, `src/components/tickets/sla-badge-label.test.ts`, `src/components/tickets/priority-badge.tsx`, `src/components/tickets/status-badge.tsx`, `src/components/tickets/queue-badge.tsx`, `src/components/tickets/pii-indicator.tsx`, `src/components/tickets/user-avatar.tsx`, `src/lib/format.ts`.

### S5 — dashboard + new ticket

**Create**
- `src/components/dashboard/ticket-card.tsx` (`TicketCard`)

**Change**
- `src/components/dashboard/dashboard-view.tsx`
- `src/components/dashboard/queue-counters.tsx`
- `src/components/dashboard/ticket-filters.tsx`
- `src/components/dashboard/ticket-table.tsx`
- `src/components/dashboard/ticket-preview-sheet.tsx`
- `src/components/dashboard/new-ticket-form.tsx`

**Unchanged, S5-owned:** `src/components/dashboard/columns.tsx`, `src/components/dashboard/dashboard-store.ts`, `src/components/dashboard/auto-refresh.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/queues/[queue]/page.tsx`, `src/app/(app)/tickets/new/page.tsx`.

### S6 — ticket detail

**Create**
- `src/components/ticket/ticket-action-dock.tsx` (`TicketActionDock`)
- `src/components/ticket/composer-store.ts` (`useComposerStore`)

**Change**
- `src/app/(app)/tickets/[id]/page.tsx`
- `src/components/ticket/ticket-header.tsx`
- `src/components/ticket/properties-panel.tsx`
- `src/components/ticket/composer.tsx`
- `src/components/ticket/macro-picker.tsx`
- `src/components/ticket/disclaimer-preview.tsx`
- `src/components/ticket/markdown-renderer.tsx`

**Unchanged, S6-owned:** `src/components/ticket/timeline.tsx`, `src/components/ticket/comment-item.tsx`, `src/components/ticket/activity-row.tsx`, `src/components/ticket/activity-text.ts`, `src/components/ticket/activity-text.test.ts`, `src/components/ticket/remark-redaction-marks.ts`, `src/components/ticket/remark-redaction-marks.test.ts`.

### S7 — audit view

**Create**
- `src/components/audit/audit-row-card.tsx` (`AuditRowCard`)

**Change**
- `src/app/(app)/compliance/audit/page.tsx`
- `src/components/audit/audit-filters.tsx`
- `src/components/audit/audit-table.tsx`
- `src/components/audit/audit-row-dialog.tsx`
- `src/components/audit/chain-verify-button.tsx`
- `src/components/audit/export-button.tsx`

**Unchanged, S7-owned:** `src/components/audit/audit-action-badge.tsx`, `src/components/audit/audit-query-params.ts`, `src/app/api/compliance/audit/export/route.ts`.

### Cross-slice import graph (what G1 and review enforce)

S5, S6, S7 → `@/components/shell/*`, `@/components/tickets/*`, `@/components/ui/*`; never each other. `useMediaQuery` is imported only by the `ResponsiveSheet` module (S4 Create list above). `src/components/shell/**` and `src/hooks/**` import no `@/lib/db|audit|env|request-context|session`, no non-`.actions` `@/server/*`, and the only `@/app/**` import is `@/app/sign-in/sign-in.actions` (AccountSheet). Every `<Link>` in `bottom-nav.tsx`, `sticky-action-bar.tsx`, `ticket-card.tsx`, `audit-row-card.tsx` carries `prefetch={false}` (G6 sees the `/tickets/` literals; the generic items set it unconditionally).

### Build order

S4 lands first on `feat/mobile-first-shell` with `npm run typecheck` green; S5/S6/S7 branch from it (`feat/mobile-first-dashboard|ticket|audit`) and build in parallel against the frozen signatures above. Integration on each PR: `npm run typecheck` → `npm run lint` → `npm test` → `npm run build` → §7 at the five widths. the owner approves every merge.

---

## (6) CSS / tokens additions — `src/app/globals.css` (S4)

Appended **inside** the existing `/* wm-helpdesk tokens */ … /* end wm-helpdesk tokens */` block; everything above the block stays byte-identical. Rules are deliberately **unlayered**: unlayered CSS beats Tailwind's `@layer utilities` regardless of specificity, which is exactly what the phone tap rule needs to override `h-6/h-7/h-8` on shadcn controls without editing `src/components/ui/*` or using `!important`. Tailwind 4.3: `@utility` supports variants (`md:pb-bar-safe`), range media queries are valid.

```css
/* ---------- Mobile-first shell (S4; docs/MOBILE_FIRST.md §6) ---------- */
:root {
  --wm-bottom-bar-h: 3.5rem;                 /* 56px: BottomNav and StickyActionBar share it; <main> reserves it on phones */
  --wm-tap: 2.75rem;                         /* 44px minimum touch target */
  --wm-sheet-handle: oklch(0.556 0 0 / 40%); /* bottom-sheet grab handle */
}
.dark {
  --wm-sheet-handle: oklch(0.85 0 0 / 35%);
}

/* Top-edge offset for anything else that sticks to the top of the DOCUMENT scroll (fix round 2).
   Topbar = pt-safe + env banner (h-5 / md:h-6) + identity row (min-h-11 / md:min-h-12), sticky top-0 z-40.
   A second element at top-0 shares y=0 with it and loses, so a top-sticky bar uses `sticky top-(--wm-topbar-h)`
   and a z BELOW 40 and above the list. :has() drops the banner's height in production. §7 G14 asserts it. */
:root {
  --wm-topbar-row-h: 2.75rem;    /* 44px: the identity row's min-h-11 */
  --wm-topbar-banner-h: 0rem;    /* production renders no environment banner */
  --wm-topbar-h: calc(env(safe-area-inset-top, 0px) + var(--wm-topbar-banner-h) + var(--wm-topbar-row-h));
}
:root:has([data-env-banner]) { --wm-topbar-banner-h: 1.25rem; }   /* 20px: the banner's h-5 */
@media (width >= 48rem) {
  :root { --wm-topbar-row-h: 3rem; }                              /* 48px: md:min-h-12 */
  :root:has([data-env-banner]) { --wm-topbar-banner-h: 1.5rem; }  /* 24px: md:h-6 */
}

/* Utilities the shell composes; variants work (md:pb-bar-safe, sm:px-safe). */
@utility pb-safe      { padding-bottom: env(safe-area-inset-bottom, 0px); }
@utility pt-safe      { padding-top: env(safe-area-inset-top, 0px); }
@utility pb-bar-safe  { padding-bottom: calc(var(--wm-bottom-bar-h) + env(safe-area-inset-bottom, 0px)); }
@utility px-safe      { padding-left: max(1rem, env(safe-area-inset-left, 0px)); padding-right: max(1rem, env(safe-area-inset-right, 0px)); }

/* ---------- Phone-only touch ergonomics (< md). Unlayered → wins over utilities. ---------- */
@media (width < 48rem) {
  /* 44px minimum height for every shadcn control. Opt out ONLY for inline prose links: data-tap="none" (QA allowlist). */
  :where(
    [data-slot=button], [data-slot=select-trigger], [data-slot=tabs-trigger],
    [data-slot=dropdown-menu-trigger], [data-slot=popover-trigger],
    [data-slot=input], [data-slot=input-group],
    [data-slot=select-item], [data-slot=dropdown-menu-item], [data-slot=dropdown-menu-checkbox-item],
    [data-slot=dropdown-menu-radio-item], [data-slot=command-item],
    [data-slot=sheet-close], [data-slot=dialog-close], [data-slot=alert-dialog-action], [data-slot=alert-dialog-cancel]
  ):not([data-tap=none]) { min-height: var(--wm-tap); }

  /* Icon-only buttons and the sheet/dialog X need width too. (The X ends up with data-slot="sheet-close"/"dialog-close":
     the asChild Slot's props are spread after Button's own data-slot.) */
  :where([data-slot=button][data-size^=icon], [data-slot=sheet-close], [data-slot=dialog-close]):not([data-tap=none]) {
    min-width: var(--wm-tap);
  }

  /* shadcn TabsList pins h-8; let the 44px triggers set the height. */
  [data-slot=tabs-list] { height: auto; }

  /* Checkbox is 16px; its ::after is the hit area (shadcn: after:-inset-x-3 after:-inset-y-2) → widen to 44px. */
  [data-slot=checkbox]::after { inset: calc((var(--wm-tap) - 1rem) / -2); }

  /* iOS zooms on focus when a text control is < 16px. Covers cmdk's input, datetime-local and any text-sm override. */
  input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]),
  textarea,
  select { font-size: max(1rem, 1em); }

  /* The 44px X clears the grab handle on bottom sheets. */
  [data-slot=sheet-content][data-side=bottom] [data-slot=sheet-close] { top: 0.5rem; right: 0.5rem; }
}

/* The PWA install offer is a THIRD fixed element on the bottom edge (src/components/shell/pwa-install-prompt.tsx).
   `pb-bar-safe` reserves ONE --wm-bottom-bar-h, which is the bar's height and not the bar plus a card, so the
   offer floated over the last ~150px of every screen and its subtree took taps meant for the controls under it
   (fix round 2). While it is on screen it publishes the clearance it still needs on <html>, and <main> grows by
   exactly that much. A pseudo-element rather than padding: neither the phone `pb-bar-safe` nor the md+ `py-5`
   has to be restated here, so this cannot drift from the layout, and it is inert at every other moment because
   the attribute only exists while the offer is rendered. */
:root[data-wm-install-offer] #main::after {
  content: "";
  display: block;
  height: var(--wm-install-offer-h, 0px);
}

/* Snap rows (counter carousel, active-filter chips) scroll inside themselves; the page never scrolls sideways. */
[data-snap-row] { scrollbar-width: none; }
[data-snap-row]::-webkit-scrollbar { display: none; }

/* Reduced motion: tw-animate-css ships no prefers-reduced-motion handling, so neutralise everything here.
   Radix Presence sees a 0.01ms animation end at once, so sheets/dialogs still unmount. Spinners go static on purpose. */
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Notes:
- `min-height` only constrains; `Button`'s `h-7`/`h-6` still applies at `md+` because the rule lives inside `(width < 48rem)`. Desktop density is untouched.
- `viewport` export (`src/app/layout.tsx`): `{ width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" }` — `cover` makes `env(safe-area-inset-*)` non-zero on iOS; `resizes-content` keeps fixed bars above the Android keyboard (iOS ignores it and resizes the visual viewport only — the composer's own submit row inside the sheet is the reachable control there).
- `ResponsiveSheet` phone classes: `data-[side=bottom]:max-h-[90svh] data-[side=bottom]:rounded-t-2xl` (+ `data-[side=bottom]:h-[90svh]` for `height="full"`). `svh` avoids the iOS URL-bar jump.
- Tailwind recipes used inline (no custom CSS): explicit 44 for `<Link>`/label rows = `min-h-11` (+ `min-w-11` for short labels); bar heights `h-(--wm-bottom-bar-h)` / `min-h-[calc(var(--wm-bottom-bar-h)+env(safe-area-inset-bottom,0px))]`; snap row = `SNAP_ROW_CLASSES` + `data-snap-row`, children `snap-start shrink-0`.

### Typography scale (phone → md+)

| Role | Phone | md+ |
|---|---|---|
| Page title `h1` | `text-lg` | `text-lg` (dashboard/audit), ticket subject `text-xl` |
| Card title / subject | `text-[15px] font-medium leading-snug line-clamp-2` | table cell `text-[13px]` |
| Body / markdown | `text-sm leading-relaxed` (14) | same |
| Meta (times, requester) | `text-xs` (12) | same |
| Eyebrow labels (`dt`, legends) | `text-xs uppercase tracking-wide` | `text-[11px]` allowed |
| Bottom-nav / dock labels | `text-[11px] font-medium` (inside 44 px targets) | — |
| Text inputs / textarea | 16 px (forced) | 14 px (`md:text-sm`), description `md:text-[13px] md:font-mono` |
| Buttons | `text-sm`; `size="sm"` `text-[0.8rem]`; height from the tap rule | shadcn heights |
| Badges | `text-xs`, non-interactive | same |
| Numerals | counters `text-2xl tabular-nums`; stats `text-lg md:text-base tabular-nums`; ids/hashes `font-mono text-xs` | |

### Dark mode

No new colour semantics. Bars use `bg-background/95 border-t supports-backdrop-filter:backdrop-blur` like the topbar; cards `bg-card ring-1 ring-foreground/10` (Card's own recipe); sheets `bg-popover`; the handle is `--wm-sheet-handle` (defined for `:root` and `.dark`). `tone="alarm"` = `ring-destructive/40 bg-destructive/[0.03]` in both themes. `--wm-internal-*`, `--wm-sla-*`, `INTERNAL_NOTE_CLASSES` untouched. 11 px `text-muted-foreground` labels on `bg-background/95` in dark: oklch 0.708 on 0.145 ≥ 4.5:1.

---

## (7) QA checklist

Run against `AUTH_DEV_LOGIN=true npm run dev` (launch config `helpdesk-demo`, `http://localhost:3100`) with the Playwright MCP (`browser_resize`, `browser_navigate`, `browser_evaluate`, `browser_snapshot`, `browser_network_requests`, `browser_take_screenshot`; `browser_run_code_unsafe` for `page.emulateMedia`) or the Claude Browser pane (`resize_window` width/height/colorScheme, `javascript_tool`). Widths: **P1 360×800, P2 390×844, P3 430×932** (phone), **T 768×1024, D 1280×800** (desktop). Personas: ops, advisor, cs, compliance, supervisor. Every check is pass/fail; one screenshot per screen per width; dark mode once per screen; reduced motion once globally.

**Allowlist of `data-tap="none"` opt-outs:** `AuditTable` "Start from the newest row" — still the only one after Wave A (`grep -rn 'data-tap' src/` returns exactly that use plus the three `globals.css` rules that define it). Anything else the probe lists is a defect. **(Wave A) How a G2 offender is fixed:** by giving the control the height, not by adding it to this list. A bare `<Link>` carries no shadcn `data-slot`, so the global 44 px rule in §6 never reaches it; the two ticket-header cross-links (the requester link, which measured 93×18 at 390 px, and "Opened from an earlier, closed ticket") were fixed with `inline-flex min-h-11 items-center … md:min-h-0`, and no opt-out was added. Extending this allowlist is an architecture decision, not a QA convenience: an addition needs a line here **and** in `docs/ARCHITECTURE.md` (the `globals.css` entry calls it "the app's only allowlisted tap-size opt-out"). **Facts to remember:** no seeded persona is dual-role; the Dual role chip / 5-tab bar / dual-role audit badge are verified only with a hand-built local session (e.g. temporarily add `compliance_officers` to a persona on a throwaway branch — never committed) and otherwise recorded as *not verified*.

**Selector discipline in these probes.** `data-*` hooks are deliberately repeated on several elements per record, so a probe that counts records must name the element type. `[data-ticket-id]` alone matches **four** nodes per ticket on `/dashboard` and `/queues/*` — the card `li` (`ticket-card.tsx`), the table `tr` (`ticket-table.tsx`), and the `AssigneeSelect` trigger `button` inside each of those two (`assignee-select.tsx`, rendered from `ticket-card.tsx` and `columns.tsx`) — plus the `header` on `/tickets/[id]` (`ticket-header.tsx`). Count rows with `li[data-ticket-id]` / `tr[data-ticket-id]`, never with the bare attribute selector; a probe written the bare way fails on a correct layout. Both list renderings are always in the DOM (one is `display:none`), so **every count assertion pairs with a visibility assertion** — the count alone never proves which rendering is on screen.

### Global probes (paste after every navigation and again with each sheet/dialog open)

```js
// G1 — no horizontal PAGE scroll (+ the offenders, minus sanctioned element-level scrollers)
(() => { const d = document.documentElement, b = document.body;
  const offenders = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > window.innerWidth + 1 &&
      !el.closest('[data-snap-row],[data-slot=table-container],[data-slot=markdown] pre,[data-slot=markdown] table'); })
    .map(el => el.tagName + '.' + String(el.className).slice(0, 80));
  return { ok: d.scrollWidth <= window.innerWidth && b.scrollWidth <= window.innerWidth, docW: d.scrollWidth, bodyW: b.scrollWidth, vw: window.innerWidth, offenders }; })()
// expected: ok === true, offenders === [] at every width

// G2 — every visible interactive control ≥ 44×44 (phone widths; informational at T/D)
(() => { const sel = 'a[href],button,[role=button],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=radio],[role=switch],input:not([type=hidden]),select,textarea,summary';
  return [...document.querySelectorAll(sel)].filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.classList.contains('sr-only') && el.dataset.tap !== 'none' &&
        !el.closest('[aria-hidden=true],[data-slot=markdown],[data-slot=alert-description],[data-slot=sheet-description],[data-slot=dialog-description]'); })
    .filter(el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
    .map(el => ({ tag: el.tagName, text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) })); })()
// expected: [] at P1–P3. The `[aria-hidden=true]` exclusion is load-bearing, not a QA convenience: Radix renders a
// hidden NATIVE shim for form participation next to each of its controls — `select` for Select, `input[type=checkbox]`
// for Checkbox, both `aria-hidden="true" tabindex="-1"` — and neither is the element a person taps. The Select shim
// carries Radix's visually-hidden style (1×1, so `r.width > 0` does NOT filter it) and the Checkbox shim inherits the
// control's own box (16×16, `opacity:0`, `pointer-events:none`; `visibility` is not `hidden`, so that test misses it
// too). Without the exclusion a form-heavy screen reports phantom offenders: `/tickets/new` at 390 returned exactly
// four — three SELECT 1×1 and one INPUT[type=checkbox] 16×16 — with no real defect behind them (the visible Select
// triggers are ≥ 44 and the checkbox's label row is 44). Anything the probe lists WITH this exclusion in place is a
// real offender; do not widen it further. Checkbox (16px root) is verified separately:
(() => { const cb = document.querySelector('[data-slot=checkbox]'); return cb ? getComputedStyle(cb, '::after').top : 'n/a'; })()   // "-14px" on phones

// G3 — no text control under 16px (phone)
[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=file]),textarea,select')]
  .filter(el => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
  .map(el => ({ id: el.id, name: el.name, placeholder: el.placeholder, fs: getComputedStyle(el).fontSize }))   // expected: []

// G4 — safe-area wiring (env() is 0 in desktop browsers: assert the declarations exist)
(() => { const meta = document.querySelector('meta[name=viewport]')?.content ?? '';
  const bars = [...document.querySelectorAll('[data-bottom-nav],[data-sticky-action-bar],[data-responsive-sheet] [data-slot=sheet-footer]')];
  const cssHasEnv = [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => /safe-area-inset-bottom/.test(r.cssText)); } catch { return false; } });
  return { viewportFitCover: meta.includes('viewport-fit=cover'), interactiveWidget: meta.includes('interactive-widget=resizes-content'), cssHasEnv,
    bars: bars.map(b => ({ tag: b.tagName, safeClass: /pb-safe|pb-bar-safe|safe-area-inset-bottom/.test(b.className), pb: getComputedStyle(b).paddingBottom })) }; })()
// expected: all true; every bar safeClass === true

// G5 — layout flip at md
(() => { const q = s => document.querySelector(s); const vis = el => !!el && getComputedStyle(el).display !== 'none';
  return { bottomNav: q('[data-bottom-nav]') ? vis(q('[data-bottom-nav]')) : 'absent', sidebar: vis(q('aside')), stickyBar: q('[data-sticky-action-bar]') ? vis(q('[data-sticky-action-bar]')) : 'absent' }; })()
// expected: P1–P3 on /dashboard, /queues/*, /compliance/audit → { bottomNav: true, sidebar: false, stickyBar: 'absent' };
//           P1–P3 on /tickets/new and /tickets/[id] → { bottomNav: 'absent', sidebar: false, stickyBar: true };
//           T/D → bottomNav false|'absent', sidebar true, stickyBar false|'absent'

// G6 — sheet side
document.querySelector('[data-slot=sheet-content]')?.dataset.side        // phone: "bottom"; T/D: "right"

// G7 — focus visible: press Tab N times, then
(() => { const el = document.activeElement; const s = getComputedStyle(el); return { el: el.tagName + ' ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30)), ring: s.boxShadow !== 'none' || s.outlineStyle !== 'none' }; })()

// G8 — reduced motion (after page.emulateMedia({ reducedMotion: 'reduce' }); open a sheet first)
[...document.querySelectorAll('.animate-pulse,.animate-spin,[data-slot=sheet-content],[data-slot=dialog-content]')].every(el => parseFloat(getComputedStyle(el).animationDuration) <= 0.001)

// G9 — dark mode: document.documentElement.classList.add('dark'); screenshot; bars opaque enough
[...document.querySelectorAll('[data-bottom-nav],[data-sticky-action-bar]')].map(el => getComputedStyle(el).backgroundColor)   // alpha ≥ 0.9

// G10 — fixed bottom elements never cover content: scroll to the end, then
(() => { window.scrollTo(0, document.body.scrollHeight);
  // EVERY fixed bottom element, not just the nav. Round 2: the PWA install offer is a third one, it
  // carries neither bar attribute, and it covered the last ~150px of every screen at every width while
  // this probe — selecting only the two bars — read `ok: true`. Take the HIGHEST top of the set.
  const bars = [...document.querySelectorAll('[data-bottom-nav],[data-sticky-action-bar],[role=region][aria-label^="Install"]')];
  const main = document.getElementById('main');
  if (!bars.length || !main) return { ok: true, bars: bars.length, main: !!main };
  // A bar's OWN subtree must be excluded: on /tickets/[id] the [data-sticky-action-bar] dock is
  // rendered inside #main, so without this filter `last` resolves to a <span> inside the dock and the
  // probe compares the bar against itself — a guaranteed false failure on a correct layout.
  const cands = [...main.querySelectorAll('*')]
    .filter(e => e.getBoundingClientRect().height > 0 && bars.every(bar => e !== bar && !bar.contains(e)));
  const last = cands.at(-1);
  if (!last) return { ok: true, last: null };
  const lastBottom = last.getBoundingClientRect().bottom, barTop = Math.min(...bars.map(b => b.getBoundingClientRect().top));
  return { ok: lastBottom <= barTop + 1, lastBottom: Math.round(lastBottom), barTop: Math.round(barTop),
    fixed: bars.map(b => b.getAttribute('aria-label') || b.tagName),
    last: last.tagName + ' ' + (last.textContent || '').trim().slice(0, 30) }; })()
// expected: ok === true. Report `lastBottom` / `barTop` / `last` when it fails — a `last` that is part of
// the dock means the probe was edited back to the broken form, not that the layout regressed. The install
// offer only appears on an installable browser that has not dismissed it; to force it, clear
// `localStorage['wmhd.pwa.install-dismissed-at']` and reload.

// G11 — no duplicate ids (run with the Details sheet / Composer sheet / filter sheet OPEN)
[...document.querySelectorAll('[id]')].map(e => e.id).filter((v, i, a) => a.indexOf(v) !== i)   // expected: []

// G12 — prefetch invariant: static → `npm test` G6 green; runtime → after load, scroll every list, then
//        browser_network_requests filtered by "/tickets/" → no request carrying the `next-router-prefetch` header (phone or desktop)

// G13 — a navigation paints something within 400 ms (no dead tap). EVERY (app) route segment has a
//        boundary: src/app/(app)/{dashboard,queues,compliance,admin,tickets/new,tickets/[id]}/loading.tsx,
//        whose shapes live in src/components/shell/route-skeleton.tsx (admin and tickets/[id] carry their
//        own). src/app/(app)/route-loading.test.ts asserts the coverage and that no fallback can read.
//        Throttle the network to "Slow 3G"
//        (or add a server delay), then from the SOURCE screen:
(async () => { const t0 = performance.now(); const before = document.body.innerText.slice(0, 200);
  const src = [...document.querySelectorAll('li[data-ticket-id],tr[data-ticket-id]')].find(el => el.getBoundingClientRect().height > 0);
  src.querySelector('a[href^="/tickets/"]').click();   // card "Open" at P1-P3, number link at T/D
  while (performance.now() - t0 < 4000) { await new Promise(r => requestAnimationFrame(r));
    const busy = document.querySelector('[aria-busy="true"], .animate-pulse');
    if (busy || document.body.innerText.slice(0, 200) !== before) return { ms: Math.round(performance.now() - t0), painted: !!busy }; }
  return { ms: 4000, painted: false }; })()
// expected: painted === true and ms < 400 — the segment's loading.tsx (or a Suspense fallback) is on screen,
// NOT the previous screen unchanged. Fails when a route segment has no loading.tsx and no boundary above its
// slowest child. Re-run with reduced motion: G8 still holds (the skeleton stops pulsing, it does not vanish).

// G14 — nothing that sticks to the TOP edge hides behind the topbar. G10's counterpart, and the gap that
//        let a defect through two QA rounds: G10 only ever inspected [data-bottom-nav]/[data-sticky-action-bar],
//        so the top edge was never probed at all. The shell's topbar is `sticky top-0 z-40` in the DOCUMENT
//        scroll (env banner + identity row + safe area, ~64 px on a phone), so a second element at `top-0` is
//        pinned to the same y and loses — near-opaque blurred chrome paints straight over it. A top-sticky bar
//        offsets by `--wm-topbar-h` (§6) and carries a z-index below the topbar's 40 and above the list.
//        Run it with such a bar ON SCREEN and the page scrolled to MID-list — at the very top nothing is stuck
//        yet, and at the very end a short list has scrolled the bar's container past the viewport.
(() => { const top = document.querySelector('[data-topbar]');
  window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2));
  const bars = [...document.querySelectorAll('[data-sticky-top-bar]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!top || bars.length === 0) return { ok: true, topbar: !!top, bars: bars.length };
  const topBottom = top.getBoundingClientRect().bottom, topZ = Number(getComputedStyle(top).zIndex);
  return { ok: bars.every(b => b.getBoundingClientRect().top >= topBottom - 1 && Number(getComputedStyle(b).zIndex) < topZ),
    topBottom: Math.round(topBottom), topZ,
    bars: bars.map(b => ({ label: b.getAttribute('aria-label') || b.tagName, top: Math.round(b.getBoundingClientRect().top),
      z: getComputedStyle(b).zIndex, stuck: getComputedStyle(b).position === 'sticky' })) }; })()
// expected: ok === true at every width. The only top-sticky bar today is the dashboard/queue BULK ACTIONS bar
// ([data-slice="B2-bulk-bar"]), which renders null while nothing is checked — TICK AT LEAST TWO ROWS first, or
// the probe returns { ok: true, bars: 0 } and has asserted nothing. A `top` below `topBottom` means the bar is
// back on `top-0` (or lost the token); a z at or above `topZ` means it would paint OVER the topbar instead.
```

### Per-screen checks (each at every listed width; PASS = probes true + assertions)

**Sign-in `/sign-in`** (P1–P3, T, D; light + dark)
- G1, G2, G3, G7, G10. `?error=AccessDenied` alert wraps without overflow. Okta configured: `[data-sticky-action-bar]` holds "Continue with Okta" (`height ≥ 44`, width ≈ viewport − gutters) at P1–P3 and the in-card button is `display:none`; T/D: no bar, inline button. Okta not configured: no bar, disabled in-card button. Persona rows stack (button above badges) at P1–P3, each button as wide as the card. Persona submit lands on `/dashboard`.

**No-access `/no-access?from=/compliance/audit`** (as ops)
- G1, G2. Two 44 px buttons side by side; long email wraps (`break-all`). Exactly one `AUTHZ_DENIED path:/compliance/audit` row visible to compliance afterwards (behaviour unchanged).

**Dashboard `/dashboard` and queue page `/queues/operations`** (ops, cs, compliance, supervisor)
- G1–G5, G7, G10, G12, **G14** (tick two rows first — see the bulk-bar line below). Tabs per the persona matrix in §2; `aria-current="page"` on Dashboard; header "New ticket" hidden at P1–P3, visible at T/D. Topbar at P1–P3: brand + DEV LOGIN chip, no group chips, no avatar/sign-out.
- Counters: `[data-snap-row]` has `scrollWidth > clientWidth` while G1 passes; `el.scrollBy(300,0)` snaps to the next card; each card ≥ 85 % width; Stat links ≥ 44; "Breached" → `/queues/<slug>?slaStatus=BREACHED` (bare key). Leave the carousel on card 2 across one 30 s `AutoRefresh` tick → still on card 2.
- Filters: search visible, ≥ 44 tall, 16 px; `Filters` trigger badge equals chip count; open → `data-side="bottom"`, height ≈ 0.9 × innerHeight, grab handle present; toggle `Urgent` → `new URL(location).searchParams.getAll('priority')` → `['URGENT']` (no `[]`), sheet stays open, footer reads "Show N tickets" with N = list total; chip "Urgent" with an X appears; remove → param gone. T/D: trigger and chips `display:none`, inline bar visible.
- List (one `useReactTable`, two renderings — both always in the DOM, so count **and** visibility are asserted together; see the selector note above — the bare `[data-ticket-id]` selector also matches each row's `AssigneeSelect` trigger and would report 4× the real count):
  ```js
  (() => { const vis = el => !!el && getComputedStyle(el).display !== 'none';
    const list = document.querySelector('ol[aria-label="Tickets"]');
    return { cards: document.querySelectorAll('ol[aria-label="Tickets"] > li[data-ticket-id]').length,
             rows: document.querySelectorAll('tbody tr[data-ticket-id]').length,
             cardsVisible: vis(list), tableVisible: vis(document.querySelector('[data-slot=table-container]')?.parentElement) }; })()
  // expected at every width: cards === rows === Math.min(pageSize, total)
  //   P1–P3 → { cardsVisible: true,  tableVisible: false }
  //   T/D   → { cardsVisible: false, tableVisible: true }
  // run it on a NON-empty list: `rows.length === 0` renders the shared empty state instead of both
  // presentations, so all four values are 0/false and the visibility half of the assertion says nothing.
  ```
  SLA badge in the top-right of every card (`badge.right ≥ card.right − 20`); a BREACHED non-closed card carries `ring-destructive/40`; CLOSED card muted. Tapping the card body opens the preview; tapping **Open** navigates to `/tickets/<id>` **without** a preview request; changing the assignee from a card → toast, list re-renders (version increments — a second change does not CONFLICT). Pager buttons ≥ 44 at P1–P3, `page=2` in the URL.
- **Bulk bar (Wave B), top-sticky:** tick two rows → `[data-slice="B2-bulk-bar"]` appears between the filters and the list, `role="region"`, `aria-label="Bulk actions"`, count text `N selected`. Scroll to mid-list and run **G14**: its `getBoundingClientRect().top` is at or below the topbar's `bottom` and its z-index is under the topbar's 40 — it stays legible and every control (Assign to me, Status…, Priority…, Move to…, Follow, Clear) stays tappable while the board scrolls. It is `top-(--wm-topbar-h)`, never `top-0`; `top-0` is the defect this check exists for, and it reproduces at every width because the topbar is sticky at every width.
- **Preview = one view:** clear the network log; open a card → exactly **one** `GET /api/tickets/<id>/preview`; close, reopen → exactly one more. As compliance in a second tab: `TICKET_PREVIEWED` count for the ticket grows by exactly the number of opens, never from list renders or counter polls.
- Queue page: no queue badge on cards, no queue select in the sheet, `queueKey` absent from the URL.

**Ticket preview sheet** (open from a card at P1–P3; from a row at T/D)
- G1, G2, G6 (`bottom` / `right`), G11. Height 0.9 svh on phone; badges wrap; description and comments scroll inside the sheet (page `scrollY` unchanged); INTERNAL comments carry `data-visibility="INTERNAL"` with computed `border-left-width: 4px`; "Open ticket" ≥ 44, full width at P1–P3, inside the safe-area footer; X ≥ 44; Esc / overlay / X close and return focus to the card. T/D: `rect.left > 0`, `rect.height === innerHeight`, width 560.

**Ticket detail `/tickets/<id>`** (ops writer; cs on an Operations ticket = reader; a CLOSED ticket)
- G1–G5, G7, G10, G11, G12. P1–P3: badge row (SLA first) above the subject; description; timeline with amber internal notes and neutral public replies + disclaimer chip; **(Wave A)** the attachments panel below the timeline and the requester-history **sheet trigger** (≥ 44, full width) directly above the dock, with the inline requester-history panel `display:none` (it belongs to the md+ aside); PII indicator counts equal the DTO; inline composer and inline properties `display:none`; **(Wave A)** dock has ≥ 44 items and **five** of them for a writer — `[data-sticky-action-bar] > *` length `=== 5`: Back (href `/queues/<slug>`), Details, Actions, Note, Reply (Reply `aria-disabled="true"` for the reader, carrying its reason as an `sr-only` node named by `aria-describedby` — check `document.getElementById(document.querySelector('[data-sticky-action-bar] [aria-disabled=\"true\"]').getAttribute('aria-describedby')).textContent` is the composer's reason string, and that the bar's own height is unchanged; on CLOSED Reply disabled, Note enabled, and opening Note shows that same reason as visible text under the composer's `TabsList`). The count is conditional, not decorative: a CS reader on an Operations ticket with no move right sees **two** (Back, Details); a reader who can move sees three. Five is the ceiling — a sixth item is a defect, not a feature.
- Details → sheet with Status/Priority/Assignee/Queue Selects (`w-full`, ≥ 44) and the SLA block; change status → toast, sheet stays open, values update after the refresh; queue move confirm `AlertDialog` fits (`rect.width ≤ innerWidth − 32`, `rect.bottom ≤ innerHeight`).
- **(Wave A)** Actions → `height="auto"` sheet with a visible description, full-width ≥ 44 rows for **Assign to me** (absent when the ticket is already the viewer's) and **Record client contact**, then a **Move to queue** label + Select. Tapping *Record client contact* closes the Actions sheet **first** and opens the contact sheet at the top level — at no point are two `[data-slot=sheet-content]` elements on screen (`document.querySelectorAll('[data-slot=sheet-content]').length ≤ 1`). Assign to me → toast, sheet closes, the header/properties show the new assignee after the refresh, and exactly one `TICKET_ASSIGNED` row. For a viewer with neither write nor move rights the Actions item is absent (not disabled). `TicketQuickActions` renders **nothing** without the write right, so a move-only viewer's sheet holds the Move block alone; a write-only viewer gets the quick actions and, in place of the Select, a **read-only `QueueBadge`** carrying the current queue as text plus a visible plain-text reason ("Your groups cannot hand this ticket to another queue.", or "Closed tickets cannot be moved." on a CLOSED ticket) — never a disabled Select and never a `title`-only explanation (R10). Probe: inside the Actions sheet, `sheet.querySelector('[data-slot=select-trigger]') === null` and the reason sentence is in `innerText`.
- Note → sheet, Internal tab active, textarea inside the amber `[data-channel=INTERNAL]` frame, "Add internal note" sticky at the sheet bottom and ≥ 44; type text, dismiss by overlay tap, reopen → **draft still present**; submit → toast, sheet closes, timeline gains the note; ledger shows exactly one `COMMENT_ADDED_INTERNAL` and one `TICKET_VIEWED` (the refresh).
- **(Wave A)** Reply → Public tab active. **Nothing on this surface claims delivery** (CONTRACT §10 S3, CROSSWALK P16): the sticky submit row holds **Save reply to ticket** and, when the status can still reach Pending client, **Save reply and set Pending client** — both ≥ 44 and full width, both disabled until a disclaimer is selected **and** the ≥ 44 acknowledgement row is tapped. Tapping either opens the confirm dialog: it fits, "Keep editing" is the lower button, and the action reads **Save reply** (or **Save and set Pending client**). Confirm → toast **"Reply saved to the ticket"** (or **"Reply saved — ticket set to Pending client"**), then a second toast — "Queued for delivery to the client" on a ticket with a requester address, "No email address on file — this reply was recorded but will not be emailed" on a phone-only one (Decision #62), which the dialog body also states **before** the confirm. Disclaimer appended in the stored comment; "First response recorded" when applicable; the comment's own `DeliveryChip` (Queued → Sending → Sent / Failed) is the only place the word Sent may appear. A reviewer who sees "Send to client" or "Reply sent to client" anywhere is looking at pre-Wave-A code, not at a passing build.
- Macro: "Insert macro" opens a bottom sheet at P1–P3 (`data-side="bottom"`, Command input 16 px, items ≥ 44) and a popover at T/D; a pick inserts the rendered body, sets the disclaimer (public) and a `MACRO_APPLIED` row follows the comment.
- Wide GFM table in a description: the card scrolls internally, G1 passes. Exactly **one** `TICKET_VIEWED` per page render (initial load = 1; each mutation's refresh = +1).
- T: dock hidden, composer + properties inline (properties below); D: two columns, sticky aside.
- **Loading state (G13).** Throttle to Slow 3G and tap **Open** on a dashboard card: within 400 ms the ticket segment's `loading.tsx` skeleton is on screen (header / description / timeline blocks, `[aria-busy=true]`, one `role="status"` line, no ticket data in it) — the dashboard must NOT still be sitting there unchanged. Then, with the page rendered, the Attachments panel and the Requester-history panel each fill in behind their own `[aria-busy=true]` fallback rather than holding the whole page back; G1 passes with the skeletons on screen and the column does not jump when the real panel lands. Exactly **one** `TICKET_VIEWED` for the navigation — streaming a panel is not a second view, and neither panel writes an audit row.

**New ticket `/tickets/new`** (ops, advisor; compliance → `/no-access`)
- G1–G5, G7, G10. P1–P3: no bottom nav; `[data-sticky-action-bar]` holds Cancel + full-width Create (`type="submit"` — creating a ticket lands on `/tickets/<id>`); every Select/Input ≥ 44 and 16 px; description textarea 16 px; an SSN-shaped number in the description → redaction `toast.warning`; field errors visible above the bar. T/D: bar hidden, inline right-aligned buttons, two-column sections.

**Audit log `/compliance/audit`** (compliance; ops → `/no-access`)
- G1–G5, G7, G10, G11. P1–P3: header stacked, Verify chain / Export CSV in a 2-col grid (≥ 44); `Filters (n)` trigger; open → From/To `datetime-local` 16 px, Actions dropdown items ≥ 44, Entity/Ticket ≥ 44; Apply → URL `?action=TICKET_VIEWED&action=AUTHZ_DENIED` (bare keys), sheet closes, **one** new `AUDIT_LOG_VIEWED` (reload and diff `total`); Reset clears; chips reflect the applied query, removing one re-navigates (one more `AUDIT_LOG_VIEWED`). Cards: count equals `rows.length`, table `display:none`; card tap → dialog; "Open HD-n" inside a card navigates without opening the dialog; "Load more" ≥ 44 full width appends (`cursor=` in URL, first seq unchanged, `new Set([...document.querySelectorAll('[data-seq]')].map(e => e.dataset.seq)).size === count`). Verify chain → the Alert spans the full width under the buttons. Export anchor has `download` and the URL's query minus `cursor`. T/D: table visible, cards hidden, inline filters, G11 clean (this catches the fixed-id → `useId` migration).

**Audit row dialog** (P1–P3 and D)
- Dialog rect inside the viewport; internal scroll; old/new stacked at P1–P3, side by side from `sm`; hashes `break-all`; Close ≥ 44 and above the caption on phones; Esc closes; HD-n link keeps `prefetch={false}`.

**Account / Queues sheets** (P1–P3, every persona)
- Account: email, `[data-group]` count equals `viewer.groups.length`, `[data-dev-login]` present; theme buttons 3 × ≥ 44 with `aria-checked`, `<html class>` flips `dark`; Sign out ≥ 44 → `/sign-in` with one `USER_SIGNED_OUT`. Queues: one ≥ 48 px link per readable queue (3 for ops/advisor/compliance/supervisor, 2 for cs), `aria-current` on the current queue, navigating closes the sheet (no `[data-slot=sheet-content]` remains).
- **(Wave A) Admin block in the Account sheet** — the bottom bar still has **four or five tabs, never six**: `document.querySelectorAll('[data-bottom-nav] a,[data-bottom-nav] button').length ≤ 5` for every persona. Inside the sheet, the Admin entries match the §2 persona table — ops and supervisor: **Macros · Users · Held mail**; compliance: **Macros · Held mail**; advisor and cs: **no Admin label and no Admin buttons at all** (an empty heading is a defect). Each entry is a full-width ≥ 44 `<a href="/admin/…">`, tapping it navigates **and closes the sheet**, and the landing page renders rather than bouncing to `/no-access` (the sheet is convenience; `isPathAllowed` re-checks). At T/D the same entries appear as the sidebar's **Admin** section, in the same order — open both at 390 and at 1280 as ops and diff the labels.
- **(Wave A) Admin pages** (`/admin/macros`, `/admin/users`, `/admin/intake` as ops; `/admin/macros` and `/admin/intake` as compliance; advisor and cs are redirected to `/no-access?from=/admin/…` by the middleware, and compliance likewise on `/admin/users`; the page's own `notFound()` is the second gate and shows only if the first is ever bypassed) — G1–G3, G5, G7, G10, G11 at P1–P3 and D, plus one dark screenshot. These screens arrived after this file was written, so their per-screen assertions live with their own slices (the build record, `…/email-intake.md`, `…/foundation.md`); the global probes above are binding on them regardless. **(fix round 2)** Two checks are binding on all three: every search `<Input>` reserves `pr-12` for its 44 px clear button, and every `AlertDialogContent` that carries a form or a long consequence statement carries `max-h-[90svh] overflow-y-auto` — §4.6's recipe — because with `interactive-widget: "resizes-content"` an open keyboard leaves roughly 390x400 and an uncapped centred box puts its confirm button out of reach. `src/components/admin/admin-surface-probe.test.ts` asserts both, plus `min-w-11` on every filter chip. **(fix round 2)** A third is binding on `/admin/macros`: a `describeMacroActions` sentence is never rendered inside a `Badge`. The primitive is `inline-flex h-5 w-fit shrink-0 … whitespace-nowrap` and `[data-slot=badge]` is deliberately outside the phone rules in `globals.css`, so one sentence per badge ("Set the status to Pending client, when the state machine allows it") could neither wrap nor shrink and measured `documentElement.scrollWidth` 404 against `innerWidth` 390 — an R2/G1 failure at 360 and 390, passing only from 430 up. The sentences render as the same wrapping `<li>`s the composer's `MacroEffects` already used for the identical strings; the probe guards it by directory, because a Badge is for a label from a closed set, not for prose. **(fix round 1)** The dialog ceiling is binding on the TICKET surface too and was never applied there: the retraction confirm carries a required >= 12-character `Textarea` plus a three-clause consequence paragraph, so the keyboard is necessarily up while it is read, and at 390x400 it measured `maxHeight: none`, `overflowY: visible`, `scrollHeight === clientHeight` with "Keep the reply" clipped below the fold. The ceiling now lives in the `AlertDialogContent` primitive so a new dialog inherits it; `src/components/ticket/ticket-surface-probe.test.ts` asserts it on every ticket call site, and asserts that no file outside `src/components/ui/**` passes `data-slot=` to a shadcn primitive — `Button` sets `data-slot="button"` before spreading props, so an override silently removes the control from the 44 px phone rule (use `data-control` for a QA hook). The `min-w-11` chip assertion now covers `src/components/inbox/**` and `src/components/reports/**` as well, because the `/inbox` "All" chip shipped at 39x44 outside the admin-only map. `/admin/sla`'s auto-assignment rows are one `Label` whose `htmlFor` names the `Switch`, at least 44 px tall: `[data-slot=switch]` is deliberately NOT in the phone tap rule, because widening the track would break the thumb's `translate-x`. **Loading state (G13).** All three are `force-dynamic` renders that authenticate, authorize and query before their first byte, and on a phone they are reached from inside the Account sheet — so the tap closes the sheet and, with no boundary, nothing else changes until the server answers. `src/app/(app)/admin/loading.tsx` is that boundary for the whole section (one file covers all three and any route added later): throttle to Slow 3G, tap **Macros** in the Account sheet, and within 400 ms its skeleton is on screen — header / search / chips / three cards, `[aria-busy=true]`, one `role="status"` line, and no macro, account or mailbox data in it, because it paints before the RBAC gate has run. `src/app/(app)/admin/admin-loading.test.ts` guards the structure. **Held-mail count.** As ops or compliance with at least one `NEW` held message, the **Held mail** entry carries a count `Badge` in the Account sheet AND in the md+ sidebar, the two agree, and the number equals the intake page's default view; with an empty backlog neither shows one. `src/components/shell/admin-nav-badge.test.ts` and `nav-items.test.ts` pin the derivation (0 / absent / negative / NaN / Infinity produce no badge; 2.7 floors to 2; a count never reaches a viewer without `intake:review`).

### Regression suite

`npm run typecheck`, `npm run lint`, `npm test` (G1–G12 plus every existing suite), `npm run build`; then the ARCHITECTURE §k manual walk-through (one `TICKET_VIEWED`, one `TICKET_PREVIEWED`, `COMMENT_ADDED_*`, export precedes download) once at 390×844 and once at 1280×800. Static extras in review: `grep -rn "useMediaQuery(" src | grep -v "hooks/use-media-query.ts\|shell/responsive-sheet.tsx"` → empty; `grep -rn "persist(" src/components/ticket` → empty.

---

## (8) Decisions — where the proposals disagreed and why

- **D1 Sheet mechanism — hook-driven `side` (B) over CSS re-skin of a permanent bottom sheet (A).** A's ~25 `data-[side=bottom]:`/`md:data-[side=bottom]:` overrides work today but lie to QA (`data-side="bottom"` on desktop), re-implement shadcn's positioning recipe, and break silently on the next `shadcn add sheet`. R6 explicitly allows one shared hook for what CSS cannot express; a Radix `side` is that case. A's Header/Body/Footer helpers, `height`/`size` API and grab handle are kept.
- **D2 Card lists — bespoke cards (A) inside one container (B), not `flexRender` of table cells (B).** B's generic `MobileCardList` reuses `ColumnDef.cell`, but its primary "open" affordance is the number cell's inline text link (< 44 px, mis-tap-prone) and it cannot place an explicit Open button beside the assignee control without a fake column. A's card (body tap = preview, Open button = detail, SLA badge top-right) is the operator-correct design. B's structural point stands: the table and the cards live in the **same** `TicketTable`/`AuditTable`, share one `useReactTable`, one footer and one URL writer (R7) — no separate `TicketCardList` with its own pager.
- **D3 Bottom nav on ticket routes — hidden (A), not stacked above a second bar (B).** Two bars cost 18 % of a 360×800 screen and put a "New" tab under the New form. The dock's first item is a deterministic back link to the ticket's queue.
- **D4 Composer drafts survive sheet dismissal — memory-only zustand store (A); B accepted the loss as a follow-up.** Losing a half-written client reply to an overlay brush is real operator pain; the store is ~30 lines. Guardrail: no `persist(` under `src/components/ticket`.
- **D5 Sign-in sticky CTA — yes when Okta is configured (A); B argued the fold was enough.** The brief lists sign-in under "sticky submit on phones"; a disabled sticky CTA when Okta is unconfigured is noise, so it is conditional.
- **D6 Audit active-filter chips — rendered from the applied query, removal navigates (B); A omitted them.** The brief requires removable chips on every filter surface; a chip removal is an explicit commit, consistent with the Apply model.
- **D7 Audit row dialog — stays centered (B); A made it a bottom-anchored 92 svh panel.** The brief only requires dialogs to fit; the current `max-w-[calc(100%-2rem)] max-h-[90svh] overflow-y-auto` already does, and A's `translate-*` override recipe is more code to break.
- **D8 No `overflow-x-clip` on the shell root (B); A added it.** Clipping masks the very overflow the G1 probe exists to catch; fix overflow at its source.
- **D9 Reduced motion — one universal rule (B) over A's targeted selector list.** Same effect, canonical form, no list to maintain; spinners deliberately go static.
- **D10 Toaster — no hook (neither).** A used `useMediaQuery` for Sonner's `position`; Sonner already renders toasts full-width at the top below 600 px, so `mobileOffset` alone clears the compact topbar. This keeps the hook's consumers to exactly `ResponsiveSheet`/`ResponsivePopover`.
- **D11 Tokens — 56 px bar (B) with one shared token for nav and dock (A).** `--wm-bottom-bar-h` replaces A's `--wm-bottom-nav-h` + B's separate `--wm-action-bar-h`; the bars are mutually exclusive per route.
- **D12 `navItemsFor` / `isActivePath` (B).** One derivation for sidebar and bottom nav; A left the sidebar untouched and re-derived in `BottomNav`.
- **D13 Tap rule details (B): `:where()` selector list, `data-tap="none"` opt-out, Checkbox `::after` hit area, `font-size: max(1rem, 1em)` on all text controls; A's `[data-responsive-sheet]{max-height}` and sheet-close nudge kept.**
- **D14 Filter sheet footers — dashboard "Show N tickets" (A, needs `total?` on `TicketFilters`); audit "Reset / Apply filters" (both).**
- **D15 Sheet height 90 svh (brief) rather than A's 92 svh.**
- **D16 Topbar `shortText` banners + `pt-safe` (A).**
- **D17 `useMediaQuery` lives in `src/hooks/` (B; the `@/hooks` alias already exists) with enumerated consumers.**
- **D18 Macro picker — `ResponsivePopover` (B) rather than A's two CSS-toggled triggers with two Radix roots.**
- **D19 `AssigneeSelect` — class change `md:max-w-64` (B) instead of a new `className` prop (A).** Signature stays frozen.
- **D20 `MobileCard` puts controls outside the `role="button"` region (neither proposal).** Both nested Selects/links inside the tappable body (as the table rows do today). Cards are new markup, so they get valid semantics from day one.
- **D21 Duplicate-id fixes (B) applied wherever two instances coexist on phone:** `DisclaimerPreview`, `AuditFilterFields`, `PropertiesPanel`'s SLA heading.
- **D22 QA fact correction (neither):** `supervisor` is ops+cs+advisors, not dual-role; both proposals assumed otherwise. Dual-role checks are hand-session-only.

### Risks carried forward

- Both presentations render at all widths (`display:none` hides one): React work and `SlaBadge` 30 s intervals double per row. Keep default pageSize 50; measure at 200 during QA; gate with `content-visibility` if needed — never with a JS breakpoint.
- iOS keyboard vs `svh`: Safari does not shrink `svh` when the keyboard opens; the composer's sticky submit row can sit under the keyboard. Test at 390×844 with the keyboard up; fallback is `h-[min(90svh,calc(100dvh-1rem))]` on the composer sheet only.
- Nested Radix layers on phone reach three (composer sheet → macro sheet / send confirm; details sheet → move confirm). Verify no lingering `pointer-events: none` on `<body>` after closing the inner layer on iOS Safari and Android Chrome; `radix-ui` is pinned at 1.6.7 in the lockfile.
- The global tap rule also affects narrow desktop windows (< 768 px) — intended mobile-first behaviour; documented in ARCHITECTURE §g S4.
- Tooltip-only information (SLA due detail, PII explanation, disabled-tab reasons) never appears on touch; the Details sheet, badge text, Account sheet and dock `title`s cover the required cases; converting `SlaBadge`/`PiiIndicator` tooltips into tap popovers is a follow-up.
- No e2e harness exists (vitest, `.test.ts`, node environment). §7 is executed manually with the browser tools; adding Playwright to CI is a new dependency and out of scope.
- The concurrent fix pack may touch `topbar.tsx`, `ticket-filters.tsx`, `ticket-table.tsx`, `composer.tsx`, `audit-table.tsx`. Rebase first; the fix pack's signatures win.

---

## Appendix — Judgment of the two proposals

**Proposal A — "Operator UX first": 84/100.**
Strengths: every signature and class recipe verified against the real shadcn sources; thumb-first decisions (body tap = preview, explicit Open, SLA badge top-right, dock with back item, sticky Okta CTA, 44 px acknowledgement row); the composer draft store; `FilterSheet`/`FilterSection`/`ActiveFilterChips`/`SNAP_ROW_CLASSES` primitives; a QA plan with concrete probes and audit-count assertions; a genuinely useful risk list (iOS keyboard vs svh, nested Radix layers, `persist` guardrail, `viewport-fit`). Weaknesses (−16): the CSS-only `ResponsiveSheet` re-skin is fragile and lies about `data-side`; a `useMediaQuery` consumer for the Toaster that Sonner makes unnecessary; a separate `TicketCardList` duplicating the pager (a second URL writer); `overflow-x-clip` on the root masks the overflow probe; no removable chips on the audit surface (brief requirement); 92 svh vs the brief's 90; controls nested inside the card's `role="button"`; assumed the supervisor persona is dual-role.

**Proposal B — "Engineering, minimal-diff first": 78/100.**
Strengths: the single-flip discipline and the `md`-is-desktop framing; `navItemsFor`; the best CSS block (`:where` list, `data-tap` opt-out, Checkbox hit area, `max(1rem,1em)`, `@utility` helpers, universal reduced motion); `viewport.interactiveWidget`; `useId` fixes for duplicate ids; honest limits (no e2e, `md` band density, "don't clip body"); a hook-driven `ResponsiveSheet` that keeps shadcn's recipe intact. Weaknesses (−22): the generic `flexRender` card makes the number cell's sub-44 inline link the primary open affordance and cannot host an Open button; no sticky sign-in CTA (brief requirement); drafts lost on sheet dismissal; two stacked bottom bars on ticket detail (≈18 % of a 360×800 screen) and no back affordance; controls nested in `role="button"` cards; the same supervisor assumption.

**Synthesis:** A's navigation model, primitives set, per-screen UX and QA structure are the spine; B supplies the sheet mechanism, the nav-items helper, the CSS details, the single-container list structure, the id hygiene and the "no clipping" rule.
