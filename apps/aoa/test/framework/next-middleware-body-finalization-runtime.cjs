#!/usr/bin/env node
'use strict';

// Exercises Next's real production request adapter, middleware and route handler.
// Only fixture-owned standalone output is changed; application dependencies and
// app routes stay untouched. Upstream rationale: vercel/next.js#85418.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const repository = path.resolve(__dirname, '../..');
const nextPackage = path.join(repository, 'node_modules/next');
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Deliberately do not forward application credentials, database URLs or auth flags.
const safeEnvironment = {
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CI: '1',
};
const children = new Set();

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const stopped = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await stopped; } finally { clearTimeout(timer); children.delete(child); }
}

async function command(args, cwd, timeoutMs = 120000) {
  const child = spawn(process.execPath, args, { cwd, env: safeEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, `fixture command failed (${signal ?? code}):\n${output}`);
  } finally { clearTimeout(timer); children.delete(child); }
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function request(port, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: encoded ? '/api/echo' : '/api/ready',
      method: encoded ? 'POST' : 'GET', agent: false,
      headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('fixture_request_timeout')));
    if (encoded) {
      // Send a real streamed body so middleware runs before the source ends.
      req.write(encoded.subarray(0, 4096));
      setTimeout(() => { if (!req.destroyed) req.end(encoded.subarray(4096)); }, 25);
    } else req.end();
  });
}

async function withServer(serverFile, action) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverFile], { cwd: path.dirname(serverFile),
    env: { ...safeEnvironment, PORT: String(port), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture_server_exited:\n${output}`);
      try { if ((await request(port)).status === 200) { ready = true; break; } } catch { /* startup only */ }
      await delay(50);
    }
    assert(ready, `fixture_server_not_ready:\n${output}`);
    return await action(port, () => output);
  } finally { await stop(child); }
}

function payload(marker) {
  return { marker, items: Array.from({ length: 100 }, (_, index) => ({ index,
    description: 'synthetic'.repeat(256), owner: { type: 'USER', name: 'Synthetic person' } })) };
}

async function main() {
  const { NEXT_VERSION, TARGETS, PATCH_BEFORE, PATCH_AFTER, applyPatch } = require('../../scripts/apply-next-middleware-body-fix.cjs');
  assert.equal(JSON.parse(await fs.readFile(path.join(nextPackage, 'package.json'), 'utf8')).version, NEXT_VERSION);
  const cache = path.join(repository, 'node_modules/.cache');
  await fs.mkdir(cache, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(cache, 'next-body-finalize-'));
  try {
    await fs.mkdir(path.join(fixture, 'app/api/ready'), { recursive: true });
    await fs.mkdir(path.join(fixture, 'app/api/echo'), { recursive: true });
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ private: true, name: 'synthetic-next-body-finalize-fixture' }));
    await fs.writeFile(path.join(fixture, 'next.config.js'), `module.exports={output:'standalone',outputFileTracingRoot:${JSON.stringify(repository)},experimental:{cpus:1}};\n`);
    // Force the cloned body to be consumed before returning, making the race
    // deterministic instead of relying on production load or network timing.
    await fs.writeFile(path.join(fixture, 'middleware.js'), `import {NextResponse} from 'next/server';\nexport async function middleware(request){const body=await request.json();if(body.items.length!==100)throw new Error('synthetic_fixture_shape');return NextResponse.next();}\nexport const config={runtime:'nodejs',matcher:['/api/echo']};\n`);
    await fs.writeFile(path.join(fixture, 'app/api/ready/route.js'), `export function GET(){return Response.json({ready:true});}\n`);
    await fs.writeFile(path.join(fixture, 'app/api/echo/route.js'), `export async function POST(request){const payload=await request.json();return Response.json({marker:payload.marker,count:payload.items.length,characters:payload.items.reduce((sum,item)=>sum+item.description.length,0)});}\n`);
    await command([path.join(nextPackage, 'dist/bin/next'), 'build', fixture], fixture);
    const standalone = path.join(fixture, '.next/standalone');
    const serverFile = path.join(standalone, path.relative(repository, fixture), 'server.js');
    const runtimePackage = path.join(standalone, 'node_modules/next');
    await fs.access(serverFile);
    // Restore the exact unpatched distribution for the negative control, even
    // when npm/prebuild hooks already patched the dependency used for tracing.
    for (const target of TARGETS) {
      const destination = path.join(runtimePackage, target.relativePath);
      let content;
      try { content = await fs.readFile(destination, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        content = await fs.readFile(path.join(nextPackage, target.relativePath), 'utf8');
      }
      if (sha256(content) === target.patchedSha256) content = content.replace(PATCH_AFTER, PATCH_BEFORE);
      assert.equal(sha256(content), target.pristineSha256, `unexpected pristine fixture bytes: ${target.relativePath}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    const bodyPath = path.join(runtimePackage, 'dist/server/body-streams.js');
    const bodySource = await fs.readFile(bodyPath, 'utf8');
    const finalize = 'async finalize () {';
    assert.equal(bodySource.split(finalize).length, 2, 'fixture delay injection must match exactly once');
    await fs.writeFile(bodyPath, bodySource.replace(finalize, `${finalize}\nawait new Promise(resolve => setTimeout(resolve, 250));`));
    const control = await withServer(serverFile, async (port, logs) => {
      const response = await request(port, payload('unpatched-control'));
      assert.equal(response.status, 500, 'unpatched delayed-finalize control must fail');
      await delay(50);
      assert.match(logs(), /Response body object should not be disturbed or locked/,
        'negative control must fail in the real request/body adapter');
      return response.status;
    });
    await applyPatch({ nextPackagePath: runtimePackage, mode: 'apply' });
    await applyPatch({ nextPackagePath: runtimePackage, mode: 'check' });
    const accepted = await withServer(serverFile, async port => {
      const markers = ['patched-1', 'patched-2', 'patched-3', 'patched-4'];
      const responses = await Promise.all(markers.map(marker => request(port, payload(marker))));
      for (const [index, response] of responses.entries()) {
        assert.equal(response.status, 200, 'patched delayed-finalize request must succeed');
        assert.deepEqual(JSON.parse(response.text), { marker: markers[index], count: 100, characters: 230400 });
      }
      return responses.length;
    });
    console.log(JSON.stringify({ passed: true, nextVersion: NEXT_VERSION, nodeVersion: process.version,
      runtime: 'production standalone', syntheticOnly: true, loopbackOnly: true,
      unpatchedStatus: control, patchedRequests: accepted, patchedStatus: 200, finalizeDelayMs: 250 }));
  } finally {
    await Promise.all([...children].map(stop));
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
