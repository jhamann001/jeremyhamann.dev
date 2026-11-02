import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { AOA_DIGEST_LINKS, digestClaimSummary, renderDigest, summarizeDigestRows, type DigestLinks, type DigestRow } from "@/lib/trade-requests/native/digest";
import { CASES } from "../scripts/trade-requests/digest-fixture-cases.mjs";

type Captured = {
  result: { sent: boolean; reason: string | null };
  claim: { runDate: string; summary: string };
  posts: Array<{ method: string; channel: string; mrkdwn: boolean; text: string }>;
};
const fixture = JSON.parse(readFileSync("test/fixtures/trade-request-digest-standalone.json", "utf8")) as Record<string, Captured>;
const STANDALONE_LINKS: DigestLinks = {
  queueUrl: "https://standalone.example/queue",
  requestUrl: (id) => `https://standalone.example/queue/${id}`,
};
const build = (name: keyof typeof CASES, links: DigestLinks) => {
  const c = CASES[name];
  const now = new Date(c.now);
  const summary = summarizeDigestRows(structuredClone(c.rows) as unknown as DigestRow[], now);
  return { summary, text: renderDigest(summary, now, links) };
};

describe("Trade Request digest wording matches the standalone service byte for byte", () => {
  it.each(Object.keys(CASES) as Array<keyof typeof CASES>)("%s: message text and claim", (name) => {
    const { summary, text } = build(name, STANDALONE_LINKS);
    const captured = fixture[name];
    expect(captured.claim).toEqual({ runDate: summary.runDate, summary: digestClaimSummary(summary) });
    if (CASES[name].claimed) expect(captured.posts).toEqual([]);
    else expect(captured.posts.map((p) => p.text)).toEqual([text]);
  });
  it("the fixture records one chat.postMessage per unclaimed date and none when already posted", () => {
    for (const [name, c] of Object.entries(CASES)) {
      const captured = fixture[name];
      if (c.claimed) {
        expect(captured.result).toEqual({ sent: false, reason: "already_posted" });
      } else {
        expect(captured.result).toEqual({ sent: true, reason: null });
        expect(captured.posts.map(({ method, channel, mrkdwn }) => ({ method, channel, mrkdwn }))).toEqual([{ method: "chat.postMessage", channel: "CFIXTURE", mrkdwn: true }]);
      }
    }
  });
  it("AOA links change only the link targets", () => {
    const { text } = build("mixed", AOA_DIGEST_LINKS);
    expect(text).toBe(fixture.mixed.posts[0].text.replaceAll("https://standalone.example/queue", "https://aoa.jeremyhamann.dev/trade-requests/queue"));
  });
});
