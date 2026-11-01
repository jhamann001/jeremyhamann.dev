"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import type { ApiTokenScope, ApiTokenSecret, CreateApiTokenInput } from "@/types/domain";
import { API_TOKEN_SCOPES, API_TOKEN_SCOPE_LABELS } from "@/types/domain";
import { createApiToken } from "@/server/api-tokens.actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ResponsiveSheet, ResponsiveSheetBody, ResponsiveSheetFooter } from "@/components/shell/responsive-sheet";

/**
 * Issue a credential (R1–R12).
 *
 * A bottom sheet on phones and a 560 px side sheet from `md`, like every other form in this app.
 *
 * Two things the form says out loud rather than leaving to a runbook:
 *  - **what each scope opens.** A scope list is the whole security decision on this screen, and
 *    "INTEGRATION_INGEST" means nothing to somebody being asked to tick it at 4pm.
 *  - **that the token appears once.** The panel that shows it says so too, but by then the decision
 *    has been made; saying it before the button is pressed is what stops the tab being closed.
 *
 * Validation lives on the server (`createApiToken`). This form mirrors the *shape* — a name, at least
 * one scope — so the common mistakes are caught without a round trip, and shows the server's field
 * errors when it disagrees, which it is entitled to do.
 */

/** One line per scope, in the operator's words. Keys are the enum, so a new scope fails the typecheck. */
const SCOPE_HELP: Readonly<Record<ApiTokenScope, string>> = {
  CLIENT_READ: "Read a client's own tickets through /api/client (the client app's backend).",
  CLIENT_WRITE: "Open tickets and post client messages through /api/client.",
  INTEGRATION_INGEST: "Create tickets and messages through /api/ingest (email intake, n8n).",
  INTEGRATION_OUTBOX: "Lease and report outbound messages through /api/integrations/outbox.",
  EXPORT_READ: "Read the ticket export feed through /api/export.",
  MCP: "Act as you through the MCP agent surface: read the desk and add internal notes.",
};

export type CreateTokenSheetProps = { onCreated: (secret: ApiTokenSecret) => void };

export function CreateTokenSheet({ onCreated }: CreateTokenSheetProps): React.JSX.Element {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiTokenScope[]>([]);
  const [requesterEmail, setRequesterEmail] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const clientScoped = scopes.includes("CLIENT_READ") || scopes.includes("CLIENT_WRITE");

  function reset(): void {
    setName("");
    setScopes([]);
    setRequesterEmail("");
    setExpiresAt("");
    setNote("");
    setFieldErrors({});
  }

  function toggleScope(scope: ApiTokenScope, on: boolean): void {
    setScopes((current) => (on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)));
  }

  function submit(): void {
    setFieldErrors({});
    if (name.trim().length === 0) {
      setFieldErrors({ name: ["Give the credential a name — whoever holds it, and what for."] });
      return;
    }
    if (scopes.length === 0) {
      setFieldErrors({ scopes: ["A credential with no scope can do nothing. Pick at least one."] });
      return;
    }

    startTransition(async () => {
      const input: CreateApiTokenInput = {
        name: name.trim(),
        scopes,
        ...(clientScoped && requesterEmail.trim().length > 0 ? { requesterEmail: requesterEmail.trim() } : {}),
        // A date input gives `YYYY-MM-DD`; the server reads it as the start of that day.
        ...(expiresAt.trim().length > 0 ? { expiresAt: expiresAt.trim() } : {}),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      };
      const result = await createApiToken(input);

      if (result.ok) {
        onCreated(result.data);
        toast.success(`${result.data.token.name} issued`);
        setOpen(false);
        reset();
        router.refresh();
        return;
      }

      switch (result.code) {
        case "VALIDATION":
          setFieldErrors(result.fieldErrors ?? {});
          toast.error(result.message);
          return;
        case "FORBIDDEN":
          toast.error("You do not have permission to issue API tokens.");
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "CONFLICT":
          toast.warning("That did not save — try again.");
          return;
        case "NOT_FOUND":
        case "INTERNAL":
          toast.error("The credential was not issued. Nothing was recorded.");
          return;
      }
    });
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="w-full md:w-auto">
        <Plus aria-hidden />
        New token
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={(next) => (pending ? undefined : setOpen(next))}
        title="New API token"
        description="A per-consumer credential. The token itself is shown once, when it is issued."
        size="lg"
        height="full"
      >
        <ResponsiveSheetBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-name`}>Name</Label>
            <Input
              id={`${formId}-name`}
              value={name}
              maxLength={120}
              autoComplete="off"
              placeholder="n8n — email intake"
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              aria-describedby={fieldErrors.name ? `${formId}-name-error` : undefined}
            />
            <FieldError id={`${formId}-name-error`} messages={fieldErrors.name} />
            <p className="text-xs text-muted-foreground">
              Who holds it and what for. Read by every administrator — no client names.
            </p>
          </div>

          <fieldset className="flex flex-col gap-3" aria-describedby={fieldErrors.scopes ? `${formId}-scopes-error` : undefined}>
            <legend className="text-sm font-medium">Scopes</legend>
            {API_TOKEN_SCOPES.map((scope) => {
              const id = `${formId}-scope-${scope}`;
              return (
                // 44 px tap area: the whole label row toggles the checkbox (htmlFor → the Radix
                // button's id), which is the recipe `Composer`'s acknowledgement row uses. R3.
                <Label
                  key={scope}
                  htmlFor={id}
                  className="flex min-h-11 items-start gap-3 py-1 text-sm leading-snug font-normal"
                >
                  <Checkbox
                    id={id}
                    checked={scopes.includes(scope)}
                    disabled={pending}
                    onCheckedChange={(checked) => toggleScope(scope, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{API_TOKEN_SCOPE_LABELS[scope]}</span>
                    <span className="text-xs text-muted-foreground">{SCOPE_HELP[scope]}</span>
                  </span>
                </Label>
              );
            })}
            <FieldError id={`${formId}-scopes-error`} messages={fieldErrors.scopes} />
          </fieldset>

          {clientScoped ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-requester`}>Bind to one client (optional)</Label>
              <Input
                id={`${formId}-requester`}
                type="email"
                value={requesterEmail}
                maxLength={254}
                autoComplete="off"
                inputMode="email"
                placeholder="client@example.com"
                onChange={(e) => setRequesterEmail(e.target.value)}
                disabled={pending}
                aria-describedby={fieldErrors.requesterEmail ? `${formId}-requester-error` : undefined}
              />
              <FieldError id={`${formId}-requester-error`} messages={fieldErrors.requesterEmail} />
              <p className="text-xs text-muted-foreground">
                Leave blank for a shared backend credential. Set it only when the credential belongs to a
                single client — the header must then match this address.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-expires`}>Expires (optional)</Label>
            <Input
              id={`${formId}-expires`}
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={pending}
              aria-describedby={fieldErrors.expiresAt ? `${formId}-expires-error` : undefined}
            />
            <FieldError id={`${formId}-expires-error`} messages={fieldErrors.expiresAt} />
            <p className="text-xs text-muted-foreground">
              After this date the credential stops working on its own. Rotating carries the date across.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-note`}>Note (optional)</Label>
            <Textarea
              id={`${formId}-note`}
              value={note}
              maxLength={500}
              rows={3}
              placeholder="Held in the n8n workspace variable WMHD_INGEST_TOKEN."
              onChange={(e) => setNote(e.target.value)}
              disabled={pending}
              aria-describedby={fieldErrors.note ? `${formId}-note-error` : undefined}
            />
            <FieldError id={`${formId}-note-error`} messages={fieldErrors.note} />
          </div>
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending} aria-busy={pending || undefined}>
            {pending ? "Issuing…" : "Issue token"}
          </Button>
        </ResponsiveSheetFooter>
      </ResponsiveSheet>
    </>
  );
}

function FieldError({ id, messages }: { id: string; messages: string[] | undefined }): React.JSX.Element | null {
  if (!messages || messages.length === 0) return null;
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {messages.join(" ")}
    </p>
  );
}
