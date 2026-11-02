// Browser side of the Roster screen (ticket) over the ADMIN-only roster route (ticket,
// app/api/trade-requests/roster/route.ts): GET lists the active traders, POST adds, removes or edits Slack.

export const ROSTER_API = "/api/trade-requests/roster";

export type RosterMember = { id: string; name: string; email: string; slackUserId: string | null; aoaRole: string | null; eligible: boolean };

export type RosterChange =
  | { action: "add"; email: string }
  | { action: "remove"; memberId: string }
  | { action: "slack"; memberId: string; slackUserId: string | null };

export type RosterResult = { ok: true; members: RosterMember[] } | { ok: false; signedOut: boolean; message: string };

export const ROSTER_COPY = {
  title: "Trader roster",
  description: "Active traders receive Trade Request notifications. Only people whose AOA role is ADMIN or OPERATIONS are eligible.",
  loading: "Loading the trader roster…",
  empty: "No active traders.",
  loadFailed: "Unable to load the trader roster. Please try again.",
  changeFailed: "The roster change could not be saved. Please try again.",
  unavailable: "The trader roster is not available right now.",
  writesPaused: "Changes are paused right now. Try again later.",
  addLabel: "Add a trader by email",
  addButton: "Add to roster",
  adding: "Adding…",
  eligible: "Eligible",
  notEligible: "Not eligible",
  notLinked: "Not linked",
  remove: "Remove",
  editSlack: "Click to edit Slack ID",
  confirmRemove: (name: string) => `Remove ${name} from the trader roster?`,
  refusals: {
    not_eligible: "Only a person with an ADMIN or OPERATIONS account in AOA can be added to the trader roster.",
    not_found: "That roster member was not found. Refresh and try again.",
    invalid_slack_id: "Enter a Slack member ID such as U0123456789, or leave it empty.",
    invalid_member: "That roster change is not valid.",
    invalid: "That roster change is not valid.",
    last_trader: "The last active trader cannot be removed.",
    self_removal: "You cannot remove yourself from the roster.",
  } as Record<string, string>,
} as const;

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isMember(value: unknown): value is RosterMember {
  const m = value as Partial<RosterMember> | null;
  return m != null && typeof m === "object" && typeof m.id === "string" && typeof m.name === "string" && typeof m.email === "string"
    && (m.slackUserId === null || typeof m.slackUserId === "string") && (m.aoaRole === null || typeof m.aoaRole === "string")
    && typeof m.eligible === "boolean";
}

export function parseRoster(body: unknown): RosterMember[] | null {
  const data = (body as { ok?: unknown; data?: unknown } | null)?.data;
  return (body as { ok?: unknown } | null)?.ok === true && Array.isArray(data) && data.every(isMember) ? data : null;
}

/** The message for a refused or failed roster call (status and the route's `outcome`). */
export function rosterFailureMessage(status: number, body: unknown, fallback: string): string {
  const outcome = (body as { outcome?: unknown } | null)?.outcome;
  if (typeof outcome === "string" && ROSTER_COPY.refusals[outcome]) return ROSTER_COPY.refusals[outcome];
  if (status === 404) return ROSTER_COPY.unavailable;
  if (status === 503) return ROSTER_COPY.writesPaused;
  return fallback;
}

export async function rosterRequest(change?: RosterChange): Promise<RosterResult> {
  const fallback = change ? ROSTER_COPY.changeFailed : ROSTER_COPY.loadFailed;
  let response: Response;
  try {
    response = await fetch(ROSTER_API, change
      ? { method: "POST", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(change) }
      : { method: "GET", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, signedOut: false, message: fallback };
  }
  if (response.redirected || response.status === 401 || response.status === 403) return { ok: false, signedOut: true, message: fallback };
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, signedOut: false, message: rosterFailureMessage(response.status, body, fallback) };
  const members = parseRoster(body);
  return members ? { ok: true, members } : { ok: false, signedOut: false, message: fallback };
}
