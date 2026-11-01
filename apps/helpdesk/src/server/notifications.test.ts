import { describe, expect, it } from "vitest";
import type { NotificationChannel, NotificationKind, NotificationPrefs, Viewer } from "@/types/domain";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFS_DEFAULT,
  WAVE_B_LIMITS,
} from "@/types/domain";
import {
  decodeCursor,
  mentionSnippet,
  prefAllows,
  prefsSummary,
  readNotificationPrefs,
  toNotificationDTO,
  toPreview,
} from "@/server/notifications";

function viewerWith(groups: Viewer["groups"]): Viewer {
  return { id: "u_v", email: "v@wm-helpdesk.local", name: "V", image: null, groups, isDev: false };
}

describe("toPreview", () => {
  it("collapses whitespace and bounds the DB CHECK", () => {
    expect(toPreview("  a \n b  ")).toBe("a b");
    const long = toPreview("x".repeat(500));
    expect(long.length).toBe(WAVE_B_LIMITS.notificationPreviewChars);
    expect(long.endsWith("…")).toBe(true);
  });

  it("sanitizes BEFORE truncating, so a half-redacted number can never be stored", () => {
    const preview = toPreview(`padding ${"y".repeat(150)} card 4111 1111 1111 1111`);
    expect(preview).not.toContain("4111");
    expect(preview.length).toBeLessThanOrEqual(WAVE_B_LIMITS.notificationPreviewChars);
  });
});

describe("mentionSnippet", () => {
  it("is a window on the note, with ellipses on the side it cut", () => {
    const body = `${"a".repeat(200)} @mia.ops ${"b".repeat(200)}`;
    const snippet = mentionSnippet(body, 201);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("@mia.ops");
    expect(snippet.length).toBeLessThanOrEqual(WAVE_B_LIMITS.notificationPreviewChars);
  });

  it("does not add ellipses when the whole note fits", () => {
    const snippet = mentionSnippet("@mia.ops please confirm", 0);
    expect(snippet).toBe("@mia.ops please confirm");
  });

  it("redacts PII that happens to sit next to the mention", () => {
    expect(mentionSnippet("@mia.ops the SSN is 123-45-6789", 0)).not.toContain("123-45-6789");
  });
});

describe("readNotificationPrefs", () => {
  it("a null column means THE DEFAULTS, never 'notify nothing'", () => {
    expect(readNotificationPrefs(null)).toEqual(NOTIFICATION_PREFS_DEFAULT);
    expect(readNotificationPrefs(undefined)).toEqual(NOTIFICATION_PREFS_DEFAULT);
  });

  it("an unparseable column means the defaults too — a bad write never silences someone", () => {
    for (const raw of [42, "nope", { channels: "no" }, { digest: true }, []]) {
      expect(readNotificationPrefs(raw)).toEqual(NOTIFICATION_PREFS_DEFAULT);
    }
  });

  it("round-trips a stored object", () => {
    const stored: NotificationPrefs = {
      channels: { MENTION: { SLACK_DM: false, WEB_PUSH: true } },
      digest: false,
      muteWhileOutOfOffice: false,
    };
    expect(readNotificationPrefs(stored)).toEqual(stored);
  });
});

describe("prefAllows", () => {
  it("IN_APP is unconditional for every kind, whatever the stored object says", () => {
    const silent: NotificationPrefs = {
      channels: Object.fromEntries(
        NOTIFICATION_KINDS.map((k) => [k, { IN_APP: false, SLACK_DM: false, WEB_PUSH: false }]),
      ) as NotificationPrefs["channels"],
      digest: false,
      muteWhileOutOfOffice: false,
    };
    for (const kind of NOTIFICATION_KINDS) expect(prefAllows(silent, kind, "IN_APP")).toBe(true);
  });

  it("a missing key falls back to the DEFAULT, never to false", () => {
    const empty: NotificationPrefs = { channels: {}, digest: true, muteWhileOutOfOffice: true };
    for (const kind of NOTIFICATION_KINDS) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const expected =
          channel === "IN_APP" ? true : (NOTIFICATION_PREFS_DEFAULT.channels[kind]?.[channel] ?? false);
        expect(prefAllows(empty, kind, channel as NotificationChannel), `${kind}/${channel}`).toBe(expected);
      }
    }
  });

  it("an explicit false wins over the default", () => {
    const prefs: NotificationPrefs = {
      channels: { MENTION: { SLACK_DM: false } },
      digest: true,
      muteWhileOutOfOffice: true,
    };
    expect(NOTIFICATION_PREFS_DEFAULT.channels.MENTION?.SLACK_DM).toBe(true);
    expect(prefAllows(prefs, "MENTION", "SLACK_DM")).toBe(false);
  });
});

describe("prefsSummary", () => {
  it("is a summary and never the JSON (CONTRACT §3.2)", () => {
    const summary = prefsSummary(NOTIFICATION_PREFS_DEFAULT);
    expect(summary).toBe("digest on; Slack DM 4/8; push 3/8; mute while out of office on");
    expect(summary).not.toContain("{");
    expect(summary).not.toContain("channels");
  });

  it("moves with the preferences it describes", () => {
    const off: NotificationPrefs = {
      channels: Object.fromEntries(
        NOTIFICATION_KINDS.map((k) => [k, { SLACK_DM: false, WEB_PUSH: false }]),
      ) as NotificationPrefs["channels"],
      digest: false,
      muteWhileOutOfOffice: false,
    };
    expect(prefsSummary(off)).toBe("digest off; Slack DM 0/8; push 0/8; mute while out of office off");
  });
});

describe("decodeCursor", () => {
  it("reads a well-formed cursor", () => {
    const decoded = decodeCursor("2026-09-20T12:00:00.000Z|abc123");
    expect(decoded?.id).toBe("abc123");
    expect(decoded?.createdAt.toISOString()).toBe("2026-09-20T12:00:00.000Z");
  });

  it("is tolerant — a hand-edited cursor pages from the top rather than failing the render", () => {
    for (const raw of [null, undefined, "", "|abc", "nonsense", "2026-13-45T99:99:99Z|abc", "2026-09-20T12:00:00.000Z|"]) {
      expect(decodeCursor(raw)).toBeNull();
    }
  });
});

describe("toNotificationDTO", () => {
  // A REAL mention preview: `mentionSnippet` stores a window on the INTERNAL note, not a subject.
  const SNIPPET = "…@dana.cs the client wants the full balance wired before the cutoff…";
  const base = {
    id: "n1",
    kind: "MENTION" as NotificationKind,
    preview: SNIPPET,
    createdAt: new Date("2026-09-20T12:00:00.000Z"),
    readAt: null,
    dismissedAt: null,
    commentId: "c1",
    channels: ["IN_APP" as NotificationChannel],
    actor: null,
  };

  it("carries the subject and the number when the viewer can read the queue", () => {
    const dto = toNotificationDTO(
      { ...base, ticket: { id: "t1", number: 1042, subject: "Wire", queue: { key: "OPERATIONS" } } },
      viewerWith(["ops_team"]),
    );
    expect(dto.ticketNumber).toBe(1042);
    expect(dto.ticketSubject).toBe("Wire");
    expect(dto.ticketId).toBe("t1");
    expect(dto.preview).toBe(SNIPPET);
  });

  it("withholds BOTH when the viewer cannot — the number is the deep link", () => {
    const dto = toNotificationDTO(
      { ...base, ticket: { id: "t1", number: 1042, subject: "Wire", queue: { key: "OPERATIONS" } } },
      viewerWith([]),
    );
    expect(dto.ticketNumber).toBeNull();
    expect(dto.ticketSubject).toBeNull();
    // The row itself is still returned: hiding it would make the unread badge disagree with the list.
    expect(dto.ticketId).toBe("t1");
  });

  it("withholds the PREVIEW too — a MENTION snippet is note body, not a subject line", () => {
    const dto = toNotificationDTO(
      { ...base, ticket: { id: "t1", number: 1042, subject: "Wire", queue: { key: "ADVICE" } } },
      // The shipped matrix, no group change needed: client_services has no ADVICE grant, and
      // `listMentionableUsers` will happily hand an ADVICE note an @client_services handle.
      viewerWith(["client_services"]),
    );
    expect(dto.preview).toBe(NOTIFICATION_KIND_LABELS.MENTION);
    expect(dto.preview).not.toContain("cutoff");
    expect(dto.preview).not.toContain("balance");
  });

  it("falls back to the kind label for every kind, so no stored text escapes the gate", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const dto = toNotificationDTO(
        { ...base, kind, ticket: { id: "t1", number: 1042, subject: "Wire", queue: { key: "ADVICE" } } },
        viewerWith(["client_services"]),
      );
      expect(dto.preview).toBe(NOTIFICATION_KIND_LABELS[kind]);
    }
  });

  it("handles a notification with no ticket behind it", () => {
    const dto = toNotificationDTO({ ...base, ticket: null }, viewerWith(["ops_team"]));
    expect(dto.ticketId).toBeNull();
    expect(dto.ticketNumber).toBeNull();
    expect(dto.ticketSubject).toBeNull();
    // Fail-closed: with no ticket there is no queue to check, so the stored text is not rendered.
    expect(dto.preview).toBe(NOTIFICATION_KIND_LABELS.MENTION);
  });
});
