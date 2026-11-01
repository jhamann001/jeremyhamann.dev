"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hash, LoaderCircle, Mail, Reply, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { OutboxEmailPayload, OutboxMessage, OutboxSlackPayload } from "@/lib/demo/outbox";
import { replyAsClient, sendSampleClientEmail, type IntakeSummary } from "@/server/demo-outbox.actions";
import type { ActionResult } from "@/types/domain";

function describe(result: IntakeSummary): string {
  if (result.outcome === "ticket") return `The email arrived as a new ticket, HD-${result.ticketNumber}`;
  if (result.outcome === "comment") return `The reply was added to HD-${result.ticketNumber}`;
  return "The email was held for review under Admin, Held mail";
}

function useIntakeAction(run: () => Promise<ActionResult<IntakeSummary>>): [boolean, () => void] {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return [
    pending,
    () =>
      startTransition(async () => {
        const result = await run();
        if (result.ok) {
          toast.success(describe(result.data));
          router.refresh();
          return;
        }
        if (result.code === "UNAUTHORIZED") {
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        }
        toast.error(result.message);
      }),
  ];
}

function SampleEmailButton(): React.JSX.Element {
  const [pending, run] = useIntakeAction(() => sendSampleClientEmail());
  return (
    <Button type="button" className="min-h-11 md:min-h-9" onClick={run} disabled={pending}>
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
      Send a sample client email
    </Button>
  );
}

function ReplyAsClientButton({ outboxId }: { outboxId: string }): React.JSX.Element {
  const [pending, run] = useIntakeAction(() => replyAsClient({ outboxId }));
  return (
    <Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={run} disabled={pending}>
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Reply className="size-4" aria-hidden />}
      Reply as the client
    </Button>
  );
}

function EmailItem({ message }: { message: OutboxMessage }): React.JSX.Element {
  const email = message.payload as OutboxEmailPayload;
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Mail className="size-4 text-muted-foreground" aria-hidden />
        <Badge variant="secondary">Email</Badge>
        <span className="font-medium break-all">{email.to}</span>
        <span className="text-muted-foreground">{formatDateTime(message.createdAt)}</span>
      </div>
      <p className="text-sm font-medium">{email.subject}</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show the message</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>From</dt>
          <dd className="break-all">
            {email.fromName} &lt;{email.from}&gt;
          </dd>
          <dt>Reply-To</dt>
          <dd className="break-all">{email.replyTo}</dd>
          <dt>Message-ID</dt>
          <dd className="break-all">{email.messageId}</dd>
        </dl>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{email.textBody}</pre>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <ReplyAsClientButton outboxId={message.id} />
        <Link href={`/tickets/wm/${email.ticketNumber}`} prefetch={false} className="text-sm underline underline-offset-4">
          Open HD-{email.ticketNumber}
        </Link>
      </div>
    </li>
  );
}

function SlackItem({ message }: { message: OutboxMessage }): React.JSX.Element {
  const slack = message.payload as OutboxSlackPayload;
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Hash className="size-4 text-muted-foreground" aria-hidden />
        <Badge variant="outline">Slack</Badge>
        <span className="font-medium">{message.destination}</span>
        <span className="text-muted-foreground">{formatDateTime(message.createdAt)}</span>
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{slack.text}</pre>
    </li>
  );
}

export function OutboxView({ messages }: { messages: OutboxMessage[] }): React.JSX.Element {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-slice="demo-outbox">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">Outbox</h1>
        <p className="text-sm text-muted-foreground">
          Everything the desk would have sent, caught before it left: client email from the firm&apos;s mail
          sender and Slack alerts. In this demo nothing reaches a real inbox or channel.
        </p>
      </header>

      <div className="flex flex-col gap-2 rounded-md border p-3">
        <p className="text-sm">
          Play the client: send the desk a new email, or answer one the desk sent. Either one goes through the
          desk&apos;s real email intake.
        </p>
        <div>
          <SampleEmailButton />
        </div>
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing sent yet. Reply to a client on a ticket and the email appears here within a few seconds.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {messages.map((m) => (m.transport === "email" ? <EmailItem key={m.id} message={m} /> : <SlackItem key={m.id} message={m} />))}
        </ul>
      )}
    </section>
  );
}
