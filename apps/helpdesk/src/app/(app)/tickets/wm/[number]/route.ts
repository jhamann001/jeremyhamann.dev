/**
 * GET /tickets/wm/[number] — the human-quotable deep link.
 *
 * A ticket's primary key is a cuid; every human and every neighbouring system (Slack, a Apex ticket,
 * a CRM task, a CSV column) speaks in WM numbers. This route is the one place that translates:
 * resolve the number, 302 to `/tickets/<id>`, 404 otherwise.
 *
 * It writes NO audit row, deliberately. It returns no ticket content — only whether a number resolves,
 * which the very next request (the detail page) records as a `TICKET_VIEWED` with the same actor,
 * groups, IP and request id. Auditing here as well would double-count every navigation.
 *
 * It sits inside the session middleware matcher (`/tickets/**`), and `requireUser()` re-checks the
 * viewer server-side anyway — a redirect to a ticket id is still a fact about the desk.
 *
 * EXISTENCE NEVER LEAKS (same rule as `getTicketDetail` and `src/server/attachments.ts`). The
 * number is resolved INSIDE the viewer's readable queues, so a number that does not exist and a
 * number that exists in a queue this viewer cannot read are the same 404. Without that scope this
 * handler would be a cross-queue oracle: authenticated `client_services` could walk `1..N`, learn
 * which WM numbers exist in ADVICE, and collect their internal ids — with the detail page's refusal
 * arriving only after the existence answer had already been given, and nothing in the ledger
 * recording the sweep. A viewer who reads no queue resolves nothing.
 */
import { notFound } from "next/navigation";
import { readableQueues } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { getTicketIdByNumber } from "@/server/tickets";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** `123` only. `HD-123` is not accepted here: the "WM" already lives in the path segment before it. */
function parseTicketNumber(raw: string): number | null {
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export async function GET(req: Request, ctx: { params: Promise<{ number: string }> }): Promise<Response> {
  const viewer = await requireUser();

  const { number: raw } = await ctx.params;
  const number = parseTicketNumber(raw);
  if (number === null) notFound();

  const id = await getTicketIdByNumber(number, readableQueues(viewer.groups));
  if (id === null) notFound();

  // A path, not an absolute URL: behind a proxy `req.url` is the app's own address (in the demo's container,
  // https://0.0.0.0:3000), and the browser resolves a path against the address it actually used.
  return new Response(null, {
    status: 302,
    headers: { Location: `/tickets/${id}`, ...NO_STORE },
  });
}
