/**
 * Source guard for the log-a-call variant of the new-ticket form.
 *
 * The repo has no DOM test environment, so this asserts the SHAPE of the client code the way
 * `requester-email-flow.test.ts` and `ticket-list-probe.test.ts` do. The channel rules themselves are
 * unit-tested in `src/lib/log-call.test.ts`; what is protected here is the wiring, and every assertion
 * below stands for something that would be wrong in a way nobody would notice from a screenshot:
 *
 *  - a call going through `createTicket` would demand an email address and lose `Ticket.source`;
 *  - "the client was reached" folded into the create would credit an SLA first response from inside the
 *    same action that started the clock;
 *  - a missing idempotency key would make a double tap two tickets for one call;
 *  - the duplicate warning left unmounted would let the desk raise the second ticket it exists to stop.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const form = readFileSync(path.join(ROOT, "src/components/dashboard/new-ticket-form.tsx"), "utf8");

describe("the channel selector", () => {
  it("renders every channel from the shared list, never a local copy", () => {
    expect(form).toContain('from "@/lib/log-call"');
    expect(form).toContain("LOG_CALL_CHANNELS.map(");
    expect(form).toContain("LOG_CALL_CHANNEL_LABELS[c]");
    // No hard-coded channel strings in the JSX: the list is the source.
    expect(form).not.toContain('"Web form"');
    expect(form).not.toContain('"Voicemail"');
  });

  it("re-seeds the category from defaultCategoryForChannel and keeps the typed content", () => {
    const handler = /const onChannelChange[\s\S]*?\n  };/.exec(form)?.[0] ?? "";
    expect(handler, "onChannelChange not found — the form was restructured").not.toBe("");
    expect(handler).toContain("defaultCategoryForChannel(next)");
    // Never clears what the associate has typed.
    expect(handler).not.toContain("setSubject(");
    expect(handler).not.toContain("setDescription(");
    expect(handler).not.toContain("setRequesterName(");
  });

  it("gives every channel button a 44 px target (MOBILE_FIRST R3)", () => {
    const group = /<div role="group"[\s\S]*?<\/div>/.exec(form)?.[0] ?? "";
    expect(group).toContain("min-h-11");
    expect(group).toContain("aria-pressed");
  });
});

describe("which action runs", () => {
  it("routes the three call channels through logCall and keeps the web form on createTicket", () => {
    expect(form).toContain('from "@/server/log-call.actions"');
    expect(form).toContain("await logCall({");
    expect(form).toContain("await createTicket(input)");
    // The branch is the channel, decided once.
    expect(form).toContain("const isCall = channel !== \"WEB_FORM\";");
    expect(form).toContain("if (isCall) {");
  });

  it("sends an idempotency key so a double submit replays instead of duplicating", () => {
    expect(form).toContain("requestIdRef");
    expect(form).toContain("requestId: requestId()");
    // Cleared only after a success, so a retry of a FAILED submit reuses the same key.
    expect(form).toContain("requestIdRef.current = null;");
  });

  it("never sends an assignee on a logged call — intake, not triage", () => {
    const call = /await logCall\(\{[\s\S]*?\}\);/.exec(form)?.[0] ?? "";
    expect(call, "the logCall call was not found").not.toBe("");
    expect(call).not.toContain("assigneeId");
  });
});

describe("the client-contact option", () => {
  it("is a SECOND action, after the ticket exists, with the returned version", () => {
    expect(form).toContain("recordClientContact({");
    const contact = /await recordClientContact\(\{[\s\S]*?\}\);/.exec(form)?.[0] ?? "";
    expect(contact).toContain("ticketId: id");
    expect(contact).toContain("version,");
    expect(contact).toContain("channel: contactChannel");
  });

  it("derives the contact channel from the shared rule, so a voicemail is only VOICEMAIL_RETURNED", () => {
    expect(form).toContain("contactChannelFor(channel)");
    expect(form).not.toContain('"VOICEMAIL_RETURNED"');
  });

  it("says so when the note fails rather than reporting a contact that was not recorded", () => {
    expect(form).toContain("contactNoteFailed");
    expect(form).toContain("the contact note was not recorded");
  });

  it("requires the note's text when the box is ticked — the note IS the record of the call", () => {
    expect(form).toContain("reached && contactNote.trim() === \"\"");
  });
});

describe("the requester fields", () => {
  it("validates contact details with the same function the server refines on", () => {
    expect(form).toContain("contactErrorsFor(channel, email, phone)");
    // No second copy of the policy in the component.
    expect(form).not.toContain("A web-form ticket needs the requester");
  });

  it("makes the email optional and the phone visible on a call", () => {
    expect(form).toContain("required={!isCall}");
    expect(form).toContain("ids.requesterPhone");
    expect(form).toContain('inputMode="tel"');
    expect(form).toContain("+14155550123");
  });

  it("mounts B2's duplicate warning under the requester fields with the contract props", () => {
    expect(form).toContain('from "@/components/ticket/links/duplicate-candidates"');
    const mount = /<NewTicketDuplicateWarning[\s\S]*?\/>/.exec(form)?.[0] ?? "";
    expect(mount, "NewTicketDuplicateWarning is not mounted").not.toBe("");
    expect(mount).toContain("requesterEmail=");
    expect(mount).toContain("requesterPhone=");
    expect(mount).toContain("subject={subject}");
  });
});

describe("the rules every client file in this repo follows", () => {
  it("does not import @/lib/env (G1) or a non-action server module", () => {
    expect(form).not.toContain('@/lib/env');
    const serverImports = [...form.matchAll(/from "(@\/server\/[^"]+)"/g)].map((m) => m[1]);
    for (const spec of serverImports) expect(spec).toMatch(/\.actions$/);
  });

  it("keeps the phone sticky action bar and the 16 px controls (MOBILE_FIRST §4.4, R4)", () => {
    expect(form).toContain("<StickyActionBar");
    expect(form).toContain("md:font-mono md:text-[13px]");
  });
});
