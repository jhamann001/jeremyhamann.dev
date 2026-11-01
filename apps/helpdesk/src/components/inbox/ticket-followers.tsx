import { cache } from "react";
import { Users } from "lucide-react";
import type { TicketDetailDTO, Viewer } from "@/types/domain";
import { FOLLOWER_SOURCE_LABELS } from "@/types/domain";
import { isFollowing, listTicketFollowers } from "@/server/notifications";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { FollowButton } from "@/components/inbox/follow-button";
import { FollowersSheet } from "@/components/inbox/followers-sheet";

/**
 * Who is watching this ticket — slice **B1**, replacing the foundation stub.
 *
 * MOUNT POINT: an async SERVER component that owns its own data load, because the
 * ticket page is foundation-owned and cannot import B1's server module on this panel's behalf. The
 * PROPS are the contract's; the file is B1's.
 *
 * NOT A VIEW: a follower list is staff identities on a ticket the viewer
 * has already opened and already had audited, carrying no subject, no body and no requester. It
 * writes no audit row. Following and unfollowing ARE audited (`TICKET_FOLLOWED` /
 * `TICKET_UNFOLLOWED`) — who was on the distribution for a client matter is a question a reviewer
 * can reasonably ask.
 *
 * WHY THE SOURCE IS SHOWN. "Mentioned", "Assigned", "Replied" and "Followed" are four different
 * reasons to be on a distribution, and an operator deciding whether to `@` someone needs to know
 * whether that person is already being told. A bare list of faces answers "who" and not "why".
 *
 * TWO VARIANTS. Contract §9 places this panel in the **md+ properties column**, and
 * the build record recorded the consequence rather than fixing
 * it: mounted there and nowhere else, the follow control is in the DOM at 360/390/430 but measures
 * 0x0, so a phone operator's only route to following a ticket was to go back to the dashboard and
 * use the bulk bar. In a mobile-first app (MOBILE_FIRST R1) that is a capability the phone does not
 * have. The §9 placement is unchanged — `variant="inline"` is still that column — and
 * `variant="sheet"` is the phone presentation, in the block above the action dock that already
 * carries `RequesterHistory`'s trigger, exactly as §1.6 proposed. `variant` is OPTIONAL and defaults
 * to `"inline"`, so the contract's `{ ticket, viewer }` call still typechecks and still renders the
 * md+ panel.
 *
 * SAME DATA, SAME STATE (MOBILE_FIRST R7): both variants render the same rows from the same load and
 * drive the same `FollowButton`. The page mounts the component twice and only CSS decides which one
 * is visible, so both run on the server for every render; `cache` collapses the two identical loads
 * into one pair of queries per request, the way `RequesterHistory` does. The arguments are primitives,
 * which is what makes the second call a cache hit.
 */

/**
 * One name for the panel at every width, so the md+ `<h2>`, the phone trigger and the sheet title
 * cannot drift apart (MOBILE_FIRST R7). It is deliberately NOT the word the toggle uses: the button's
 * label is the viewer's own state ("Follow" / "Following"), and reusing it for the panel would make
 * two adjacent controls on a phone read as the same thing.
 */
const FOLLOWERS_HEADING = "Followers" as const;

const loadFollowers = cache(
  async (
    ticketId: string,
    viewerId: string,
  ): Promise<{ followers: Awaited<ReturnType<typeof listTicketFollowers>>; following: boolean }> => {
    const [followers, following] = await Promise.all([
      listTicketFollowers(ticketId),
      isFollowing(ticketId, viewerId),
    ]);
    return { followers, following };
  },
);

export type TicketFollowersVariant = "inline" | "sheet";

export type TicketFollowersProps = {
  ticket: TicketDetailDTO;
  viewer: Viewer;
  /** Default `"inline"` — the contract's md+ properties column. `"sheet"` is the phone block. */
  variant?: TicketFollowersVariant;
};

/** The empty state is a sentence, not a dash: it says what following would have bought the reader. */
function EmptyFollowers(): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground">
      Nobody is following this ticket. Followers are notified when it is replied to, moved or resolved.
    </p>
  );
}

function FollowerList({
  followers,
}: {
  followers: Awaited<ReturnType<typeof listTicketFollowers>>;
}): React.JSX.Element {
  return (
    <ul className="-mx-2 flex flex-col">
      {followers.map((f) => (
        <li key={f.user.id} className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5">
          <UserAvatar user={f.user} size="sm" />
          <Badge variant="outline" className="ml-auto shrink-0 font-normal">
            {FOLLOWER_SOURCE_LABELS[f.source]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export async function TicketFollowers({
  ticket,
  viewer,
  variant = "inline",
}: TicketFollowersProps): Promise<React.JSX.Element> {
  const { followers, following } = await loadFollowers(ticket.id, viewer.id);

  if (variant === "sheet") {
    // The toggle is at the TOP LEVEL, not inside the sheet: following is the act, the list is the
    // reference. Burying a one-tap action behind a sheet is what made it unreachable in the first
    // place. The sheet carries the "why is this person on it" detail the md+ column has room for.
    return (
      <div data-slice="B1-followers" className="flex flex-col gap-2">
        <FollowButton ticketId={ticket.id} ticketNumber={ticket.number} following={following} />
        <FollowersSheet count={followers.length} label={FOLLOWERS_HEADING}>
          {followers.length === 0 ? <EmptyFollowers /> : <FollowerList followers={followers} />}
        </FollowersSheet>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="ticket-followers-heading"
      data-slice="B1-followers"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="mb-2 flex items-center gap-2">
        <Users aria-hidden className="size-4 text-muted-foreground" />
        <h2 id="ticket-followers-heading" className="text-sm font-semibold">
          {FOLLOWERS_HEADING}
        </h2>
        <Badge variant="secondary" className="ml-auto tabular-nums">
          {followers.length}
        </Badge>
      </div>

      <div className="mb-3">
        {followers.length === 0 ? <EmptyFollowers /> : <FollowerList followers={followers} />}
      </div>

      <FollowButton ticketId={ticket.id} ticketNumber={ticket.number} following={following} />
    </section>
  );
}
