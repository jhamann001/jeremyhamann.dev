#!/usr/bin/env node
// After a demo's deploy: waits until the container this deploy started answers, then until the sign-in page has
// answered 200 three times in a row, ten seconds apart, and says how long that took. The first wait asks the Worker's
// deploy check (container-start.js), keyed by the version the deploy just made. The check this replaces took the
// first healthy answer, which came from the previous deploy's container while Cloudflare was still replacing it.
//
// Usage: node apps/demo-edge/wait-for-deploy.mjs <site> <version> <sign-in path>

import { fileURLToPath } from 'node:url';
import { STARTED_PATH } from './container-start.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True once the deploy's own container and its sign-in page answer; false if `limitMs` runs out first. */
export async function waitForDeploy({
  site,
  version,
  signInPath,
  fetch = globalThis.fetch,
  wait = sleep,
  now = Date.now,
  log = console.log,
  limitMs = 10 * 60_000,
  pauseMs = 10_000,
}) {
  const begun = now();
  const at = () => `${Math.round((now() - begun) / 1000)} s`;
  const status = async (url, read) => {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(150_000) });
      return read ? await read(response) : response.status;
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  };

  // The deploy check holds each request until the container starts or gives up, so this asks again at once.
  const check = `${site}${STARTED_PATH}?version=${encodeURIComponent(version)}`;
  for (;;) {
    const answer = await status(check, async (r) => (r.status === 200 && (await r.json()).ready === true ? 'ready' : r.status));
    if (answer === 'ready') break;
    if (now() - begun > limitMs) {
      log(`${at()}: this deploy's container never answered (last: ${answer}).`);
      return false;
    }
    log(`${at()}: not up yet (${answer === 404 ? '404: an older Worker version answered' : answer})`);
    await wait(pauseMs);
  }
  log(`${at()}: this deploy's container answers.`);

  for (let inARow = 0; inARow < 3; ) {
    const code = await status(`${site}${signInPath}`);
    inARow = code === 200 ? inARow + 1 : 0;
    if (inARow === 3) break;
    if (code !== 200) log(`${at()}: the sign-in page answered ${code}`);
    if (now() - begun > limitMs) {
      log(`${at()}: the sign-in page didn't stay up.`);
      return false;
    }
    await wait(pauseMs);
  }
  log(`Live: this deploy's container and its sign-in page answered ${at()} after the deploy.`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [site, version, signInPath] = process.argv.slice(2);
  if (!site || !version || !signInPath) {
    console.error('usage: wait-for-deploy.mjs <site> <version> <sign-in path>');
    process.exit(2);
  }
  process.exit((await waitForDeploy({ site, version, signInPath })) ? 0 : 1);
}
