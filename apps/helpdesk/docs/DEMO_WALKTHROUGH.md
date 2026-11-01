# Demo walkthrough (S8)

What was checked on the demo build before its first deploy, 2026-10-27, on a local `next dev` with demo mode on
(`NEXT_PUBLIC_DEMO_MODE=on`, `APP_ENV=demo`) against the Neon dev branch after a reset. "Clicked" means done
through the UI and the result read back; "renders" means the page loaded for the right personas with no console
errors, and its behaviour rests on the app's own tests (3,435 unit tests, 487 database tests).

## Layout: every route, five widths

A scripted pass (Playwright) over 20 routes as Marco, plus each persona's own pages as Priya, Rachel and Helen, at
360, 390, 430, 768 and 1280 px in light mode, with dark mode checked at 390 and 1280. Rules from MOBILE_FIRST.md:

- **R2, no horizontal page scroll:** none on any route at any width.
- **R3, 44 px tap targets on phones:** none below 44 px except the SLA page's auto-assignment switches, which the
  source makes tappable through a 44 px label row on purpose ("R3, fix round 1"), and the 1 px native selects that
  sit behind the styled ones.
- **R4, 16 px text in phone inputs:** none smaller.
- **Console errors:** none.
- **Access:** Rachel on `/admin/users` and Helen on `/admin/flags` land on `/no-access`.

## Flows

| Feature | Persona | Result |
|---|---|---|
| Persona sign-in, demo banner, back link | all four | Clicked |
| Shared persona accounts can't be deactivated | Marco | Clicked: refused, recorded as AUTHZ_DENIED |
| New ticket, PII redacted at the door | Helen | Clicked: account number and SSN redacted, routing number kept |
| Requester outside example.com / example.net refused | Helen | Clicked (fixed during S8: the staff form skipped the guard) |
| Internal note and status change on HD-2479 | Marco | Clicked |
| Concurrent edit refused and refreshed | Marco | Seen: a stale status change was refused, then succeeded |
| AI draft fills the composer | Helen | Clicked (demo provider) |
| Public reply → Outbox, queued → leased → sent | Helen | Clicked; ledger rows read back |
| Send a sample client email → new ticket | Helen | Clicked |
| Reply as the client → threaded onto the ticket | Helen | Clicked |
| Seeded attachment downloads | Helen | Clicked (voided check, 216,383 bytes) |
| Uploads off, with the note | Helen | Seen |
| Link ticket, record client contact dialogs | Marco | Opened |
| Requester history | Marco | Seen (Lindqvist: 3 tickets) |
| Audit log, chain verification, export | Priya | Clicked: 1,992 rows verified; CSV downloads |
| Supervisory review stamp | Priya | Clicked: recorded, queue count drops by one |
| Reports and their export, ticket CSV export | Marco | Clicked: CSVs download |
| API tokens off in the demo | Marco | Seen: note shown, minting refused (added during S8) |
| Webhooks: sending off | Marco | Seen |
| Offline page | — | Loads (200) |
| SLA badges, the dashboard, queues, inbox | all | Render |
| Merge, void, retraction, macros, SLA and suppression admin, held mail, followers | Marco | Render; not clicked here |
| Web push, PWA install | — | Push is off (no keys); the install prompt appears in Chrome |

## Not working by design in the demo

Web push (no keys), outbound webhooks (sending off), the client API, MCP and API-token minting (closed at the
Worker), uploads (only the seeded files), and live AI (canned drafts).
