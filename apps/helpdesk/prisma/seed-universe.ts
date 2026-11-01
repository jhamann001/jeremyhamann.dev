/**
 * The universe's part of the demo desk, written through the same engine as the hand-written tickets
 * (seed-dev.ts): the eight story tickets the other demos link to, about 150 resolved tickets of history
 * for the dashboard and reports, and `placeForViewing`, which times the open tickets for the day after the
 * reset. Pure: no database, no clock — `now` comes in, fixtures go out.
 *
 * Two stories differ from the universe file where this app's rules say otherwise. Compliance reads every
 * queue but is never an assignee, so the Morgan complaint is Helen's ticket, escalated to compliance for
 * Priya's review. And beneficiary forms route to Operations, where Client Service can read but not write,
 * so Helen hands the Okafor form to Jordan, the transfer specialist.
 */
import { routeCategory } from "../src/lib/routing";
import {
  addBusinessDays,
  atFirmTime,
  businessDayOnOrBefore,
  e164,
  findPersonByName,
  firmDay,
  inStaffHours,
  personName,
  pick,
  seeded,
  seededInt,
  sameTimeNextBusinessDay,
  viewingStart,
  workingInstantBetween,
} from "../src/lib/demo/universe";
import type { Universe, UniverseHelpdeskStory, UniversePerson } from "../src/lib/demo/universe";
import { TICKET_CATEGORIES } from "../src/types/domain";
import type { SlaPolicyInput, TicketCategory, TicketPriority, TicketSource } from "../src/types/domain";
import type { CommentFixture, StaffId, TicketFixture } from "./seed-dev";

export const INTERNAL_MARK = "INTERNAL — not for client";

/** The oldest history ticket's number; the rest follow in creation order, around the stories' numbers. */
export const HISTORY_FIRST_NUMBER = 2300;

const MINUTE = 60_000;
const minutesBetween = (earlier: Date, later: Date): number => Math.floor((later.getTime() - earlier.getTime()) / MINUTE);

/** The business day before the viewing day, at a working-hours time. */
function previousBusinessDayAt(now: Date, daysBack: number, hour: number, minute: number): Date {
  return atFirmTime(addBusinessDays(firmDay(viewingStart(now)), -daysBack), hour, minute);
}

const ACCOUNT_LABEL: Record<string, string> = {
  "joint-taxable": "joint taxable",
  individual: "individual",
  trust: "trust",
  "traditional-ira": "traditional IRA",
  "rollover-ira": "rollover IRA",
  "sep-ira": "SEP IRA",
  "roth-ira": "Roth IRA",
};

function clientReference(universe: Universe, p: UniversePerson, accountType?: string): string {
  const household = universe.households.find((h) => h.id === p.household);
  const type = accountType ?? universe.accounts.find((a) => a.household === p.household)?.type;
  const name = household?.name.replace(/ Family$/, " household") ?? `${p.last} household`;
  return type ? `${name} · ${ACCOUNT_LABEL[type] ?? type}` : name;
}

const PRIORITY: Record<UniverseHelpdeskStory["priority"], TicketPriority> = {
  urgent: "URGENT",
  high: "HIGH",
  normal: "STANDARD",
  low: "LOW",
};

// ---------------------------------------------------------------------------
// The eight story tickets
// ---------------------------------------------------------------------------

type StoryDetail = Omit<
  TicketFixture,
  "ref" | "number" | "subject" | "priority" | "requesterName" | "requesterEmail" | "clientReference" | "createdMinAgo"
> & {
  /** When the ticket arrived, before `placeForViewing` re-times it. */
  arrived: (now: Date) => Date;
  accountType?: string;
  phoneOnly?: boolean;
};

const note = (authorId: StaffId, atMin: number, text: string): CommentFixture => ({
  visibility: "INTERNAL",
  authorId,
  atMin,
  body: `${INTERNAL_MARK}: ${text}`,
});
const reply = (authorId: StaffId, atMin: number, body: string): CommentFixture => ({ visibility: "PUBLIC", authorId, atMin, body });

const STORIES: Record<string, StoryDetail> = {
  "HD-2479": {
    category: "WIRE_TRANSFER",
    status: "OPEN",
    source: "EMAIL",
    externalId: "<hd-2479.wire-for-closing@mail.example.com>",
    arrived: (now) => previousBusinessDayAt(now, 1, 15, 10),
    accountType: "joint-taxable",
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    externalRef: "Trade request TR-1046",
    description:
      "We close on the new house this Friday and the title company needs $85,000 wired to their escrow account " +
      "by Thursday afternoon. I will forward their wire instructions as soon as I have them. Can you make sure " +
      "the money is ready?",
    comments: [
      reply(
        "staff_marco",
        12,
        "Hello Lucia, we have your request. Rachel has asked for $85,000 to be raised in your joint account so the " +
          "cash is ready to send, and once it settles we will wire it to the title company. Please send their wire " +
          "instructions when you have them: we will confirm them with the title company by phone, on a number we " +
          "look up ourselves, before any money moves.",
      ),
      note("staff_marco", 30, "raise-cash request TR-1046 ($85,000) is with trading; the wire waits for it to settle. Callback-verify the title company's instructions before release."),
      note("staff_rachel", 55, "entered TR-1046 to raise the cash from the joint account, trimmed from the bond sleeve."),
    ],
    viewTarget: "ON_TRACK",
  },
  "HD-2476": {
    category: "PASSKEY_LOGIN",
    status: "NEW",
    source: "EMAIL",
    externalId: "<hd-2476.new-phone@mail.example.com>",
    // Arrived overnight and nobody has picked it up: the walkthrough starts here.
    arrived: (now) => new Date(now.getTime() - 95 * MINUTE),
    createdById: "staff_jordan",
    description:
      "I switched to a new phone yesterday and now the app won't let me sign in. It keeps asking for my passkey " +
      "and the old phone is already traded in. Can you help?",
    comments: [],
  },
  "HD-2481": {
    category: "BENEFICIARY_TOD",
    status: "PENDING_INTERNAL",
    source: "EMAIL",
    externalId: "<hd-2481.roth-beneficiary@mail.example.com>",
    arrived: (now) => previousBusinessDayAt(now, 1, 11, 20),
    accountType: "roth-ira",
    createdById: "staff_helen",
    assigneeId: "staff_jordan",
    description: "Attached is the signed beneficiary form for my Roth IRA. Please let me know once it is recorded.",
    comments: [
      note("staff_helen", 8, "Ada emailed the signed beneficiary form for her Roth IRA. Handing to Operations: the Roth is still coming over from Edward Jones on T-298."),
      reply(
        "staff_jordan",
        40,
        "Hello Ada, thank you for the signed beneficiary form. Your Roth IRA is still transferring in from " +
          "Edward Jones, so we will record the new beneficiaries as soon as the account arrives and send you a confirmation.",
      ),
      note("staff_jordan", 45, "form checked: primary Kofi 100%, contingent the family trust 100%, signed and dated. Apply when T-298 lands."),
    ],
    attachments: [{ id: "att-okafor-beneficiary-form", uploaderId: "staff_jordan", atMin: 42 }],
    viewTarget: "ON_TRACK",
  },
  "HD-2465": {
    category: "ACAT",
    status: "PENDING_INTERNAL",
    source: "PHONE",
    arrived: (now) => previousBusinessDayAt(now, 1, 9, 40),
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    externalRef: "Transfer T-305 · control CTL-10433",
    description:
      "Trustee called: the trust's transfer from Edward Jones was submitted two days ago. He wants to know " +
      "when the assets will arrive, and whether the trust's model change waits for them.",
    comments: [
      reply(
        "staff_marco",
        20,
        "Hello Ravi, the transfer was submitted to Edward Jones and is in their review queue. Transfers like this " +
          "usually settle within five to seven business days. The model change Dana approved will be applied once " +
          "the assets arrive, so nothing is invested twice.",
      ),
      note("staff_marco", 25, "control CTL-10433, submitted, no rejects so far. TR-1043 (model change) is approved and waits on the assets."),
    ],
    viewTarget: "WARNING",
  },
  "HD-2470": {
    category: "RETIREMENT_DISTRIBUTION",
    status: "OPEN",
    source: "EMAIL",
    externalId: "<hd-2470.rmd-2026@mail.example.com>",
    arrived: (now) => previousBusinessDayAt(now, 1, 14, 5),
    accountType: "traditional-ira",
    createdById: "staff_helen",
    assigneeId: "staff_marco",
    externalRef: "Trade request TR-1038",
    description:
      "Please pay my 2026 required minimum distribution to my checking account, with federal tax withheld at 10%. " +
      "A voided check for the new account is attached.",
    comments: [
      reply(
        "staff_marco",
        15,
        "Hello Erik, thank you. Dana has raised the cash for your required minimum distribution and we have your " +
          "voided check. We will confirm the bank details with you by phone before the payment goes out.",
      ),
      note("staff_marco", 20, "TR-1038 raised $42,300 and is done. New bank account from the voided check: call-back verification before release."),
    ],
    attachments: [{ id: "att-lindqvist-voided-check", uploaderId: "staff_marco", atMin: 10 }],
    viewTarget: "ON_TRACK",
  },
  "HD-2474": {
    category: "OTHER",
    status: "PENDING_INTERNAL",
    source: "CLIENT_APP",
    arrived: (now) => previousBusinessDayAt(now, 1, 13, 15),
    accountType: "rollover-ira",
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    description: "Why is my Q3 advisory fee higher than Q2's?",
    comments: [
      reply(
        "staff_helen",
        30,
        "Hello Maeve, thanks for asking. The quarterly fee is a percentage of the account's value, so it moves with " +
          "the balance. I have asked Rachel to walk you through the Q3 calculation and will follow up by tomorrow.",
      ),
      note("staff_helen", 35, "asked Rachel for the Q3 fee detail."),
      note("staff_rachel", 90, "same rate both quarters. The rollover IRA funded mid-Q2, so Q3 is the first full quarter on the higher balance. Happy to call her."),
    ],
    viewTarget: "ON_TRACK",
  },
  "HD-2463": {
    category: "COMPLAINT",
    status: "OPEN",
    source: "PHONE",
    arrived: (now) => previousBusinessDayAt(now, 1, 10, 50),
    accountType: "joint-taxable",
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    externalRef: "Transfer T-312",
    description:
      "Tom called, upset that the transfer from BNY has not started. He says no one told him a medallion " +
      "signature was needed, and he wants a written explanation.",
    isComplaint: true,
    escalationTarget: "COMPLIANCE",
    flaggedAtMin: 10,
    comments: [
      reply(
        "staff_helen",
        12,
        "Hello Tom, I am sorry about the delay and that this was not explained sooner. BNY requires a " +
          "medallion signature guarantee for this kind of transfer. I have sent you the steps and where to get one, " +
          "and our compliance team is reviewing how this was handled. I will call you tomorrow with an update.",
      ),
      note("staff_helen", 15, "logged as a complaint and escalated to compliance. T-312 is in paperwork: non-ACAT, medallion signature missing."),
      note("staff_sam", 60, "reviewed the call notes. The medallion requirement was in the packet but not called out. Over to Priya for the supervisory review."),
    ],
    viewTarget: "ON_TRACK",
  },
  "HD-2468": {
    category: "ADDRESS_CHANGE",
    status: "PENDING_CLIENT",
    source: "EMAIL",
    externalId: "<hd-2468.old-address@mail.example.com>",
    arrived: (now) => previousBusinessDayAt(now, 2, 11, 30),
    accountType: "traditional-ira",
    createdById: "staff_helen",
    assigneeId: "staff_helen",
    description: "Our September statement still shows our old mailing address. We moved in the summer.",
    comments: [
      reply(
        "staff_helen",
        25,
        "Hello Ken, thank you for letting us know. To change the mailing address we need to confirm it with you " +
          "directly. Please call us or reply with the new address, and we will update it and send a confirmation " +
          "to both addresses.",
      ),
      note("staff_helen", 28, "statement page attached shows the old address. Address change needs a verbal confirmation after the usual identity checks."),
    ],
    attachments: [{ id: "att-nakamura-statement-page", uploaderId: "staff_helen", atMin: 27 }],
    viewTarget: "ON_TRACK",
  },
};

export function storyFixtures(universe: Universe, now: Date): TicketFixture[] {
  return universe.stories.helpdesk.map((story): TicketFixture => {
    const detail = STORIES[story.id];
    if (!detail) throw new Error(`no help desk detail for universe story ${story.id}`);
    const { arrived, accountType, phoneOnly, ...rest } = detail;
    const requester = findPersonByName(universe, story.requester);
    if (requester.household !== story.household) throw new Error(`${story.id}: ${story.requester} is not in ${story.household}`);
    const fixture: TicketFixture = {
      ...rest,
      ref: story.id,
      number: Number(story.id.slice(3)),
      subject: story.subject,
      priority: PRIORITY[story.priority],
      requesterName: personName(requester),
      requesterEmail: phoneOnly ? null : requester.email,
      clientReference: clientReference(universe, requester, accountType),
      createdMinAgo: minutesBetween(arrived(now), now),
    };
    if (detail.source === "PHONE") fixture.requesterPhone = e164(requester.phone);
    return fixture;
  });
}

// ---------------------------------------------------------------------------
// Timing the open tickets for the viewing day
// ---------------------------------------------------------------------------

/**
 * Two adjustments, because SLA clocks run around the clock and the nightly reset runs hours before anyone
 * looks.
 *
 * First, the hand-written tickets were written as "N minutes ago" for a desk viewed the moment it was
 * seeded. They are dated back from `close`, the desk's last working moment, instead of from the reset, so
 * their threads happen during the working day. Their designed SLA states then hold at that close
 * (`slaAt: "CLOSE"`).
 *
 * Second, each open ticket the desk has already answered gets its resolution due time moved into the first
 * viewing day: tickets meant to read WARNING fall due 20 minutes after the desk opens, the rest are spread
 * across the working day (`slaAt: "VIEW"`). A ticket is only moved when all of its activity still fits
 * before the reset; one that cannot (an eight-hour clock overnight) keeps its timing and reads breached by
 * morning, as it would on a real desk.
 */
export function placeForViewing(
  fixtures: readonly TicketFixture[],
  timing: { now: Date; close: Date; viewStart: Date; policies: ReadonlyMap<TicketPriority, SlaPolicyInput> },
): TicketFixture[] {
  const { now, close, viewStart, policies } = timing;
  const sinceClose = minutesBetween(close, now);
  const targetOf = (f: TicketFixture): "ON_TRACK" | "WARNING" | null => {
    if (!["OPEN", "PENDING_CLIENT", "PENDING_INTERNAL"].includes(f.status)) return null;
    if (!f.comments.some((c) => c.visibility === "PUBLIC")) return null;
    if (f.viewTarget) return f.viewTarget;
    const s = f.expectSla;
    return s?.phase === "RESOLUTION" && (s.status === "ON_TRACK" || s.status === "WARNING") ? s.status : null;
  };
  const lastEventOf = (f: TicketFixture): number =>
    Math.max(0, ...f.comments.map((c) => c.atMin), ...(f.attachments ?? []).map((a) => a.atMin), f.flaggedAtMin ?? 0);
  // The longest threads take the earliest slots: a ticket's creation keeps its due time's time of day, so
  // an early slot leaves the most of the previous working day for its replies.
  const slotOrder = (target: "ON_TRACK" | "WARNING") =>
    fixtures
      .filter((f) => targetOf(f) === target)
      .sort((a, b) => lastEventOf(b) - lastEventOf(a) || a.ref.localeCompare(b.ref))
      .map((f) => f.ref);
  const onTrack = slotOrder("ON_TRACK");
  const warning = slotOrder("WARNING");
  const dueAt = new Map<string, Date>();
  warning.forEach((ref, i) => dueAt.set(ref, new Date(viewStart.getTime() + (20 + (i % 4) * 2) * MINUTE)));
  // From 75 minutes after opening to the end of an eight-hour day, evenly.
  const span = 8 * 60 - 75;
  onTrack.forEach((ref, i) =>
    dueAt.set(ref, new Date(viewStart.getTime() + (75 + Math.round((span * i) / Math.max(1, onTrack.length - 1))) * MINUTE)),
  );

  return fixtures.map((written) => {
    // Stories carry their own arrival times; the hand-written tickets are dated back from the close.
    let f: TicketFixture =
      written.number !== undefined || sinceClose === 0
        ? written
        : { ...written, createdMinAgo: written.createdMinAgo + sinceClose, ...(written.expectSla ? { slaAt: "CLOSE" as const } : {}) };
    // A settled hand-written ticket (finished, voided, or long past due) starts on a business-day morning
    // instead: "four days ago" from a Wednesday close is a Saturday evening. Starting earlier only makes
    // it older, which leaves a finished ticket's verdict and an overdue one's breach exactly as designed.
    const settled = ["RESOLVED", "CLOSED", "VOIDED"].includes(f.status) || f.expectSla?.status === "BREACHED";
    if (written.number === undefined && settled && f.expectSla?.phase !== "FIRST_RESPONSE") {
      const arrived = new Date(now.getTime() - f.createdMinAgo * MINUTE);
      const morning = atFirmTime(businessDayOnOrBefore(firmDay(arrived)), 9, seededInt(`${f.ref}:start`, 0, 150));
      f = { ...f, createdMinAgo: Math.max(f.createdMinAgo, minutesBetween(morning, now)) };
    }
    const due = dueAt.get(f.ref);
    if (!due) return f;
    const priority = f.priority ?? routeCategory(f.category).priority;
    const policy = policies.get(priority);
    if (!policy) throw new Error(`no SLA policy for ${priority}`);
    // The ticket's own activity must land before the reset and in staff hours. An on-track ticket that
    // would start at a weekend starts on the next business day instead; a later due time keeps it on track.
    const target = targetOf(f) as "ON_TRACK" | "WARNING";
    const exact = new Date(due.getTime() - policy.resolutionMinutes * MINUTE);
    const fits = (start: Date) =>
      minutesBetween(start, now) > lastEventOf(f) &&
      [0, ...f.comments.map((c) => c.atMin), ...(f.attachments ?? []).map((a) => a.atMin), f.flaggedAtMin ?? 0].every((m) =>
        inStaffHours(new Date(start.getTime() + m * MINUTE)),
      );
    const start = [target === "ON_TRACK" ? sameTimeNextBusinessDay(exact) : null, exact].find((x) => x !== null && fits(x));
    if (!start) return f; // its thread would run past the reset or into the night: keep its own timing
    const createdMinAgo = minutesBetween(start, now);
    return {
      ...f,
      createdMinAgo,
      expectSla: { phase: "RESOLUTION", status: target },
      slaAt: "VIEW",
    };
  });
}

// ---------------------------------------------------------------------------
// History: about 150 resolved tickets over the last nine weeks of business days
// ---------------------------------------------------------------------------

const HISTORY_COUNT = 150;
const HISTORY_BUSINESS_DAYS = 45;
/** Resolved tickets close after three days, as the auto-close job would; older than this they read CLOSED. */
const CLOSE_AFTER_MIN = 3 * 24 * 60;

type CategoryText = { subjects: readonly string[]; ask: string; reply: string; internal: string; done: string };

/** One short script per category. `{first}` is the requester's first name. */
const HISTORY_TEXT: Record<TicketCategory, CategoryText> = {
  WIRE_TRANSFER: {
    subjects: ["Wire to my bank account", "Outgoing wire for a property purchase", "Wire request for tuition payment"],
    ask: "Client asked for a wire from their account and supplied the receiving bank's instructions.",
    reply: "Hello {first}, we have your wire request. We will confirm the instructions with you by phone before anything is sent.",
    internal: "instructions confirmed on a call-back to the number on file.",
    done: "Hello {first}, the wire has been sent. Please allow one business day for it to arrive.",
  },
  ACAT: {
    subjects: ["Transfer status from my old brokerage", "When will my transfer arrive?", "Transfer paperwork question"],
    ask: "Client asked where their incoming transfer stands.",
    reply: "Hello {first}, the transfer is with the delivering firm. We will let you know as soon as the assets arrive.",
    internal: "control number checked with the clearing firm; no rejects.",
    done: "Hello {first}, your transfer has settled and the assets are now in your account.",
  },
  TRADE_CORRECTION: {
    subjects: ["Trade booked on the wrong account", "Duplicate purchase on my statement"],
    ask: "Client spotted a trade that does not match what they asked for.",
    reply: "Hello {first}, thank you for flagging this. We are reviewing the trade with the trading desk now.",
    internal: "trading confirmed the error; correction booked at no cost to the client.",
    done: "Hello {first}, the trade has been corrected at no cost to you. The correction will show on your next statement.",
  },
  CASH_MOVEMENT: {
    subjects: ["Move cash between my accounts", "ACH to my checking account", "Set up a monthly transfer"],
    ask: "Client asked to move cash out of or between their accounts.",
    reply: "Hello {first}, we have your request and will submit it today.",
    internal: "bank link verified before submitting.",
    done: "Hello {first}, the transfer has been submitted and should arrive within two business days.",
  },
  PORTAL_RESET: {
    subjects: ["Locked out of the client portal", "Password reset not arriving", "Can't log in after an update"],
    ask: "Client cannot sign in to the portal.",
    reply: "Hello {first}, we have sent you a reset link. It expires in an hour, so please use it soon.",
    internal: "identity confirmed on the call before sending the reset.",
    done: "Hello {first}, glad you are back in. Let us know if anything else looks off.",
  },
  TAX_DOCUMENT: {
    subjects: ["Where is my 1099?", "Corrected tax form needed", "Tax documents for my accountant"],
    ask: "Client asked about their tax documents.",
    reply: "Hello {first}, your tax documents post to the Documents tab as the custodian releases them. We will check on yours.",
    internal: "custodian confirmed the release date.",
    done: "Hello {first}, your tax documents are now in the Documents tab.",
  },
  ADDRESS_CHANGE: {
    subjects: ["New mailing address", "Update my address after a move", "Seasonal address change"],
    ask: "Client asked to update their mailing address.",
    reply: "Hello {first}, we will update your address once we have confirmed it with you by phone.",
    internal: "confirmed verbally after identity checks.",
    done: "Hello {first}, your address has been updated. A confirmation has been sent to both addresses.",
  },
  REBALANCING: {
    subjects: ["Rebalance after a deposit", "My portfolio looks off target", "Rebalance before year end"],
    ask: "Client asked about rebalancing their portfolio.",
    reply: "Hello {first}, thank you. We are reviewing your allocation against your model now.",
    internal: "drift checked against the model; trades queued for the next window.",
    done: "Hello {first}, your portfolio has been rebalanced to its target.",
  },
  PLANNING_UPDATE: {
    subjects: ["Update my retirement date", "Add a goal to my plan", "Planning review request"],
    ask: "Client asked to update their financial plan.",
    reply: "Hello {first}, thank you for the update. We will reflect it in your plan before our next review.",
    internal: "plan inputs updated; review scheduled.",
    done: "Hello {first}, your plan has been updated. We will walk through it at your next review.",
  },
  TAX_LOSS_HARVESTING: {
    subjects: ["Harvest losses this year?", "Tax-loss harvesting question"],
    ask: "Client asked about harvesting losses.",
    reply: "Hello {first}, we will review your taxable accounts for harvesting opportunities and get back to you.",
    internal: "candidates reviewed; wash-sale windows checked.",
    done: "Hello {first}, the harvest trades are complete and the replacement holdings are in place.",
  },
  OTHER: {
    subjects: ["General question about my account", "Question about my statement", "Who is my contact?"],
    ask: "Client had a general question about their account.",
    reply: "Hello {first}, thanks for reaching out. We are looking into this for you.",
    internal: "answered from the account notes.",
    done: "Hello {first}, we hope that answers your question. Let us know if anything else comes up.",
  },
  ACCOUNT_CLOSURE: {
    subjects: ["Close my empty account", "Close an old IRA"],
    ask: "Client asked to close an account.",
    reply: "Hello {first}, we have your request and will confirm the account has no remaining balance before closing it.",
    internal: "zero balance confirmed; closure submitted.",
    done: "Hello {first}, the account has been closed.",
  },
  BENEFICIARY_TOD: {
    subjects: ["Update my beneficiaries", "Add a transfer-on-death beneficiary"],
    ask: "Client asked to change their beneficiaries.",
    reply: "Hello {first}, we have sent the beneficiary form for your signature.",
    internal: "signed form received and checked.",
    done: "Hello {first}, your beneficiary change has been recorded.",
  },
  RETURNED_CHECK: {
    subjects: ["Check returned to the firm", "Distribution check came back"],
    ask: "A check to the client was returned undelivered.",
    reply: "Hello {first}, a check we sent you came back to us. Could you confirm your mailing address?",
    internal: "address confirmed; check voided and reissued.",
    done: "Hello {first}, a replacement check is on its way.",
  },
  RETURNED_MAIL: {
    subjects: ["Statement returned undeliverable", "Mail came back to the firm"],
    ask: "Mail to the client was returned undelivered.",
    reply: "Hello {first}, some of our mail to you came back. Could you confirm your mailing address?",
    internal: "address confirmed by phone.",
    done: "Hello {first}, thank you. Your address is confirmed and mail will resume.",
  },
  PASSKEY_LOGIN: {
    subjects: ["Passkey not working on a new phone", "Set up a passkey", "Lost the device with my passkey"],
    ask: "Client cannot sign in with their passkey.",
    reply: "Hello {first}, a passkey belongs to the device that created it, so a new device needs a new one. We have sent you a link to set it up.",
    internal: "old passkey revoked after identity checks.",
    done: "Hello {first}, your new passkey is working. Nothing else is needed.",
  },
  IDENTITY_VERIFICATION: {
    subjects: ["Name change after marriage", "Documents for a profile change"],
    ask: "Client asked for a change that needs identity documents.",
    reply: "Hello {first}, to make this change we need a copy of a government-issued ID. You can upload it through the secure portal.",
    internal: "documents reviewed and matched.",
    done: "Hello {first}, your profile has been updated.",
  },
  COMPLAINT: {
    subjects: ["Unhappy with how long my request took", "Complaint about a missed call-back"],
    ask: "Client complained about the service they received.",
    reply: "Hello {first}, I am sorry for the trouble. I have passed this to our compliance team and will follow up personally.",
    internal: "logged as a complaint; compliance notified.",
    done: "Hello {first}, thank you for your patience. We have reviewed what happened and changed how we handle these requests.",
  },
  RETIREMENT_DISTRIBUTION: {
    subjects: ["Required minimum distribution", "IRA withdrawal request", "Change my distribution withholding"],
    ask: "Client asked for a distribution from their IRA.",
    reply: "Hello {first}, we have your distribution request and will confirm the withholding with you before it is paid.",
    internal: "withholding election confirmed on the form.",
    done: "Hello {first}, your distribution has been paid.",
  },
  COST_BASIS: {
    subjects: ["Cost basis missing after my transfer", "Cost basis looks wrong"],
    ask: "Client asked about cost basis on transferred holdings.",
    reply: "Hello {first}, cost basis follows the assets from the delivering firm, usually within a few days. We will check on it.",
    internal: "basis file received from the delivering firm.",
    done: "Hello {first}, the cost basis has been updated on your holdings.",
  },
  VOICEMAIL_CALLBACK: {
    subjects: ["Voicemail: please call back", "Voicemail about an account question"],
    ask: "Client left a voicemail asking for a call back.",
    reply: "Hello {first}, we got your message and tried you back. We will try again this afternoon.",
    internal: "reached the client on the second try.",
    done: "Hello {first}, thanks for taking our call. Glad we could help.",
  },
  STATEMENT_REQUEST: {
    subjects: ["Copies of past statements", "Statements for a loan application"],
    ask: "Client asked for copies of past statements.",
    reply: "Hello {first}, past statements are in the Documents tab. We will pull together the ones you need.",
    internal: "statements combined into one file.",
    done: "Hello {first}, the statements are in your Documents tab now.",
  },
};

/** How a request reached the desk, weighted toward email. Every source appears at least once. */
const SOURCE_WEIGHTS: ReadonlyArray<readonly [TicketSource, number]> = [
  ["EMAIL", 45],
  ["CLIENT_APP", 15],
  ["PHONE", 15],
  ["STAFF_FORM", 12],
  ["VOICEMAIL", 6],
  ["SLACK", 3],
  ["SYSTEM", 2],
  ["IMPORT", 2],
];

/** Common requests come up often; corrections and complaints rarely. */
const CATEGORY_WEIGHT: Partial<Record<TicketCategory, number>> = {
  PORTAL_RESET: 8,
  PASSKEY_LOGIN: 8,
  TAX_DOCUMENT: 7,
  ACAT: 7,
  CASH_MOVEMENT: 6,
  ADDRESS_CHANGE: 5,
  WIRE_TRANSFER: 5,
  STATEMENT_REQUEST: 5,
  REBALANCING: 5,
  RETIREMENT_DISTRIBUTION: 5,
  BENEFICIARY_TOD: 4,
  COST_BASIS: 4,
  OTHER: 4,
  PLANNING_UPDATE: 3,
  TAX_LOSS_HARVESTING: 3,
  VOICEMAIL_CALLBACK: 3,
};

function weighted<T>(key: string, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((n, [, w]) => n + w, 0);
  let at = seeded(key) * total;
  for (const [item, w] of items) {
    if ((at -= w) < 0) return item;
  }
  return items[items.length - 1]![0];
}

const QUEUE_STAFF: Record<"OPERATIONS" | "CLIENT_SERVICE", readonly StaffId[]> = {
  OPERATIONS: ["staff_marco", "staff_marco", "staff_ethan", "staff_jordan", "staff_sam"],
  CLIENT_SERVICE: ["staff_helen", "staff_helen", "staff_jordan", "staff_sam"],
};
const ADVISOR_STAFF: Record<string, StaffId> = { "rachel-moss": "staff_rachel", "dana-pruitt": "staff_dana", "sam-ortiz": "staff_sam" };

export function historyFixtures(
  universe: Universe,
  now: Date,
  policies: ReadonlyMap<TicketPriority, SlaPolicyInput>,
): TicketFixture[] {
  const today = businessDayOnOrBefore(firmDay(now));
  const categoryWeights = TICKET_CATEGORIES.map((c) => [c, CATEGORY_WEIGHT[c] ?? 1] as const);
  const out: TicketFixture[] = [];
  for (let i = 0; i < HISTORY_COUNT; i++) {
    const key = `history:${i}`;
    // The first 22 cover every category once and the next 8 every source once; the rest are drawn.
    const category = i < TICKET_CATEGORIES.length ? TICKET_CATEGORIES[i]! : weighted(`${key}:category`, categoryWeights);
    const forcedSource = i >= 22 && i < 22 + SOURCE_WEIGHTS.length ? SOURCE_WEIGHTS[i - 22]![0] : null;
    const source: TicketSource =
      category === "VOICEMAIL_CALLBACK" ? "VOICEMAIL" : (forcedSource ?? weighted(`${key}:source`, SOURCE_WEIGHTS));
    const routed = routeCategory(category);
    const priority: TicketPriority =
      seeded(`${key}:bump`) < 0.12 && routed.priority === "STANDARD" ? (seeded(`${key}:up`) < 0.5 ? "HIGH" : "LOW") : routed.priority;
    const policy = policies.get(priority);
    if (!policy) throw new Error(`no SLA policy for ${priority}`);

    const requester = pick(`${key}:requester`, universe.people);
    const household = universe.households.find((h) => h.id === requester.household);
    const assignee: StaffId =
      routed.queueKey === "ADVICE"
        ? (ADVISOR_STAFF[household?.advisor ?? ""] ?? "staff_sam")
        : pick(`${key}:assignee`, QUEUE_STAFF[routed.queueKey]);
    // Client Service logs what arrives by phone and mail; Advice tickets are opened by the advisor.
    const createdById: StaffId =
      source === "STAFF_FORM" || routed.queueKey === "ADVICE" ? assignee : pick(`${key}:intake`, ["staff_helen", "staff_jordan"] as const);

    // From two business days back: the last working day belongs to the hand-written tickets and the stories.
    const day = addBusinessDays(today, -(2 + Math.floor((i * (HISTORY_BUSINESS_DAYS - 1)) / HISTORY_COUNT)));
    const createdAt = atFirmTime(day, seededInt(`${key}:hour`, 8, 16), seededInt(`${key}:minute`, 0, 59));
    const age = minutesBetween(createdAt, now);
    const latest = new Date(now.getTime() - 60 * MINUTE);
    const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE);
    const capped = (at: Date) => (at.getTime() > latest.getTime() ? latest : at);

    // Every reply happens in staff hours on a business day. Most tickets meet both clocks; about one in
    // seven misses one, which the reports exist to show.
    const firstResponseDue = plus(createdAt, policy.firstResponseMinutes);
    const resolutionDue = plus(createdAt, policy.resolutionMinutes);
    const firstResponseAt =
      seeded(`${key}:fr-late`) < 0.07
        ? workingInstantBetween(plus(firstResponseDue, 1), plus(firstResponseDue, Math.max(policy.firstResponseMinutes, 16 * 60)), `${key}:fr`)
        : workingInstantBetween(plus(createdAt, 3), firstResponseDue, `${key}:fr`);
    const resolveFrom = plus(firstResponseAt, 20);
    const resolveLate = seeded(`${key}:res-late`) < 0.07 && plus(resolutionDue, 1).getTime() < latest.getTime();
    const resolvedAt = resolveLate
      ? workingInstantBetween(
          new Date(Math.max(plus(resolutionDue, 1).getTime(), resolveFrom.getTime())),
          capped(plus(resolutionDue, Math.max(policy.resolutionMinutes * 0.7, 16 * 60))),
          `${key}:res`,
        )
      : workingInstantBetween(resolveFrom, capped(new Date(Math.max(resolveFrom.getTime(), plus(resolutionDue, -1).getTime()))), `${key}:res`);
    if (resolvedAt.getTime() > latest.getTime()) throw new Error(`${key}: history ticket too young to resolve`);
    const firstResponse = minutesBetween(createdAt, firstResponseAt);
    const resolved = minutesBetween(createdAt, resolvedAt);
    const closed = resolved + CLOSE_AFTER_MIN < age - 60;

    const text = HISTORY_TEXT[category];
    const first = requester.first;
    const fill = (s: string) => s.replaceAll("{first}", first);
    const comments: CommentFixture[] = [{ visibility: "PUBLIC", authorId: assignee, atMin: firstResponse, body: fill(text.reply) }];
    if (seeded(`${key}:note`) < 0.5 && resolved - firstResponse > 10) {
      const noteAt = workingInstantBetween(plus(firstResponseAt, 1), plus(resolvedAt, -5), `${key}:note-at`);
      comments.push(note(assignee, Math.min(minutesBetween(createdAt, noteAt), resolved - 2), text.internal));
    }
    comments.push({ visibility: "PUBLIC", authorId: assignee, atMin: resolved - 1, body: fill(text.done) });

    const phone = source === "PHONE" || source === "VOICEMAIL";
    const fixture: TicketFixture = {
      ref: `HIST-${String(i + 1).padStart(3, "0")}`,
      category,
      priority,
      status: closed ? "CLOSED" : "RESOLVED",
      createdMinAgo: age,
      createdById,
      assigneeId: assignee,
      subject: pick(`${key}:subject`, text.subjects),
      description: text.ask,
      clientReference: clientReference(universe, requester),
      requesterName: personName(requester),
      requesterEmail: requester.email,
      ...(phone ? { requesterPhone: e164(requester.phone) } : {}),
      source,
      resolvedAtMin: resolved,
      ...(closed ? { closedAtMin: resolved + CLOSE_AFTER_MIN } : {}),
      comments,
    };
    if (category === "COMPLAINT") {
      Object.assign(fixture, { isComplaint: true, escalationTarget: "COMPLIANCE", flaggedAtMin: Math.max(0, firstResponse - 1) });
    }
    out.push(fixture);
  }
  return out;
}
