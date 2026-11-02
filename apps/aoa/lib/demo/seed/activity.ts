// Demo seed part: what the CRM and the help desk record about each household: logged calls, client email, open and
// completed tasks, the advisors' upcoming meetings (the Command Center's Meetings card) and the old help desk's
// ticket history. Written as the ingest login in the shapes the CRM, appointments and help-desk feeds deliver
// (app/api/ingest/*), each feed with the audit row its endpoint writes. The story households carry their stories
// (the wire for a closing, the partial transfer, the required minimum distribution …); the rest get the ordinary
// rhythm of reviews and check-ins.

import { appointmentKey, etWallClockToUtc } from "@/lib/data/appointments";
import {
  INGEST_ACTIVITY, INGEST_APPOINTMENTS, INGEST_EMAILS, INGEST_TASKS, INGEST_ZENDESK_TICKETS,
} from "@/lib/audit";
import { insertRows, type Row } from "./batch";
import { addBusinessDays, addCalendarDays, businessInstant, firmToday, isFirmBusinessDay } from "./calendar";
import type { SeedContext } from "./context";
import {
  membersOf, pick, seeded, seededInt, staffEmail, staffOf, staffSfId, type Universe, type UniverseHousehold,
} from "./universe";

/** Where a help-desk ticket opens: the help desk demo (the firm's help desk; its tickets have no fixed address). */
export const HELP_DESK_INBOX_URL = "https://helpdesk.jeremyhamann.dev/inbox";

// CRM-shaped ids: calls, tasks and emails are CRM Tasks (00T…) and an email's message is 02s….
const sfId = (prefix: string, kind: string, n: number) => `${prefix}DEMO${kind}${String(n).padStart(7, "0")}`;

interface Note { daysAgo: number; subject: string; note: string }
interface Email { daysAgo: number; subject: string; body: string; fromClient: boolean }
interface Task {
  subject: string;
  status: "Open" | "In Progress" | "Completed";
  priority: "High" | "Normal" | "Low";
  description: string;
  assignee?: string;
  daysAgo: number;
}

// The story households' CRM history, told the way the universe's stories tell it (stories.helpdesk/trade/transfers).
const STORY: Record<string, { calls: Note[]; emails: Email[]; tasks: Task[]; meeting: string }> = {
  alvarez: {
    meeting: "Planning Meeting",
    calls: [
      { daysAgo: 1, subject: "Call: wire for Friday closing", note: "Lucia called about wiring $85,000 to the title company for Friday's closing. Asked her to send the wire instructions through the portal; we confirm them by phone on the number on file. Raise-cash request opened for the trade desk." },
      { daysAgo: 12, subject: "Call: Schwab transfer complete", note: "Confirmed the Schwab transfer settled in full. Walked Daniel through the new account view." },
      { daysAgo: 48, subject: "Annual review", note: "Reviewed the Balanced 60/40 model. Home purchase this fall: plan to raise cash from the joint account when the closing date is set." },
    ],
    emails: [
      { daysAgo: 1, subject: "Wire instructions for the closing", body: "Hi Rachel, the title company sent wire instructions for Friday. I'll upload them to the portal now. Thank you! Lucia", fromClient: true },
      { daysAgo: 1, subject: "Re: Wire instructions for the closing", body: "Thanks, Lucia. Once they're in the portal, Marco will call you on the number we have on file to confirm them before anything is sent. Rachel", fromClient: false },
    ],
    tasks: [
      { subject: "Confirm wire instructions by call-back", status: "In Progress", priority: "High", description: "Call-back on the number on file before the closing wire goes out.", assignee: "marco-ferreira", daysAgo: 1 },
      { subject: "Send transfer completion letter", status: "Completed", priority: "Normal", description: "Schwab transfer settled in full.", assignee: "helen-carver", daysAgo: 11 },
    ],
  },
  okafor: {
    meeting: "Transfer Kickoff",
    calls: [
      { daysAgo: 3, subject: "Call: Edward Jones transfer update", note: "Told Ada the Edward Jones transfer is pending settlement. The Bridge Builder fund can't move in kind, so Edward Jones sells it first and the proceeds arrive as cash. Rebalance into Growth 80/20 once everything lands." },
      { daysAgo: 9, subject: "Call: Roth IRA beneficiary", note: "Ada wants to update the Roth IRA beneficiary. Sent the beneficiary form; Helen is tracking it in the help desk." },
      { daysAgo: 21, subject: "Statement review", note: "Went through the September Edward Jones statement: three accounts, one option position in the individual account that we'll close before transfer." },
    ],
    emails: [
      { daysAgo: 9, subject: "Roth IRA beneficiary form", body: "Hi Ada, attached is the beneficiary designation form for the Roth IRA. Sign where flagged and send it back through the portal. Helen", fromClient: false },
      { daysAgo: 4, subject: "Transfer timing", body: "Rachel, any update on when the Edward Jones accounts will show up? Kofi", fromClient: true },
      { daysAgo: 3, subject: "Re: Transfer timing", body: "Hi Kofi, it's pending settlement now. Most positions arrive in kind this week; the Bridge Builder fund is sold first and comes over as cash. Rachel", fromClient: false },
    ],
    tasks: [
      { subject: "Rebalance to Growth 80/20 after settlement", status: "Open", priority: "Normal", description: "Trade request is in review; release once the transfer settles.", assignee: "rachel-moss", daysAgo: 3 },
      { subject: "Collect signed Roth IRA beneficiary form", status: "In Progress", priority: "Normal", description: "Form sent; waiting on the client's signature.", assignee: "helen-carver", daysAgo: 9 },
    ],
  },
  "chen-ashby": {
    meeting: "Quarterly Check-In",
    calls: [
      { daysAgo: 2, subject: "Call: can't sign in", note: "Grace changed phones and can't get past two-factor. Help desk ticket opened; client service to reset her sign-in." },
      { daysAgo: 22, subject: "Call: Edward Jones transfer settled", note: "Confirmed the transfer completed. One fund came over a share short; operations is reconciling it." },
    ],
    emails: [
      { daysAgo: 2, subject: "Locked out of my account", body: "Hi, I got a new phone and now the app won't let me sign in. Can someone help? Grace", fromClient: true },
    ],
    tasks: [
      { subject: "Reset two-factor sign-in", status: "Open", priority: "High", description: "Client changed phones. Verify identity by call-back before resetting.", daysAgo: 2 },
    ],
  },
  "patel-trust": {
    meeting: "Trustee Review",
    calls: [
      { daysAgo: 4, subject: "Call: Edward Jones transfer pending", note: "Ravi asked why the Edward Jones transfer is still pending. It was submitted two days ago; told him the usual timing is about a week." },
      { daysAgo: 6, subject: "Model change to Balanced 60/40", note: "Trustees approved moving the trust to Balanced 60/40. Trade request approved." },
    ],
    emails: [
      { daysAgo: 4, subject: "Transfer still pending?", body: "Dana, the Edward Jones account still shows everything there. Is the transfer moving? Ravi", fromClient: true },
    ],
    tasks: [
      { subject: "Follow up on Edward Jones transfer", status: "Open", priority: "Normal", description: "Check the transfer status and update the trustees.", assignee: "marco-ferreira", daysAgo: 4 },
    ],
  },
  lindqvist: {
    meeting: "Annual Review",
    calls: [
      { daysAgo: 6, subject: "Call: 2026 required minimum distribution", note: "Erik confirmed the RMD amount. Raise-cash request completed; distribution goes out with 10% withholding." },
      { daysAgo: 2, subject: "Call: Fidelity transfer", note: "The Fidelity transfer was accepted; settlement expected in a few days." },
    ],
    emails: [
      { daysAgo: 7, subject: "RMD for this year", body: "Hi Dana, please go ahead with this year's required distribution, same withholding as last year. Erik", fromClient: true },
    ],
    tasks: [
      { subject: "Process 2026 RMD", status: "Completed", priority: "High", description: "Distribution sent with 10% federal withholding.", assignee: "marco-ferreira", daysAgo: 5 },
    ],
  },
  brennan: {
    meeting: "Tax Planning",
    calls: [
      { daysAgo: 3, subject: "Call: Q3 advisory fee", note: "Maeve asked how the Q3 fee was calculated. Walked through the average daily balance and the household's tier." },
      { daysAgo: 8, subject: "Tax-loss harvesting", note: "Agreed to harvest losses in the bond funds before year end. Trade request executing." },
    ],
    emails: [
      { daysAgo: 3, subject: "Question about the Q3 fee", body: "Hi, the Q3 fee looks higher than last quarter. Can you explain? Maeve", fromClient: true },
    ],
    tasks: [
      { subject: "Send Q3 fee explanation", status: "Open", priority: "Normal", description: "Written summary of the fee calculation for the client.", assignee: "helen-carver", daysAgo: 3 },
    ],
  },
  nakamura: {
    meeting: "Transfer Kickoff",
    calls: [
      { daysAgo: 3, subject: "Call: Schwab transfer paperwork", note: "The Schwab transfer is waiting on Emi's signature on the joint account form. Ken will have her sign this week. Also asked for a newer statement: the one on file is from March." },
      { daysAgo: 5, subject: "Call: mailing address", note: "Ken's statements still show the old mailing address. Help desk ticket opened to update it." },
    ],
    emails: [
      { daysAgo: 3, subject: "Joint owner signature needed", body: "Hi Ken, the Schwab transfer form needs Emi's signature too. I've sent it to both of you. Jordan", fromClient: false },
    ],
    tasks: [
      { subject: "Get joint owner signature", status: "Open", priority: "High", description: "Transfer paperwork can't go to Schwab without both owners' signatures.", assignee: "jordan-reyes", daysAgo: 3 },
      { subject: "Request current Schwab statement", status: "Open", priority: "Normal", description: "The March statement is too old for the transfer.", assignee: "helen-carver", daysAgo: 3 },
    ],
  },
  morgan: {
    meeting: "Quarterly Check-In",
    calls: [
      { daysAgo: 4, subject: "Call: complaint", note: "Tom raised a complaint about a delayed distribution last month. Logged for compliance review." },
      { daysAgo: 1, subject: "Call: BNY transfer", note: "BNY needs a medallion signature guarantee for the non-ACAT transfer. Explained where to get one." },
    ],
    emails: [
      { daysAgo: 1, subject: "Medallion signature guarantee", body: "Hi Tom, BNY requires a medallion signature guarantee on the transfer form. Most banks can provide one. Sam", fromClient: false },
    ],
    tasks: [
      { subject: "Compliance review of complaint", status: "In Progress", priority: "High", description: "Complaint logged; compliance to review and respond in writing.", assignee: "priya-nair", daysAgo: 4 },
    ],
  },
  rossi: {
    meeting: "Transfer Kickoff",
    calls: [
      { daysAgo: 5, subject: "Call: Fidelity transfer rejected", note: "Fidelity rejected the transfer: the account there is titled with a Jr. suffix. Resubmitting with the exact title." },
    ],
    emails: [],
    tasks: [
      { subject: "Resubmit transfer with exact account title", status: "Open", priority: "High", description: "Title must match the Fidelity account, including the Jr. suffix.", assignee: "jordan-reyes", daysAgo: 5 },
    ],
  },
  "delgado-trust": {
    meeting: "Trustee Review",
    calls: [
      { daysAgo: 7, subject: "Call: trust statement", note: "Received the Schwab statement for the revocable trust. Trust accounts need the trust certification before we can map them." },
    ],
    emails: [
      { daysAgo: 7, subject: "Trust certification", body: "Hi Marisol, to move the trust account we need a copy of the trust certification. Rachel", fromClient: false },
    ],
    tasks: [
      { subject: "Collect trust certification", status: "Open", priority: "Normal", description: "Needed before the trust account can be mapped and transferred.", assignee: "helen-carver", daysAgo: 7 },
    ],
  },
};

const ROUTINE_CALLS = [
  ["Quarterly check-in", "Reviewed performance and cash needs. No changes."],
  ["Annual review", "Reviewed goals, beneficiaries and the model. Client is comfortable with the current allocation."],
  ["Call: RMD planning", "Talked through next year's required distribution and withholding."],
  ["Call: contribution", "Client plans to add to the IRA before the deadline."],
  ["Call: address update", "Confirmed the new mailing address."],
  ["Planning meeting", "Updated the retirement projection with the new savings rate."],
] as const;
const ROUTINE_TASKS = [
  ["Schedule annual review", "Normal"],
  ["Send updated financial plan", "Normal"],
  ["Confirm beneficiaries on file", "Low"],
  ["Update risk questionnaire", "Low"],
] as const;
const MEETING_TYPES = ["Annual Review", "Quarterly Check-In", "Planning Meeting", "Intro Call"];

export async function seedActivity(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe, ingest, owner, now } = ctx;
  const staffName = (id: string) => staffOf(universe, id).name;
  const userSfId = (id: string) => staffSfId(universe, id);
  // A logged moment `daysAgo` business days back; today's never lands after `now`.
  const at = (daysAgo: number, key: string) => {
    const day = addBusinessDays(ctx.today, -daysAgo);
    return daysAgo === 0 ? ctx.at(day, key) : businessInstant(day, key);
  };
  const n = { calls: 0, emails: 0, tasks: 0, appointments: 0, tickets: 0, comments: 0 };
  // Each feed's rows go in as one statement per table (batch.ts).
  const rows: Record<"activity" | "email" | "task" | "appointment" | "zendesk_ticket" | "zendesk_ticket_comment", Row[]> = {
    activity: [], email: [], task: [], appointment: [], zendesk_ticket: [], zendesk_ticket_comment: [],
  };

  for (const [index, h] of universe.households.entries()) {
    const household = ctx.householdId.get(h.id)!;
    const advisor = staffOf(universe, h.advisor);
    const members = membersOf(universe, h.id);
    const story = STORY[h.id] ?? routine(universe, h);

    for (const c of story.calls) {
      const id = sfId("00T", "C", ++n.calls);
      const when = at(c.daysAgo, id);
      rows.activity.push({
        sf_id: id, household_sf_id: household, subject: c.subject, note: c.note, activity_at: when, owner_name: advisor.name,
        source_modified_at: when, synced_at: now,
      });
    }

    for (const e of story.emails) {
      const id = sfId("00T", "E", ++n.emails);
      const when = at(e.daysAgo, id);
      const client = { name: `${members[0].first} ${members[0].last}`, address: members[0].email };
      const firm = { name: advisor.name, address: staffEmail(advisor) };
      const envelope = {
        version: 1, state: "MATCHED", task_sf_id: id, message_sf_id: sfId("02s", "M", n.emails),
        observed_at: now.toISOString(), source_modified_at: when.toISOString(),
        sender: e.fromClient ? client : firm, to: [e.fromClient ? firm : client], cc: [],
      };
      rows.email.push({
        sf_id: id, household_sf_id: household, subject: e.subject, body: e.body, sent_at: when, source_modified_at: when,
        email_envelope: envelope, synced_at: now,
      });
    }

    for (const t of story.tasks) {
      const id = sfId("00T", "T", ++n.tasks);
      const when = at(t.daysAgo, id);
      const assignee = t.assignee ?? null;
      rows.task.push({
        sf_id: id, household_sf_id: household, subject: t.subject, status: t.status, priority: t.priority,
        description: t.description || null, source_modified_at: when, assignment_state: assignee ? "ASSIGNED" : "UNASSIGNED",
        assignee_sf_id: assignee ? userSfId(assignee) : null, assignee_type: assignee ? "USER" : null,
        assignee_name: assignee ? staffName(assignee) : null, assignment_observed_at: now, synced_at: now,
      });
    }

    // Upcoming meetings, as the appointments digest lists them: every story household and about a third of the
    // rest, over the next two weeks from tomorrow.
    if (h.story || seeded(`${h.id}:meeting`) < 0.35) {
      let day = addCalendarDays(firmToday(now), 1 + (h.story ? index % 8 : seededInt(`${h.id}:meeting-day`, 0, 9)));
      while (!isFirmBusinessDay(day)) day = addCalendarDays(day, 1);
      const hour = seededInt(`${h.id}:meeting-hour`, 9, 16);
      const minute = pick(`${h.id}:meeting-minute`, [0, 0, 30]);
      const [y, m, d] = day.split("-");
      const dateText = `${Number(m)}/${Number(d)}/${y}`;
      const timeText = `${hour > 12 ? hour - 12 : hour}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
      const startsAt = etWallClockToUtc(dateText, timeText)!;
      const clientName = `${members[0].first} ${members[0].last}`;
      const source = "slack-appointments-feed";
      const type = STORY[h.id]?.meeting ?? pick(`${h.id}:meeting-type`, MEETING_TYPES);
      rows.appointment.push({
        external_key: appointmentKey(source, clientName, startsAt.toISOString()), source, client_name: clientName,
        client_sf_id: ctx.personId.get(members[0].id)!, advisor_name: advisor.name, meeting_type: type, starts_at: startsAt,
        date_text: dateText, time_text: timeText, slack_ts: String(Math.floor(now.getTime() / 1000)), synced_at: now,
      });
      n.appointments++;
    }
  }

  // The help desk's history (the universe's help-desk stories), each from its requester, with the public replies.
  for (const [index, t] of universe.stories.helpdesk.entries()) {
    const person = universe.people.find((p) => p.household === t.household && `${p.first} ${p.last}` === t.requester)
      ?? membersOf(universe, t.household)[0];
    const requester = String(9_000_100 + universe.people.indexOf(person));
    const ticketId = t.id.replace(/\D/g, "");
    const opened = businessInstant(addBusinessDays(ctx.today, -(1 + (index % 6))), `${t.id}:opened`);
    const solved = t.priority === "low";
    rows.zendesk_ticket.push({
      zendesk_ticket_id: ticketId, requester_id: requester, client_sf_id: ctx.personId.get(person.id)!,
      household_sf_id: ctx.householdId.get(t.household)!, match_method: "CEDAR_RIDGE_USER_ID", subject: t.subject,
      description: t.subject, status: solved ? "solved" : t.assignee ? "open" : "new", priority: t.priority,
      ticket_type: t.queue === "money-movement" ? "task" : t.queue === "compliance-review" ? "problem" : "question",
      ticket_url: HELP_DESK_INBOX_URL, created_at: opened, source_updated_at: ctx.at(ctx.today, `${t.id}:updated`),
      comments_truncated: false, synced_at: now,
    });
    n.tickets++;
    const replies = [
      { author: requester, body: `${t.subject}. ${person.first}`, at: opened },
      ...(t.assignee
        ? [{
            author: String(8_000_000 + universe.staff.findIndex((s) => s.id === t.assignee)),
            body: `Thanks, ${person.first}. ${staffName(t.assignee)} has this and will follow up today.`,
            at: new Date(opened.getTime() + 47 * 60_000),
          }]
        : []),
    ];
    for (const [i, r] of replies.entries()) {
      rows.zendesk_ticket_comment.push({
        zendesk_comment_id: `${ticketId}${String(i + 1).padStart(3, "0")}`, zendesk_ticket_id: ticketId, author_id: r.author,
        body: r.body, created_at: r.at, synced_at: now,
      });
      n.comments++;
    }
  }
  for (const [table, list] of Object.entries(rows)) await insertRows(ingest, `mirror.${table}`, list);

  // Each feed's latest run, as its ingest endpoint records it (counts only), early this morning.
  const runs: Array<[string, string, number]> = [
    [INGEST_ACTIVITY, "activity", n.calls], [INGEST_EMAILS, "emails", n.emails], [INGEST_TASKS, "tasks", n.tasks],
    [INGEST_APPOINTMENTS, "appointments", n.appointments], [INGEST_ZENDESK_TICKETS, "zendesk-tickets", n.tickets],
  ];
  await owner.auditLog.createMany({
    data: runs.map(([action, endpoint, count], i) => ({
      at: new Date(now.getTime() - (95 - i * 6) * 60_000),
      actorRole: "INGEST",
      action,
      entityType: "ingest_run",
      entityId: `run-${endpoint}-${ctx.today}`,
      detail: JSON.stringify({ source: "crm-feed", endpoint, received: count, upserted: count, rejected: 0, dry_run: false }),
    })),
  });
  return n;
}

/** The quiet households' rhythm: a couple of logged calls, now and then a task or an email. */
function routine(universe: Universe, h: UniverseHousehold): { calls: Note[]; emails: Email[]; tasks: Task[] } {
  const calls: Note[] = [];
  const count = seededInt(`${h.id}:calls`, 1, 3);
  for (let i = 0; i < count; i++) {
    const [subject, note] = pick(`${h.id}:call:${i}`, ROUTINE_CALLS);
    calls.push({ daysAgo: seededInt(`${h.id}:call-age:${i}`, 2 + i * 30, 25 + i * 40), subject, note });
  }
  const tasks: Task[] = [];
  if (seeded(`${h.id}:task`) < 0.5) {
    const [subject, priority] = pick(`${h.id}:task-kind`, ROUTINE_TASKS);
    tasks.push({
      subject, priority, description: "", assignee: h.advisor,
      status: seeded(`${h.id}:task-done`) < 0.4 ? "Completed" : "Open", daysAgo: seededInt(`${h.id}:task-age`, 1, 20),
    });
  }
  const emails: Email[] = [];
  if (seeded(`${h.id}:email`) < 0.3) {
    const member = membersOf(universe, h.id)[0];
    emails.push({
      daysAgo: seededInt(`${h.id}:email-age`, 1, 30), subject: "Checking in", fromClient: false,
      body: `Hi ${member.first}, just checking in ahead of your next review. Let me know if anything has changed.`,
    });
  }
  return { calls, emails, tasks };
}
