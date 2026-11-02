// Wording parity for AOA's Trade Request Slack messages (ticket): with the standalone link functions, every AOA
// builder reproduces the message captured from trade-request d41b6c9 byte for byte; with the AOA links only the
// link line changes (owner decision D0.1, 2026-10-18).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AOA_LINKS,
  buildExclusionBatchText,
  buildExclusionChangeText,
  buildNewRequestText,
  buildStatusChangeText,
  type ExclusionBatchInfo,
  type ExclusionChangeInfo,
  type NewRequestInfo,
  type SlackLinks,
  type StatusChangeInfo,
} from "@/lib/slack/trade-requests";
import { CASES } from "../scripts/trade-requests/slack-fixture-cases.mjs";

type Fixture = Record<string, { channel: string; text: string }>;
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/trade-request-slack-standalone.json"), "utf8")) as Fixture;
const cases = CASES as unknown as Record<string, [string, Record<string, unknown>]>;

const STANDALONE_LINKS: SlackLinks = {
  requestUrl: (id) => `https://standalone.example/queue/${id}`,
  editUrl: (id) => `https://standalone.example/edit/${id}`,
};

function build(fn: string, input: Record<string, unknown>, links: SlackLinks): string | null {
  switch (fn) {
    case "notifyNewRequest":
      return buildNewRequestText(input as unknown as NewRequestInfo, links);
    case "notifyStatusChange":
      return buildStatusChangeText(input as unknown as StatusChangeInfo, links);
    case "notifyExclusionChange":
      return buildExclusionChangeText(input as unknown as ExclusionChangeInfo);
    case "notifyExclusionBatchChange":
      return buildExclusionBatchText(input as unknown as ExclusionBatchInfo);
    default:
      throw new Error(`unmapped standalone function ${fn}`);
  }
}

describe("Trade Request Slack wording matches the standalone service", () => {
  it.each(Object.keys(cases))("%s", (name) => {
    const [fn, input] = cases[name];
    expect(fixture[name], `fixture entry ${name}`).toBeDefined();
    expect(fixture[name].channel).toBe(name === "statusDm" ? "U0WKHNENF9" : "CFIXTURE");
    expect(build(fn, input, STANDALONE_LINKS)).toBe(fixture[name].text);
  });

  it("with the AOA links, only the link line changes and it names the AOA workspace", () => {
    const expected: Record<string, string> = {
      newRequestSingle: "View request: https://aoa.jeremyhamann.dev/trade-requests/queue/REQ-00000001",
      statusNeedsInfoChannel: "Please review and edit your request: https://aoa.jeremyhamann.dev/trade-requests/new/edit/REQ-00000001",
    };
    for (const [name, lastLine] of Object.entries(expected)) {
      const [fn, input] = cases[name];
      const aoa = build(fn, input, AOA_LINKS)!.split("\n");
      const standalone = fixture[name].text.split("\n");
      expect(aoa.length).toBe(standalone.length);
      expect(aoa.slice(0, -1)).toEqual(standalone.slice(0, -1));
      expect(aoa.at(-1)).not.toBe(standalone.at(-1));
      expect(aoa.at(-1)).toBe(lastLine);
    }
  });
});
