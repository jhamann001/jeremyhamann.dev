// Starts a demo's reset workflow on time. The advisor platform's and the help desk's resets run in GitHub Actions as
// their database owner, and GitHub starts this repository's scheduled runs hours late (the 07:00 UTC reset ran at
// 16:45 on 2026-11-02; the help desk's 14:00 reset starts around 18:30-19:30), while a workflow_dispatch starts
// within a minute. So each of those Workers' Cloudflare cron asks GitHub to run its reset now. The workflow keeps its
// own schedule as the fallback, which skips itself when a reset already ran (.github/workflows/reset-*.yml).
//
// RESET_DISPATCH_TOKEN is a fine-grained GitHub token for this one repository with Actions read and write and nothing
// else; without it the cron only logs, and the fallback schedule resets the demo as before. The token never leaves
// this request, and the log carries the outcome and GitHub's status only.
//
// Shared by the demo Workers (apps/*/worker); its tests run with the help desk Worker's.

const API = 'https://api.github.com';

/** Ask GitHub to run `workflow` on main now. Returns the outcome it logged. */
export async function dispatchReset(env, workflow, fetchImpl = fetch) {
  const log = (outcome, status) =>
    console.log(JSON.stringify({ event: 'reset_dispatch', workflow, outcome, ...(status ? { status } : {}) }));
  if (!env.RESET_DISPATCH_TOKEN) {
    log('no_token');
    return 'no_token';
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.RESET_REPOSITORY ?? '') || !/^[\w.-]+\.ya?ml$/.test(workflow ?? '')) {
    log('misconfigured');
    return 'misconfigured';
  }
  let response;
  try {
    response = await fetchImpl(`${API}/repos/${env.RESET_REPOSITORY}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESET_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'jeremyhamann-dev-demo-reset',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
  } catch {
    log('unreachable');
    return 'unreachable';
  }
  const outcome = response.ok ? 'dispatched' : 'refused';
  log(outcome, response.status);
  return outcome;
}
