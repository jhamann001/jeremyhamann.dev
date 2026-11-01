# Plans

The portfolio is built in phases. Each one ends with evidence for its "done" checks, not just a claim.

| Phase | What | Status |
|---|---|---|
| 1 | Repo, guardrails, synthetic universe, portfolio site on Cloudflare | Live at jeremyhamann.dev |
| 2 | Trade Request: the full app, renamed onto the synthetic firm, with stand-ins for every outside service | Live at trade.jeremyhamann.dev |
| 3 | Transfer Tracker: the full app on the synthetic firm, with stand-ins for its outside services | Live at transfers.jeremyhamann.dev |
| 4 | WM Help Desk: the full app on the synthetic firm, with its email and Slack caught in an in-app Outbox | Live at helpdesk.jeremyhamann.dev |
| 5 | Statement Analyzer | Planned |
| 6 | Polish: demo videos, the cross-app story, uptime checks | Planned |

## Ground rules

- Synthetic data only. One fictional firm across every demo.
- Demo sign-in is a user picker. There are no real accounts or passwords.
- Nothing leaves a demo. Outbound messages are captured in an in-app outbox.
- Each demo resets to its seed daily.
- Deploys run only from a button-press workflow, after the guard checks pass.
- Code is published only after a final review, as a snapshot of the reviewed tree (see the root README).
