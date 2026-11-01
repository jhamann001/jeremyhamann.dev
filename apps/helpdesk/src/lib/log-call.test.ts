/**
 * `src/lib/log-call.ts` — the channel rules behind the new-ticket form's log-a-call variant.
 *
 * Every function here decides something that reaches a books-and-records row, and the two that matter
 * most are the ones a reasonable person would get backwards:
 *
 *  - a VOICEMAIL the desk has NOT returned is not a client contact, so it must not be creditable as a
 *    first response — the clock exists to make somebody call back;
 *  - a call channel must never demand an email address and must never accept a ticket
 *    with no way to reach anybody (the DB CHECK).
 */
import { describe, expect, it } from "vitest";
import { CLIENT_CONTACT_CHANNELS, ROUTING_TABLE, TICKET_SOURCES } from "@/types/domain";
import {
  LOG_CALL_CHANNELS,
  LOG_CALL_CHANNEL_LABELS,
  contactChannelFor,
  contactErrorsFor,
  defaultCategoryForChannel,
  requiresEmail,
  sourceForChannel,
  contactRequirementFor,
} from "@/lib/log-call";

describe("the channel list", () => {
  it("is the four the form offers, each with a label", () => {
    expect(LOG_CALL_CHANNELS).toEqual(["WEB_FORM", "PHONE", "VOICEMAIL", "IN_PERSON"]);
    for (const c of LOG_CALL_CHANNELS) expect(LOG_CALL_CHANNEL_LABELS[c]).toBeTruthy();
  });
});

describe("sourceForChannel", () => {
  it("maps each channel to a real TicketSource", () => {
    for (const c of LOG_CALL_CHANNELS) {
      expect(TICKET_SOURCES).toContain(sourceForChannel(c));
    }
  });

  it("records a call as PHONE and a message as VOICEMAIL", () => {
    expect(sourceForChannel("PHONE")).toBe("PHONE");
    expect(sourceForChannel("VOICEMAIL")).toBe("VOICEMAIL");
  });

  it("falls back to STAFF_FORM for in person, because TicketSource has no value for it", () => {
    // Filed in the build record. The fact is not lost: the contact note
    // records IN_PERSON and the audit row carries the channel.
    expect(sourceForChannel("IN_PERSON")).toBe("STAFF_FORM");
    expect(sourceForChannel("WEB_FORM")).toBe("STAFF_FORM");
  });
});

describe("defaultCategoryForChannel", () => {
  it("pre-selects the callback category for a voicemail, and that category routes somewhere real", () => {
    expect(defaultCategoryForChannel("VOICEMAIL")).toBe("VOICEMAIL_CALLBACK");
    // The routed queue and priority are the desk's own answer to "nobody has called them back yet".
    expect(ROUTING_TABLE.VOICEMAIL_CALLBACK.queueKey).toBe("CLIENT_SERVICE");
    expect(ROUTING_TABLE.VOICEMAIL_CALLBACK.priority).toBe("HIGH");
  });

  it("leaves every other channel on OTHER, so the associate picks", () => {
    expect(defaultCategoryForChannel("WEB_FORM")).toBe("OTHER");
    expect(defaultCategoryForChannel("PHONE")).toBe("OTHER");
    expect(defaultCategoryForChannel("IN_PERSON")).toBe("OTHER");
  });
});

describe("contactChannelFor", () => {
  it("returns a real ClientContactChannel for every channel that can reach a person", () => {
    for (const c of LOG_CALL_CHANNELS) {
      const contact = contactChannelFor(c);
      if (contact !== null) expect(CLIENT_CONTACT_CHANNELS).toContain(contact);
    }
  });

  it("maps a voicemail to VOICEMAIL_RETURNED — only a returned call is a contact", () => {
    expect(contactChannelFor("VOICEMAIL")).toBe("VOICEMAIL_RETURNED");
    expect(contactChannelFor("PHONE")).toBe("PHONE");
    expect(contactChannelFor("IN_PERSON")).toBe("IN_PERSON");
  });

  it("has nothing to record for the web form", () => {
    expect(contactChannelFor("WEB_FORM")).toBeNull();
  });
});

describe("requiresEmail / contactRequirementFor", () => {
  it("demands an address on the web form only (Decision #62)", () => {
    expect(requiresEmail("WEB_FORM")).toBe(true);
    expect(requiresEmail("PHONE")).toBe(false);
    expect(requiresEmail("VOICEMAIL")).toBe(false);
    expect(requiresEmail("IN_PERSON")).toBe(false);
    expect(contactRequirementFor("WEB_FORM")).toBe("email");
    expect(contactRequirementFor("PHONE")).toBe("email-or-phone");
  });
});

describe("contactErrorsFor", () => {
  it("accepts a phone-only call — the whole point of the variant", () => {
    expect(contactErrorsFor("PHONE", "", "+14155550123")).toEqual({});
    expect(contactErrorsFor("VOICEMAIL", null, "+14155550123")).toEqual({});
    expect(contactErrorsFor("IN_PERSON", undefined, "+14155550123")).toEqual({});
  });

  it("accepts an email-only call, and both together", () => {
    expect(contactErrorsFor("PHONE", "pat@example.invalid", "")).toEqual({});
    expect(contactErrorsFor("PHONE", "pat@example.invalid", "+14155550123")).toEqual({});
  });

  it("refuses a call with neither — a request the desk cannot answer is not a ticket", () => {
    const errors = contactErrorsFor("PHONE", "  ", "  ");
    expect(Object.keys(errors)).toEqual(["requesterPhone"]);
    expect(errors.requesterPhone[0]).toContain("at least one way to reach");
  });

  it("still demands an address on the web form, even when a phone is given", () => {
    const errors = contactErrorsFor("WEB_FORM", "", "+14155550123");
    expect(Object.keys(errors)).toEqual(["requesterEmail"]);
  });

  it("keys its errors the way the form's field-error map is keyed", () => {
    // The form spreads this straight into `setErrors`, so the keys ARE the input names.
    for (const key of Object.keys(contactErrorsFor("WEB_FORM", "", ""))) {
      expect(["requesterEmail", "requesterPhone"]).toContain(key);
    }
  });
});
