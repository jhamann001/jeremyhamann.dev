/**
 * The channel a comment badge claims.
 *
 * The defect this pins: the badge branched on `visibility` alone, and a requester's inbound email reply
 * is a PUBLIC row — so a client's own message rendered with a Send icon and the outbound wording
 * ("Sent to client" at the time; "Client-visible reply" after the delivery-copy fix). Either way it is
 * an inbound client message presented as an outbound firm message, on a thread a compliance reviewer
 * reads on a complaint or an escalation ticket.
 *
 * `authorKind` is already on `CommentDTO` for exactly this, so the badge is a pure function of the two
 * columns and is pinned here rather than in a render test: the timeline and the dashboard preview both
 * import these helpers, which is what stops the two surfaces from drifting apart again.
 */
import { describe, expect, it } from "vitest";
import type { CommentAuthorKind, CommentVisibility } from "@/types/domain";
import { COMMENT_AUTHOR_KINDS } from "@/types/domain";
import {
  INBOUND_MESSAGE_LABEL,
  INTERNAL_NOTE_LABEL,
  PUBLIC_REPLY_LABEL,
  SYSTEM_MESSAGE_LABEL,
  commentChannel,
  commentChannelLabel,
  type CommentChannel,
} from "@/components/tickets/internal-note-styles";

const VISIBILITIES: CommentVisibility[] = ["INTERNAL", "PUBLIC"];

describe("commentChannel", () => {
  it("calls a requester's PUBLIC message inbound, never outbound", () => {
    expect(commentChannel("PUBLIC", "REQUESTER")).toBe("INBOUND");
    expect(commentChannel("PUBLIC", "REQUESTER")).not.toBe("OUTBOUND");
  });

  it("calls a staff PUBLIC reply outbound and a SYSTEM PUBLIC row a system message", () => {
    expect(commentChannel("PUBLIC", "STAFF")).toBe("OUTBOUND");
    expect(commentChannel("PUBLIC", "SYSTEM")).toBe("SYSTEM");
  });

  it("lets INTERNAL win for every author kind — the amber promise is true whoever wrote it", () => {
    for (const kind of COMMENT_AUTHOR_KINDS) {
      expect(commentChannel("INTERNAL", kind)).toBe("INTERNAL");
    }
  });

  it("resolves every (visibility, authorKind) pair the schema allows", () => {
    for (const visibility of VISIBILITIES) {
      for (const kind of COMMENT_AUTHOR_KINDS) {
        expect(["INTERNAL", "OUTBOUND", "INBOUND", "SYSTEM"]).toContain(
          commentChannel(visibility, kind as CommentAuthorKind),
        );
      }
    }
  });
});

describe("commentChannelLabel", () => {
  it("gives each channel its own wording, and reuses the existing two verbatim", () => {
    expect(commentChannelLabel("INTERNAL")).toBe(INTERNAL_NOTE_LABEL);
    expect(commentChannelLabel("OUTBOUND")).toBe(PUBLIC_REPLY_LABEL);
    expect(commentChannelLabel("INBOUND")).toBe(INBOUND_MESSAGE_LABEL);
    expect(commentChannelLabel("SYSTEM")).toBe(SYSTEM_MESSAGE_LABEL);

    const labels = (["INTERNAL", "OUTBOUND", "INBOUND", "SYSTEM"] satisfies CommentChannel[]).map(
      commentChannelLabel,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never lets an inbound message carry outbound wording", () => {
    const inbound = commentChannelLabel(commentChannel("PUBLIC", "REQUESTER")).toLowerCase();
    expect(inbound).not.toContain("sent");
    expect(inbound).not.toContain("reply to client");
    expect(inbound).toContain("client");
    // "Client-visible reply" describes the desk's own outbound copy; it must not reach a client's message.
    expect(commentChannelLabel(commentChannel("PUBLIC", "REQUESTER"))).not.toBe(PUBLIC_REPLY_LABEL);
  });
});
