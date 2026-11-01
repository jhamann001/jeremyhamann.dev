/**
 * The fan-out rule, exhaustively (the build record B1: "Dispatch fan-out is a pure,
 * exhaustively tested function: kind x prefs -> channels").
 *
 * `@/server/notifications-push` (B1 own re-export of B10 sender) is mocked here rather than stubbed in source: the
 * dispatcher imports the CONTRACT signature so that integrating B10 is a no-op, and a test factory
 * is how a concurrently built module is stood in for without a placeholder in the shipped code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/notifications-push", () => ({ sendWebPush: vi.fn(async () => "disabled" as const) }));

import type { NotificationChannel, NotificationKind, NotificationPrefs } from "@/types/domain";
import { NOTIFICATION_KINDS, NOTIFICATION_PREFS_DEFAULT } from "@/types/domain";
import {
  channelsFor,
  isSlackDmEnabled,
  sendSlackDm,
  slackUserMap,
  DISPATCH_WINDOW_MS,
} from "@/server/notifications-dispatch";

const ALL_ON: NotificationPrefs = {
  channels: Object.fromEntries(
    NOTIFICATION_KINDS.map((k) => [k, { SLACK_DM: true, WEB_PUSH: true }]),
  ) as NotificationPrefs["channels"],
  digest: true,
  muteWhileOutOfOffice: true,
};
const ALL_OFF: NotificationPrefs = {
  channels: Object.fromEntries(
    NOTIFICATION_KINDS.map((k) => [k, { SLACK_DM: false, WEB_PUSH: false }]),
  ) as NotificationPrefs["channels"],
  digest: false,
  muteWhileOutOfOffice: false,
};

describe("channelsFor — kind × prefs → channels", () => {
  it("IN_APP is present for every kind, in every combination of the four inputs", () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const prefs of [ALL_ON, ALL_OFF, NOTIFICATION_PREFS_DEFAULT]) {
        for (const slackConfigured of [true, false]) {
          for (const pushConfigured of [true, false]) {
            for (const outOfOffice of [true, false]) {
              const out = channelsFor(kind, { prefs, slackConfigured, pushConfigured, outOfOffice });
              expect(out[0], `${kind}`).toBe("IN_APP");
              expect(out.filter((c) => c === "IN_APP")).toHaveLength(1);
            }
          }
        }
      }
    }
  });

  it("adds a channel only when the preference AND the configuration both say so", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(channelsFor(kind, { prefs: ALL_ON, slackConfigured: true, pushConfigured: true, outOfOffice: false })).toEqual(
        ["IN_APP", "SLACK_DM", "WEB_PUSH"],
      );
      // Preference on, nothing configured.
      expect(channelsFor(kind, { prefs: ALL_ON, slackConfigured: false, pushConfigured: false, outOfOffice: false })).toEqual(
        ["IN_APP"],
      );
      // Configured, preference off.
      expect(channelsFor(kind, { prefs: ALL_OFF, slackConfigured: true, pushConfigured: true, outOfOffice: false })).toEqual(
        ["IN_APP"],
      );
    }
  });

  it("reproduces NOTIFICATION_PREFS_DEFAULT exactly, kind by kind, with everything configured", () => {
    const expected: Record<NotificationKind, NotificationChannel[]> = {
      MENTION: ["IN_APP", "SLACK_DM", "WEB_PUSH"],
      ASSIGNED: ["IN_APP", "SLACK_DM", "WEB_PUSH"],
      REQUESTER_REPLY: ["IN_APP", "SLACK_DM"],
      FOLLOWED_UPDATE: ["IN_APP"],
      SLA_WARNING: ["IN_APP"],
      SLA_BREACH: ["IN_APP", "SLACK_DM", "WEB_PUSH"],
      REVIEW_REQUESTED: ["IN_APP"],
      FOLLOW_UP_DUE: ["IN_APP"],
    };
    for (const kind of NOTIFICATION_KINDS) {
      expect(
        channelsFor(kind, {
          prefs: NOTIFICATION_PREFS_DEFAULT,
          slackConfigured: true,
          pushConfigured: true,
          outOfOffice: false,
        }),
        kind,
      ).toEqual(expected[kind]);
    }
  });

  it("out of office silences the two interrupting channels and never the inbox", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(
        channelsFor(kind, { prefs: ALL_ON, slackConfigured: true, pushConfigured: true, outOfOffice: true }),
        kind,
      ).toEqual(["IN_APP"]);
    }
  });

  it("out of office with muting switched OFF still fans out", () => {
    const prefs: NotificationPrefs = { ...ALL_ON, muteWhileOutOfOffice: false };
    expect(channelsFor("MENTION", { prefs, slackConfigured: true, pushConfigured: true, outOfOffice: true })).toEqual([
      "IN_APP",
      "SLACK_DM",
      "WEB_PUSH",
    ]);
  });

  it("a stored object with no keys at all behaves exactly like the defaults", () => {
    const empty: NotificationPrefs = { channels: {}, digest: true, muteWhileOutOfOffice: true };
    for (const kind of NOTIFICATION_KINDS) {
      const ctx = { slackConfigured: true, pushConfigured: true, outOfOffice: false };
      expect(channelsFor(kind, { prefs: empty, ...ctx }), kind).toEqual(
        channelsFor(kind, { prefs: NOTIFICATION_PREFS_DEFAULT, ...ctx }),
      );
    }
  });
});

describe("slackUserMap", () => {
  it("reads a JSON object of email → member id, lower-cased", () => {
    const map = slackUserMap('{"Mia.Ops@WM-Helpdesk.local":"U01ABCDEF"}');
    expect(map.get("mia.ops@wm-helpdesk.local")).toBe("U01ABCDEF");
    expect(map.size).toBe(1);
  });

  it("fails closed on anything that is not an object of strings", () => {
    for (const raw of [undefined, "", "   ", "not json", "[]", '"a"', "42", "null"]) {
      expect(slackUserMap(raw).size, String(raw)).toBe(0);
    }
  });

  it("drops entries whose value is not a usable member id, keeping the rest", () => {
    const map = slackUserMap('{"a@x.test":"U1","b@x.test":"","c@x.test":5,"d@x.test":"U2"}');
    expect([...map.keys()]).toEqual(["a@x.test", "d@x.test"]);
  });
});

describe("Slack DM transport — disabled unless both halves are configured", () => {
  const originalToken = process.env.SLACK_BOT_TOKEN;
  afterEach(() => {
    if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  it("returns 'disabled' and makes NO request when the credential is unset", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendSlackDm("U01ABCDEF", "WM Help Desk — Mentioned you on HD-1042.")).resolves.toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a blank credential as unset, the same convention src/lib/env.ts applies", async () => {
    process.env.SLACK_BOT_TOKEN = "   ";
    await expect(sendSlackDm("U01ABCDEF", "WM Help Desk — Mentioned you on HD-1042.")).resolves.toBe("disabled");
    expect(isSlackDmEnabled(new Map([["a@x.test", "U1"]]))).toBe(false);
  });

  it("isSlackDmEnabled needs BOTH the map and the credential", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    expect(isSlackDmEnabled(new Map())).toBe(false);
    expect(isSlackDmEnabled(new Map([["a@x.test", "U1"]]))).toBe(true);
    delete process.env.SLACK_BOT_TOKEN;
    expect(isSlackDmEnabled(new Map([["a@x.test", "U1"]]))).toBe(false);
  });

  it("refuses to transmit a line that is not PII-light, rather than redacting and sending it", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendSlackDm("U01ABCDEF", "Client jane@example.com replied")).rejects.toThrow(/not PII-light/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads Slack's application-level {ok:false} as a failure, not a success", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: "channel_not_found" }) })),
    );
    await expect(sendSlackDm("U01ABCDEF", "WM Help Desk — Mentioned you on HD-1042.")).resolves.toBe("failed");
  });

  it("never throws on a transport error", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    await expect(sendSlackDm("U01ABCDEF", "WM Help Desk — Mentioned you on HD-1042.")).resolves.toBe("failed");
  });
});

describe("the dispatch window", () => {
  it("is one hour — the bound that makes a re-run idempotent without a new column", () => {
    expect(DISPATCH_WINDOW_MS).toBe(60 * 60_000);
  });
});
