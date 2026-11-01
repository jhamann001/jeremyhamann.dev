import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { RefreshCw, Hash, AtSign, Mail } from 'lucide-react';
import { fetchOutbox, extractApiError, type OutboxMessage } from '../api/client';

type Filter = 'all' | 'slack' | 'email';

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Slack sends text with &, < and > escaped; show the characters themselves.
const unescapeSlack = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The parts of Slack's markup the app's messages use: *bold*, _italic_ and `code`. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g).map((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`'))
      return (
        <code key={i} className="px-1 py-0.5 rounded bg-[var(--bg-surface)] text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.length > 1 && part.startsWith('*') && part.endsWith('*')) return <strong key={i}>{part.slice(1, -1)}</strong>;
    if (part.length > 1 && part.startsWith('_') && part.endsWith('_')) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Slack's <url|label> and <url> links (literal brackets; escaped ones are &lt; &gt;). Only http(s). */
function renderLinks(text: string): ReactNode[] {
  return text.split(/(<https?:\/\/[^|>\s]+(?:\|[^>]+)?>)/g).map((part, i) => {
    const link = /^<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>$/.exec(part);
    if (!link) return <span key={i}>{renderInline(unescapeSlack(part))}</span>;
    return (
      <a key={i} href={link[1]} className="underline text-[var(--blue-muted)]" target="_blank" rel="noopener noreferrer">
        {unescapeSlack(link[2] ?? link[1])}
      </a>
    );
  });
}

function SlackText({ text }: { text: string }) {
  // Odd segments between ``` fences are code blocks.
  return (
    <div className="text-sm text-[var(--text-primary)] leading-relaxed">
      {text.split('```').map((part, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="my-2 p-3 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] text-xs overflow-x-auto whitespace-pre"
          >
            {unescapeSlack(part.replace(/^\n/, ''))}
          </pre>
        ) : (
          <span key={i} className="whitespace-pre-wrap break-words">
            {renderLinks(part)}
          </span>
        ),
      )}
    </div>
  );
}

function MessageCard({ message }: { message: OutboxMessage }) {
  const isEmail = message.transport === 'email';
  const isDm = !isEmail && message.destinationLabel.endsWith('(DM)');
  const Icon = isEmail ? Mail : isDm ? AtSign : Hash;
  return (
    <li className="border border-[var(--border)] rounded-lg p-4 bg-[var(--bg-card)]">
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={15} className="text-[var(--text-muted)] shrink-0" aria-hidden />
          <span className="font-medium text-sm text-[var(--text-primary)] truncate">
            {message.destinationLabel.replace(/^#/, '')}
          </span>
          <span className="text-xs text-[var(--text-muted)]">{isEmail ? 'Email' : isDm ? 'Slack direct message' : 'Slack channel'}</span>
        </div>
        <time dateTime={message.createdAt} title={formatAbsolute(message.createdAt)} className="text-xs text-[var(--text-muted)]">
          {formatRelative(message.createdAt)}
        </time>
      </div>
      {isEmail ? (
        <>
          {message.subject && <p className="text-sm font-medium text-[var(--text-primary)] mb-2">{message.subject}</p>}
          {/* The email's own HTML, in a sandbox with no scripts and no access to this page. It is served
              with a policy of its own (server/src/routes/outbox.ts), so its inline styles apply. */}
          <iframe
            title={message.subject ?? 'Email'}
            sandbox=""
            src={`/api/outbox/${encodeURIComponent(message.id)}/body`}
            className="w-full h-72 rounded-md border border-[var(--border)] bg-white"
          />
        </>
      ) : (
        <SlackText text={message.body} />
      )}
    </li>
  );
}

export function OutboxTab() {
  const [messages, setMessages] = useState<OutboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const mountedRef = useRef(true);

  useEffect(() => {
    // Set on mount too: React's development double-mount runs the cleanup once before the real mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOutbox();
      if (mountedRef.current) setMessages(data);
    } catch (err) {
      if (mountedRef.current) setError(extractApiError(err, 'Failed to load the outbox'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = filter === 'all' ? messages : messages.filter((m) => m.transport === filter);
  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'slack', label: 'Slack' },
    { id: 'email', label: 'Email' },
  ];

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Outbox</h2>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Everything the app would have sent. In this demo, Slack messages and emails are kept here instead of
            being delivered.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="flex gap-1 mb-4" role="group" aria-label="Filter messages">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === f.id
                ? 'bg-[var(--bg-pill)] text-white'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 px-4 py-2 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md">
          {error}
        </div>
      )}

      {loading && messages.length === 0 ? (
        <div className="text-center py-8 text-[var(--text-muted)] text-sm">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="text-center py-8 text-[var(--text-muted)] text-sm border border-dashed border-[var(--border)] rounded-lg">
          Nothing has been sent yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((m) => (
            <MessageCard key={m.id} message={m} />
          ))}
        </ul>
      )}
    </div>
  );
}
