// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/trade-requests/roster" }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: unknown; prefetch?: boolean }) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { RosterView } from "@/components/trade-requests/roster/RosterView";
import { ROSTER_COPY, type RosterMember } from "@/lib/trade-requests/roster-view";

const MEMBERS: RosterMember[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Dana Admin", email: "admin@example.test", slackUserId: null, aoaRole: "ADMIN", eligible: true },
  { id: "00000000-0000-4000-8000-000000000002", name: "Former Trader", email: "former.trader@example.test", slackUserId: "U0SYNTH02", aoaRole: null, eligible: false },
];
type Reply = { status: number; body: unknown };
let replies: Reply[];
let posts: unknown[];
const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
  if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
  const reply = replies.shift() ?? { status: 200, body: { ok: true, data: MEMBERS } };
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, redirected: false, json: async () => reply.body };
});
const member = (id: string) => document.querySelector(`tr[data-roster-member="${id}"]`) as HTMLElement;

beforeEach(() => {
  replies = [];
  posts = [];
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Roster screen (ticket)", () => {
  it("lists each active trader with AOA role, eligibility and Slack member ID", async () => {
    render(createElement(RosterView));
    await screen.findByText("Dana Admin");
    expect(within(member(MEMBERS[0].id)).getByText(ROSTER_COPY.eligible)).toBeTruthy();
    expect(within(member(MEMBERS[0].id)).getByText(ROSTER_COPY.notLinked)).toBeTruthy();
    expect(within(member(MEMBERS[1].id)).getByText(ROSTER_COPY.notEligible)).toBeTruthy();
    expect(within(member(MEMBERS[1].id)).getByText("U0SYNTH02")).toBeTruthy();
    expect(within(member(MEMBERS[1].id)).getByText("—")).toBeTruthy();
  });

  it("adds by email and shows the route's refusal in words", async () => {
    render(createElement(RosterView));
    await screen.findByText("Dana Admin");
    const input = screen.getByLabelText(ROSTER_COPY.addLabel);
    const add = screen.getByRole("button", { name: ROSTER_COPY.addButton }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "not-an-email" } });
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "avery@example.test" } });
    replies.push({ status: 422, body: { ok: false, outcome: "not_eligible" } });
    fireEvent.click(add);
    expect(await screen.findByText(ROSTER_COPY.refusals.not_eligible)).toBeTruthy();
    expect(posts).toEqual([{ action: "add", email: "avery@example.test" }]);
  });

  it("saves a Slack member ID on Enter, cancels on Escape, and removes after confirmation", async () => {
    render(createElement(RosterView));
    await screen.findByText("Dana Admin");
    fireEvent.click(within(member(MEMBERS[0].id)).getByRole("button", { name: ROSTER_COPY.notLinked }));
    const slack = screen.getByLabelText("Slack member ID for Dana Admin");
    fireEvent.change(slack, { target: { value: " U0SYNTH01 " } });
    replies.push({ status: 200, body: { ok: true, data: [{ ...MEMBERS[0], slackUserId: "U0SYNTH01" }, MEMBERS[1]] } });
    fireEvent.keyDown(slack, { key: "Enter" });
    expect(await within(member(MEMBERS[0].id)).findByText("U0SYNTH01")).toBeTruthy();
    expect(posts).toEqual([{ action: "slack", memberId: MEMBERS[0].id, slackUserId: "U0SYNTH01" }]);
    fireEvent.click(within(member(MEMBERS[1].id)).getByRole("button", { name: "U0SYNTH02" }));
    fireEvent.keyDown(screen.getByLabelText("Slack member ID for Former Trader"), { key: "Escape" });
    expect(posts).toHaveLength(1);
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Former Trader" }));
    expect(posts).toHaveLength(1);
    replies.push({ status: 200, body: { ok: true, data: [MEMBERS[0]] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Former Trader" }));
    await waitFor(() => expect(screen.queryByText("Former Trader")).toBeNull());
    expect(posts[1]).toEqual({ action: "remove", memberId: MEMBERS[1].id });
  });

  it("an ended session replaces the screen; a refused route shows the unavailable message", async () => {
    replies.push({ status: 401, body: { error: "unauthorized" } });
    render(createElement(RosterView));
    expect(await screen.findByTestId("trade-requests-session-ended")).toBeTruthy();
    cleanup();
    replies.push({ status: 404, body: { ok: false } });
    render(createElement(RosterView));
    expect(await screen.findByText(ROSTER_COPY.unavailable)).toBeTruthy();
    expect(document.querySelector("[data-roster-table]")).toBeNull();
  });
});
