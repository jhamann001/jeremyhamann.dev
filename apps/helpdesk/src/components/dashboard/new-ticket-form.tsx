"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, LoaderCircle, PhoneCall, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type {
  ActionError,
  AssigneeOption,
  CreateTicketInput,
  QueueKey,
  TicketCategory,
  TicketPriority,
  Viewer,
} from "@/types/domain";
import { CATEGORY_LABELS, QUEUE_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/types/domain";
import { PRIORITY_LABELS, formatTicketNumber } from "@/lib/format";
import { creatableQueues } from "@/lib/rbac";
import { routeCategory } from "@/lib/routing";
import { createTicket, recordClientContact } from "@/server/tickets.actions";
import { logCall } from "@/server/log-call.actions";
import {
  LOG_CALL_CHANNELS,
  LOG_CALL_CHANNEL_LABELS,
  contactChannelFor,
  contactErrorsFor,
  defaultCategoryForChannel,
  type LogCallChannel,
} from "@/lib/log-call";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { StickyActionBar } from "@/components/shell/sticky-action-bar";
import { NewTicketDuplicateWarning } from "@/components/ticket/links/duplicate-candidates";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { cn } from "@/lib/utils";
import { demoTextMax } from "@/lib/demo/mode";

// Shorter in the public demo (src/lib/demo/mode.ts), as the server's schemas are.
const TEXT_MAX = demoTextMax(20_000);

/** Radix Select forbids an empty-string item value; "nobody" travels under a sentinel. */
const NONE = "__none__";
const DEFAULT_CATEGORY: TicketCategory = "OTHER";

type FieldErrors = Record<string, string[]>;

/**
 * Resolves on the next macrotask, after Next's router has retired the just-finished server action from its
 * dispatch queue. The router resolves the caller of a server action BEFORE that action leaves the queue
 * (`server-action-reducer`: `resolve(actionResult)` then `return state`, both in the same microtask), so a
 * `router.push` issued straight from the awaiting code finds the action still `pending`; `dispatchAction`
 * treats a navigation that interrupts a pending server action as a stale-data hazard — it discards the
 * action and sets `needsRefresh`, and once the navigation lands it dispatches an `ACTION_REFRESH` of the
 * destination. For a ticket page that is a second audited render: two `TICKET_VIEWED` rows for one create
 * (invariant I3). Microtasks always drain before a timer fires, so one
 * macrotask hop is a deterministic "queue is empty" boundary; the push stays inside the transition so the
 * form remains busy until the new page renders.
 */
function afterRouterQueueDrains(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function FieldError({ id, messages }: { id: string; messages: string[] | undefined }): React.JSX.Element | null {
  if (!messages || messages.length === 0) return null;
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {messages.join(" ")}
    </p>
  );
}

/**
 * New-ticket form, with the **log-a-call** variant.
 *
 * The category drives the routed queue / default priority (`routeCategory`); overrides are limited
 * to `creatableQueues(viewer.groups)`. Only values that differ from the routed defaults are sent, so
 * `createTicket` audits a TICKET_PRIORITY_CHANGED row exactly when the operator actually overrode the
 * default. Server-side zod `fieldErrors` are mapped back onto the inputs.
 *
 * **The channel selector is the whole variant.** One form, four channels, and the channel decides three
 * things that used to be assumptions:
 *
 *  1. **`Ticket.source`.** A ticket raised from a call is not a staff-form ticket, and until the source
 *     column was populated every report answered "where does our work come from" with "the web form".
 *  2. **Whether an email address is required.** Decision #62 made `requesterEmail` nullable for exactly
 *     this case: a caller the desk has never emailed has a phone number and nothing else, and the old
 *     form forced the associate to invent an address to get past validation. The DB CHECK
 *     `ticket_requester_contact_present` still demands one of the two, and so does the form.
 *  3. **Which server action runs.** The web form keeps the S5 path (`createTicket`, with its assignee
 *     select); the three call channels go through `logCall`, which calls the same `createTicketCore`
 *     every machine channel uses. Nothing is duplicated — the routing, the SLA stamping and the PII
 *     pass are one implementation.
 *
 * "The client was reached on this call" is a SECOND action (`recordClientContact`), run
 * after the ticket exists and audited in its own right, because it stamps `firstRespondedAt`. If it
 * fails, the ticket still exists and the form says so rather than pretending the call was unrecorded.
 *
 * B2's `NewTicketDuplicateWarning` is mounted under the requester fields: the moment the associate has
 * typed an address or a number, "this person already has something open" is the question worth
 * answering — before a second ticket for the same request exists.
 */
export function NewTicketForm({
  viewer,
  assigneesByQueue,
}: {
  viewer: Viewer;
  assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>>;
}): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const uid = useId();

  const creatable = creatableQueues(viewer.groups);

  const [channel, setChannel] = useState<LogCallChannel>("WEB_FORM");
  const [category, setCategory] = useState<TicketCategory>(DEFAULT_CATEGORY);
  const [queueOverride, setQueueOverride] = useState<QueueKey | undefined>(undefined);
  const [priorityOverride, setPriorityOverride] = useState<TicketPriority | undefined>(undefined);
  const [assigneeId, setAssigneeId] = useState<string>(NONE);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [requesterPhone, setRequesterPhone] = useState("");
  const [clientReference, setClientReference] = useState("");
  const [reached, setReached] = useState(false);
  const [contactNote, setContactNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Idempotency key for `logCall`, minted on the first submit and kept until one succeeds. A double
   * tap, a flaky connection or a retried transition replays the SAME ticket through the receipt
   * `createTicketCore` writes, instead of raising a second one for the same call.
   */
  const requestIdRef = useRef<string | null>(null);
  const requestId = (): string => {
    requestIdRef.current ??= globalThis.crypto.randomUUID();
    return requestIdRef.current;
  };

  const isCall = channel !== "WEB_FORM";

  const routed = routeCategory(category);
  const routedCreatable = creatable.includes(routed.queueKey);
  // When the routed queue is not one the viewer may create into, the first creatable queue is the
  // effective default and the form says so — otherwise the server would answer FORBIDDEN.
  const effectiveQueue: QueueKey | undefined = queueOverride ?? (routedCreatable ? routed.queueKey : creatable[0]);
  const effectivePriority: TicketPriority = priorityOverride ?? routed.priority;
  const assignees = effectiveQueue ? (assigneesByQueue[effectiveQueue] ?? []) : [];
  const assigneeValid = assigneeId === NONE || assignees.some((a) => a.id === assigneeId);

  const onCategoryChange = (value: string) => {
    if (!(TICKET_CATEGORIES as readonly string[]).includes(value)) return;
    setCategory(value as TicketCategory);
    setQueueOverride(undefined);
    setPriorityOverride(undefined);
    setAssigneeId(NONE);
  };

  const onQueueChange = (value: string) => {
    if (!creatable.includes(value as QueueKey)) return;
    setQueueOverride(value as QueueKey);
    setAssigneeId(NONE);
  };

  /**
   * Switching channel re-seeds the category (a voicemail is a callback until told otherwise) and drops
   * the overrides, so the routed queue and priority follow. The typed content is NEVER cleared: an
   * associate who has written three sentences and then realises they picked the wrong channel must not
   * lose them.
   */
  const onChannelChange = (next: LogCallChannel) => {
    if (next === channel) return;
    setChannel(next);
    setCategory(defaultCategoryForChannel(next));
    setQueueOverride(undefined);
    setPriorityOverride(undefined);
    setAssigneeId(NONE);
    if (next === "WEB_FORM") {
      setReached(false);
      setContactNote("");
    }
    setErrors({});
  };

  const ids = {
    channel: `${uid}-channel`,
    category: `${uid}-category`,
    queue: `${uid}-queue`,
    priority: `${uid}-priority`,
    assignee: `${uid}-assignee`,
    subject: `${uid}-subject`,
    description: `${uid}-description`,
    requesterName: `${uid}-requester-name`,
    requesterEmail: `${uid}-requester-email`,
    requesterPhone: `${uid}-requester-phone`,
    clientReference: `${uid}-client-reference`,
    reached: `${uid}-reached`,
    contactNote: `${uid}-contact-note`,
  };
  const errId = (k: keyof typeof ids) => `${ids[k]}-error`;

  function applyError(err: ActionError) {
    switch (err.code) {
      case "VALIDATION": {
        const fe = err.fieldErrors ?? {};
        setErrors(fe);
        const form = fe._form?.join(" ");
        setFormError(form ?? (Object.keys(fe).length === 0 ? err.message : null));
        toast.error(form ?? "Please correct the highlighted fields");
        return;
      }
      case "FORBIDDEN":
        setFormError(`You are not allowed to create tickets in ${effectiveQueue ? QUEUE_LABELS[effectiveQueue] : "this queue"}.`);
        toast.error(err.message);
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "NOT_FOUND":
      case "CONFLICT":
      case "INTERNAL":
        setFormError("The ticket could not be created. Nothing was saved.");
        toast.error(err.message);
        return;
    }
  }

  /** Shared tail: the redaction warning, the toast, the counter refresh and the single navigation. */
  async function finish(id: string, number: number, pii: { redacted: boolean; count: number }, extra?: string) {
    if (pii.redacted) {
      toast.warning(
        `Sensitive numbers were redacted before saving (${pii.count} ${pii.count === 1 ? "item" : "items"})`,
      );
    }
    toast.success(`${formatTicketNumber(number)} created${extra ?? ""}`);
    void queryClient.invalidateQueries({ queryKey: ["queue-summary"] });
    // Exactly one navigation → exactly one TICKET_VIEWED. See afterRouterQueueDrains.
    await afterRouterQueueDrains();
    router.push(`/tickets/${id}`);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!effectiveQueue) return;
    setErrors({});
    setFormError(null);

    const email = requesterEmail.trim();
    const phone = requesterPhone.trim();

    // The SAME function the server's schema refines on, so the browser refuses what the server would
    // refuse, in the same words, without a round trip.
    const contactErrors = contactErrorsFor(channel, email, phone);
    if (Object.keys(contactErrors).length > 0) {
      setErrors(contactErrors);
      toast.error("Please correct the highlighted fields");
      return;
    }
    if (reached && contactNote.trim() === "") {
      setErrors({ contactNote: ["Say what was discussed — this note is the desk's record of the call"] });
      toast.error("Please correct the highlighted fields");
      return;
    }

    if (isCall) {
      startTransition(async () => {
        const result = await logCall({
          channel,
          subject: subject.trim(),
          description,
          category,
          requesterName: requesterName.trim(),
          requesterEmail: email === "" ? null : email,
          requesterPhone: phone === "" ? null : phone,
          clientReference: clientReference.trim() === "" ? null : clientReference.trim(),
          requestId: requestId(),
          ...(effectiveQueue !== routed.queueKey ? { queueKey: effectiveQueue } : {}),
          ...(effectivePriority !== routed.priority ? { priority: effectivePriority } : {}),
        });
        if (!result.ok) {
          applyError(result);
          return;
        }
        requestIdRef.current = null;
        const { id, number, version, piiRedacted, piiRedactionCount } = result.data;

        // A SECOND, separately audited act: it stamps firstRespondedAt, so it is never folded into the
        // create. A failure here leaves the ticket standing and says so — the call is still loggable
        // from the ticket page, and a silent failure would look like an answered ticket that was not.
        let contactNoteFailed = false;
        const contactChannel = contactChannelFor(channel);
        if (reached && contactChannel !== null) {
          const contact = await recordClientContact({
            ticketId: id,
            version,
            channel: contactChannel,
            note: contactNote.trim(),
          });
          contactNoteFailed = !contact.ok;
        }
        if (contactNoteFailed) {
          toast.warning("The ticket was created, but the contact note was not recorded. Add it from the ticket.");
        }
        await finish(id, number, { redacted: piiRedacted, count: piiRedactionCount }, reached && !contactNoteFailed ? " · contact recorded" : undefined);
      });
      return;
    }

    const input: CreateTicketInput = {
      subject: subject.trim(),
      description,
      category,
      requesterName: requesterName.trim(),
      requesterEmail: email,
    };
    const ref = clientReference.trim();
    if (ref.length > 0) input.clientReference = ref;
    if (assigneeId !== NONE) input.assigneeId = assigneeId;
    if (effectiveQueue !== routed.queueKey) input.queueKey = effectiveQueue;
    if (effectivePriority !== routed.priority) input.priority = effectivePriority;

    startTransition(async () => {
      const result = await createTicket(input);
      if (!result.ok) {
        applyError(result);
        return;
      }
      const { id, number, piiRedacted, piiRedactionCount } = result.data;
      await finish(id, number, { redacted: piiRedacted, count: piiRedactionCount });
    });
  }

  if (creatable.length === 0 || !effectiveQueue) {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden />
        <AlertTitle>No queue accepts tickets from your groups</AlertTitle>
        <AlertDescription>Contact compliance to request access.</AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5" aria-busy={pending || undefined}>
      {formError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>Ticket not created</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Channel. A button group rather than a Select: it is the first decision on the form, it has four
          options, and on a phone a visible group is one tap where a Select is three. */}
      <section className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <span id={ids.channel} className="text-sm font-medium">
          How did this reach us?
        </span>
        <div role="group" aria-labelledby={ids.channel} className="flex flex-wrap gap-2">
          {LOG_CALL_CHANNELS.map((c) => (
            <Button
              key={c}
              type="button"
              variant={c === channel ? "default" : "outline"}
              aria-pressed={c === channel}
              disabled={pending}
              onClick={() => onChannelChange(c)}
              className="min-h-11 flex-1 sm:flex-none"
            >
              {c === "WEB_FORM" ? null : <PhoneCall aria-hidden className="size-4" />}
              {LOG_CALL_CHANNEL_LABELS[c]}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {isCall
            ? "Logged as a call: an email address is optional, a phone number is enough. Logged calls go to the queue — assign from the board."
            : "The standard form. The requester's email address is required so replies reach them."}
        </p>
      </section>

      <section className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={ids.category}>Category</Label>
          <Select value={category} onValueChange={onCategoryChange} disabled={pending}>
            <SelectTrigger id={ids.category} className="w-full md:max-w-sm" aria-invalid={errors.category ? true : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {TICKET_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError id={errId("category")} messages={errors.category} />
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            Routes to <QueueBadge queueKey={routed.queueKey} /> · default <PriorityBadge priority={routed.priority} />
            {effectiveQueue !== routed.queueKey || effectivePriority !== routed.priority ? (
              <>
                <ArrowRight aria-hidden className="size-3" />
                <span>creating in</span>
                <QueueBadge queueKey={effectiveQueue} />
                <span>as</span>
                <PriorityBadge priority={effectivePriority} />
              </>
            ) : null}
          </p>
          {!routedCreatable ? (
            <p className="text-xs text-amber-800 dark:text-amber-200">
              Your groups cannot create tickets in {QUEUE_LABELS[routed.queueKey]}; it will be created in{" "}
              {QUEUE_LABELS[effectiveQueue]} instead.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.queue}>Queue</Label>
          <Select value={effectiveQueue} onValueChange={onQueueChange} disabled={pending || creatable.length === 1}>
            <SelectTrigger id={ids.queue} className="w-full" aria-invalid={errors.queueKey ? true : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {creatable.map((q) => (
                <SelectItem key={q} value={q}>
                  {QUEUE_LABELS[q]}
                  {q === routed.queueKey ? <span className="text-muted-foreground"> (routed)</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError id={errId("queue")} messages={errors.queueKey} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.priority}>Priority</Label>
          <Select
            value={effectivePriority}
            onValueChange={(v) => {
              if ((TICKET_PRIORITIES as readonly string[]).includes(v)) setPriorityOverride(v as TicketPriority);
            }}
            disabled={pending}
          >
            <SelectTrigger id={ids.priority} className="w-full" aria-invalid={errors.priority ? true : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {TICKET_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                  {p === routed.priority ? <span className="text-muted-foreground"> (default)</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError id={errId("priority")} messages={errors.priority} />
        </div>

        <div className={cn("flex flex-col gap-1.5 md:col-span-2", isCall && "hidden")}>
          <Label htmlFor={ids.assignee}>Assignee</Label>
          <Select value={assigneeValid ? assigneeId : NONE} onValueChange={setAssigneeId} disabled={pending}>
            <SelectTrigger id={ids.assignee} className="w-full md:max-w-sm" aria-invalid={errors.assigneeId ? true : undefined}>
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={NONE}>
                <UserAvatar user={null} size="sm" />
              </SelectItem>
              {assignees.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <UserAvatar user={a} size="sm" />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError id={errId("assignee")} messages={errors.assigneeId} />
          <p className="text-xs text-muted-foreground">Only staff who can work {QUEUE_LABELS[effectiveQueue]} are listed.</p>
        </div>
      </section>

      <section className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.requesterName}>Requester name</Label>
          <Input
            id={ids.requesterName}
            value={requesterName}
            onChange={(e) => setRequesterName(e.target.value)}
            required
            maxLength={120}
            autoComplete="off"
            aria-invalid={errors.requesterName ? true : undefined}
            aria-describedby={errors.requesterName ? errId("requesterName") : undefined}
            disabled={pending}
          />
          <FieldError id={errId("requesterName")} messages={errors.requesterName} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.requesterEmail}>
            Requester email{" "}
            {isCall ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
          </Label>
          <Input
            id={ids.requesterEmail}
            type="email"
            value={requesterEmail}
            onChange={(e) => setRequesterEmail(e.target.value)}
            required={!isCall}
            autoComplete="off"
            inputMode="email"
            aria-invalid={errors.requesterEmail ? true : undefined}
            aria-describedby={errors.requesterEmail ? errId("requesterEmail") : undefined}
            disabled={pending}
          />
          <FieldError id={errId("requesterEmail")} messages={errors.requesterEmail} />
        </div>
        <div className={cn("flex flex-col gap-1.5", !isCall && "hidden")}>
          <Label htmlFor={ids.requesterPhone}>
            Requester phone <span className="font-normal text-muted-foreground">(E.164)</span>
          </Label>
          <Input
            id={ids.requesterPhone}
            type="tel"
            value={requesterPhone}
            onChange={(e) => setRequesterPhone(e.target.value)}
            autoComplete="off"
            inputMode="tel"
            placeholder="+14155550123"
            aria-invalid={errors.requesterPhone ? true : undefined}
            aria-describedby={cn(`${ids.requesterPhone}-hint`, errors.requesterPhone ? errId("requesterPhone") : undefined)}
            disabled={pending}
          />
          <FieldError id={errId("requesterPhone")} messages={errors.requesterPhone} />
          <p id={`${ids.requesterPhone}-hint`} className="text-xs text-muted-foreground">
            A phone number is enough on its own — the country code is never assumed, so type it in full.
          </p>
        </div>
        {/* B2's duplicate warning, under the requester fields: the moment there is an address or a
            number, "this person already has something open" is the question worth answering. */}
        <div className="md:col-span-2">
          <NewTicketDuplicateWarning
            requesterEmail={requesterEmail.trim() === "" ? null : requesterEmail.trim()}
            requesterPhone={requesterPhone.trim() === "" ? null : requesterPhone.trim()}
            subject={subject}
          />
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={ids.clientReference}>
            Client reference <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={ids.clientReference}
            value={clientReference}
            onChange={(e) => setClientReference(e.target.value)}
            maxLength={200}
            autoComplete="off"
            placeholder="Household or CRM reference — never an account number"
            aria-invalid={errors.clientReference ? true : undefined}
            aria-describedby={errors.clientReference ? errId("clientReference") : undefined}
            disabled={pending}
            className="md:max-w-sm"
          />
          <FieldError id={errId("clientReference")} messages={errors.clientReference} />
        </div>
      </section>

      <section className="grid gap-4 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.subject}>Subject</Label>
          <Input
            id={ids.subject}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            minLength={3}
            maxLength={200}
            autoComplete="off"
            aria-invalid={errors.subject ? true : undefined}
            aria-describedby={errors.subject ? errId("subject") : undefined}
            disabled={pending}
          />
          <FieldError id={errId("subject")} messages={errors.subject} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.description}>Description</Label>
          <Textarea
            id={ids.description}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            maxLength={TEXT_MAX}
            rows={8}
            // 16px on phones; the mono 13px density returns at md
            className="min-h-40 leading-relaxed md:font-mono md:text-[13px]"
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={cn(`${ids.description}-hint`, errors.description ? errId("description") : undefined)}
            disabled={pending}
          />
          <FieldError id={errId("description")} messages={errors.description} />
          <p id={`${ids.description}-hint`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
            Numbers matching SSN, card or account-number formats are redacted before saving.
          </p>
        </div>
      </section>

      {/* "The client was reached on this call" — a SECOND audited act, not a field on the create. */}
      {isCall ? (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-start gap-3">
            <Checkbox
              id={ids.reached}
              checked={reached}
              onCheckedChange={(v) => setReached(v === true)}
              disabled={pending}
              className="mt-0.5"
            />
            <Label htmlFor={ids.reached} className="flex-1 font-normal leading-snug">
              The client was reached on this call
              <span className="block text-xs text-muted-foreground">
                Records an internal note and credits the contact as the first response, so a returned
                call does not read as an unanswered ticket.
              </span>
            </Label>
          </div>
          {reached ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.contactNote}>What was discussed</Label>
              <Textarea
                id={ids.contactNote}
                value={contactNote}
                onChange={(e) => setContactNote(e.target.value)}
                maxLength={TEXT_MAX}
                rows={4}
                className="min-h-24 leading-relaxed"
                aria-invalid={errors.contactNote ? true : undefined}
                aria-describedby={cn(
                  `${ids.contactNote}-hint`,
                  errors.contactNote ? errId("contactNote") : undefined,
                )}
                disabled={pending}
              />
              <FieldError id={errId("contactNote")} messages={errors.contactNote} />
              <p id={`${ids.contactNote}-hint`} className="text-xs text-muted-foreground">
                Internal only — the client never sees this note.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* md+: inline, right-aligned actions */}
      <div className="hidden md:flex md:items-center md:justify-end md:gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          {pending ? "Creating…" : "Create ticket"}
        </Button>
      </div>

      {/* Phone: sticky "Cancel · Create ticket" bar INSIDE the form (position:fixed keeps form association, so
          the submit child submits). The bottom tab bar is hidden on /tickets/** (docs/MOBILE_FIRST.md §2, §4.4). */}
      <StickyActionBar label="Create ticket">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={pending}>
          {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          {pending ? "Creating…" : "Create ticket"}
        </Button>
      </StickyActionBar>
    </form>
  );
}
