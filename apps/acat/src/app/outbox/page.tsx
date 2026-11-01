"use client";

import { Fragment, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, Inbox, Loader2 } from "lucide-react";

// Demo only: everything the app would have sent. Slack's incoming webhook points at a stand-in that
// keeps each message here instead of delivering it.

interface OutboxMessage {
  id: string;
  destination: string;
  title: string;
  payload: { text?: string; blocks?: SlackBlock[] };
  createdAt: string;
}

type SlackText = { type: string; text: string };
type SlackBlock = { type: string; text?: SlackText; fields?: SlackText[] };

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Slack mrkdwn, the parts the app uses: *bold*, line breaks and bullets. */
function Mrkdwn({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line.split(/(\*[^*]+\*)/g).map((part, j) =>
            part.startsWith("*") && part.endsWith("*") && part.length > 2
              ? <strong key={j} className="font-semibold text-foreground">{unescape(part.slice(1, -1))}</strong>
              : <Fragment key={j}>{unescape(part)}</Fragment>,
          )}
        </Fragment>
      ))}
    </>
  );
}

function Block({ block }: { block: SlackBlock }): ReactNode {
  if (block.type === "header" && block.text) {
    return <p className="text-sm font-bold text-foreground">{unescape(block.text.text)}</p>;
  }
  if (block.type === "section" && block.fields) {
    return (
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {block.fields.map((field, i) => (
          <p key={i} className="text-sm text-muted"><Mrkdwn text={field.text} /></p>
        ))}
      </div>
    );
  }
  if (block.type === "section" && block.text) {
    return <p className="text-sm leading-relaxed text-muted"><Mrkdwn text={block.text.text} /></p>;
  }
  return null;
}

export default function OutboxPage() {
  const router = useRouter();
  const { data, error, isLoading } = useSWR<{ messages: OutboxMessage[] }>("/api/outbox");
  const messages = data?.messages ?? [];

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-8 flex items-center gap-4">
          <button
            onClick={() => router.push("/")}
            aria-label="Back to the dashboard"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--invert-bg)] text-[var(--invert-text)]">
              <Inbox size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">Outbox</h1>
              <p className="text-sm text-muted">
                Everything the app would have sent. In this demo, Slack messages are kept here instead of being delivered.
              </p>
            </div>
          </div>
        </div>

        {isLoading && (
          <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-accent" /></div>
        )}
        {error && (
          <p className="rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-3 text-sm text-[color:var(--danger)]">
            The Outbox could not be loaded. Refresh to try again.
          </p>
        )}
        {!isLoading && !error && messages.length === 0 && (
          <p className="rounded-xl border border-card-border bg-[var(--bg-card)] px-6 py-10 text-center text-sm text-muted">
            Nothing here yet. The daily digest posts at each nightly reset.
          </p>
        )}

        <ul className="space-y-4">
          {messages.map((m) => (
            <li key={m.id} className="flex gap-3 rounded-xl border border-card-border bg-[var(--bg-card)] p-5 shadow-sm">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--invert-bg)] text-[var(--invert-text)]"
                style={{ fontFamily: "var(--font-serif)" }}
                aria-hidden
              >
                <span className="text-base font-semibold leading-none">C</span>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="text-sm font-semibold text-foreground">Transfer Tracker</span>
                  <span>{m.destination}</span>
                  <time dateTime={m.createdAt}>
                    {new Date(m.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                </p>
                {m.payload.blocks?.length
                  ? m.payload.blocks.map((block, i) => <Block key={i} block={block} />)
                  : <p className="text-sm text-muted"><Mrkdwn text={m.title} /></p>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
