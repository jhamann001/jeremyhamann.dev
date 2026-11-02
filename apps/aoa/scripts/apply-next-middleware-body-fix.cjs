#!/usr/bin/env node
'use strict';

// ticket: backport vercel/next.js#85418's one-await Node middleware fix.
// The pinned Next (15.5.28; 15.5.24 before) starts route handling before the cloned POST body is restored.
// Run before `next dev` / `next build`; do not attach this to Prisma postinstall.
// Remove this installer only with a reviewed Next upgrade carrying the fix.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const NEXT_VERSION = '15.5.28';
const TARGETS = Object.freeze([
  Object.freeze({
    relativePath: 'dist/server/next-server.js',
    pristineSha256: '7c97c35f81d4171ef0d5f16e18e3fe1a8e5c0bcaabf6810abdc2e92ce814a104',
    patchedSha256: '2fbb30d01fdbc56632292cc48b27c8c8bdc0b3c310d4e21d3ffd3c96798fbc18',
  }),
  Object.freeze({
    relativePath: 'dist/esm/server/next-server.js',
    pristineSha256: '9b4c85790b1b7f1020a515d13472bdc56db4de296f78255a2e80fbba9eba6a07',
    patchedSha256: 'a2b130c47db4e1922f44e171e1a7378b95b2142be939326da9252d96442ca61c',
  }),
]);
const PATCH_BEFORE = '            } finally{\n'
  + '                if (hasRequestBody) {\n'
  + '                    requestData.body.finalize();\n'
  + '                }\n'
  + '            }';
const PATCH_AFTER = PATCH_BEFORE.replace('requestData.body.finalize();', 'await requestData.body.finalize();');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

class PatchError extends Error {
  constructor(code, target) {
    super(code);
    this.code = code;
    this.target = target;
  }
}
function readFile(packagePath, relativePath, optional = false) {
  const filename = path.join(packagePath, relativePath);
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new PatchError('required_file_unreadable', relativePath);
  }
  // Never follow a per-file symlink while replacing dependency contents.
  if (!stat.isFile()) throw new PatchError('target_not_regular_file', relativePath);
  try { return { filename, bytes: fs.readFileSync(filename), mode: stat.mode & 0o777 }; }
  catch { throw new PatchError('required_file_unreadable', relativePath); }
}
function defaultNextPackagePath() {
  try { return path.dirname(require.resolve('next/package.json', { paths: [path.resolve(__dirname, '..')] })); }
  catch { throw new PatchError('next_package_not_installed', 'package.json'); }
}
function planPatch({ nextPackagePath, mode = 'apply' } = {}) {
  if (!['apply', 'check', 'check-standalone'].includes(mode)) throw new PatchError('invalid_mode');
  if (mode === 'check-standalone' && !nextPackagePath) throw new PatchError('standalone_path_required');
  const packagePath = path.resolve(nextPackagePath ?? defaultNextPackagePath());
  const metadata = readFile(packagePath, 'package.json');
  let pkg;
  try { pkg = JSON.parse(metadata.bytes.toString('utf8')); }
  catch { throw new PatchError('invalid_package_metadata', 'package.json'); }
  if (pkg.name !== 'next' || pkg.version !== NEXT_VERSION) throw new PatchError('unsupported_next_package', 'package.json');
  // Fully validate BOTH files before staging or replacing either. A recognized
  // pristine/patched mix is recoverable; arbitrary partial edits are not.
  const files = TARGETS.map((target, index) => {
    const file = readFile(packagePath, target.relativePath, mode === 'check-standalone' && index === 1);
    if (file === null) return { ...target, state: 'not-traced', replacement: null };
    const hash = sha256(file.bytes);
    const state = hash === target.pristineSha256 ? 'pristine' : hash === target.patchedSha256 ? 'patched' : null;
    if (!state) throw new PatchError('unexpected_file_hash', target.relativePath);
    const text = file.bytes.toString('utf8');
    const expectedBlock = state === 'pristine' ? PATCH_BEFORE : PATCH_AFTER;
    if (text.split(expectedBlock).length !== 2) throw new PatchError('unexpected_patch_context', target.relativePath);
    const replacement = state === 'pristine' ? Buffer.from(text.replace(PATCH_BEFORE, PATCH_AFTER), 'utf8') : file.bytes;
    if (sha256(replacement) !== target.patchedSha256) throw new PatchError('unexpected_patched_hash', target.relativePath);
    return { ...target, ...file, state, replacement };
  });
  if (mode !== 'apply' && files.some(file => file.state === 'pristine')) throw new PatchError('patch_required');
  return { packagePath, mode, files };
}
function applyPatch(options = {}) {
  const plan = planPatch(options);
  const pending = plan.mode === 'apply' ? plan.files.filter(file => file.state === 'pristine') : [];
  const staged = [];
  try {
    // Stage complete bytes first, then atomically replace individual files.
    // A crash between the two renames leaves only known pristine/patched states;
    // the next invocation validates both and completes that state idempotently.
    for (const file of pending) {
      const temporary = file.filename + `.ticket-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
      staged.push({ file, temporary });
      fs.writeFileSync(temporary, file.replacement, { flag: 'wx', mode: file.mode });
    }
    for (const entry of staged) fs.renameSync(entry.temporary, entry.file.filename);
  } catch {
    throw new PatchError('patch_write_failed');
  } finally {
    for (const entry of staged) {
      try { fs.unlinkSync(entry.temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw new PatchError('temporary_cleanup_failed'); }
    }
  }
  // Also prove the installed bytes after a successful write; do not trust a
  // marker file, a matching source substring, or a previous process's output.
  if (pending.length) planPatch({ nextPackagePath: plan.packagePath, mode: 'check' });
  return { nextVersion: NEXT_VERSION, mode: plan.mode, changedFiles: pending.length,
    files: plan.files.map(file => ({ path: file.relativePath,
      state: file.state === 'not-traced' ? 'not-traced' : 'patched',
      sha256: file.state === 'not-traced' ? null : file.patchedSha256 })) };
}
function cli(args) {
  let mode = 'apply', nextPackagePath, checkSeen = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check' || arg === '--check-standalone') {
      if (checkSeen) throw new PatchError('invalid_arguments');
      mode = arg === '--check' ? 'check' : 'check-standalone'; checkSeen = true;
    } else if (arg === '--next-package') {
      const value = args[++index];
      if (nextPackagePath || !value || value.startsWith('--')) throw new PatchError('invalid_arguments');
      nextPackagePath = value;
    } else throw new PatchError('invalid_arguments');
  }
  return applyPatch({ mode, nextPackagePath });
}
module.exports = { NEXT_VERSION, TARGETS, PATCH_BEFORE, PATCH_AFTER, planPatch, applyPatch, cli };
if (require.main === module) {
  try { console.log('[next-middleware-body-fix] ' + JSON.stringify(cli(process.argv.slice(2)))); }
  catch (error) {
    console.error('[next-middleware-body-fix] ' + JSON.stringify({
      error: error instanceof PatchError ? error.code : 'unexpected_installer_failure',
      ...(error instanceof PatchError && error.target ? { target: error.target } : {}),
    }));
    process.exitCode = 1;
  }
}
