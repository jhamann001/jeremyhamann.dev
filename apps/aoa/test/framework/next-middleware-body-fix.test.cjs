'use strict';
// Synthetic package fixtures only. Production dependencies are read, never
// modified; the fixture reconstructs pristine bytes only after a pinned hash check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NEXT_VERSION, TARGETS, PATCH_BEFORE, PATCH_AFTER, applyPatch, cli } = require('../../scripts/apply-next-middleware-body-fix.cjs');
const installer = path.resolve(__dirname, '../../scripts/apply-next-middleware-body-fix.cjs');
const installed = path.dirname(require.resolve('next/package.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const pristine = TARGETS.map(target => {
  const bytes = fs.readFileSync(path.join(installed, target.relativePath));
  const actual = hash(bytes);
  assert.ok([target.pristineSha256, target.patchedSha256].includes(actual), `fixture source must be pinned: ${target.relativePath}`);
  const source = actual === target.pristineSha256 ? bytes : Buffer.from(bytes.toString('utf8').replace(PATCH_AFTER, PATCH_BEFORE));
  assert.equal(hash(source), target.pristineSha256);
  return source;
});
const patched = pristine.map(source => Buffer.from(source.toString('utf8').replace(PATCH_BEFORE, PATCH_AFTER)));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aoa-next-body-fix-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'next', version: NEXT_VERSION }));
  TARGETS.forEach((target, index) => {
    const filename = path.join(root, target.relativePath);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, pristine[index], { mode: 0o640 });
  });
  return root;
}
function withFixture(fn) {
  const root = fixture();
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const filename = (root, index) => path.join(root, TARGETS[index].relativePath);
function snapshot(root) {
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), rel = path.relative(root, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) result[rel] = { link: fs.readlinkSync(full) };
      else result[rel] = { hash: hash(fs.readFileSync(full)), mtime: fs.statSync(full, { bigint: true }).mtimeNs.toString() };
    }
  }
  walk(root); return result;
}
function rejectWithoutWrites(root, options, code) {
  const before = snapshot(root);
  assert.throws(() => applyPatch({ nextPackagePath: root, ...options }), error => error.code === code);
  assert.deepEqual(snapshot(root), before, 'failed preflight must not mutate either file or leave staging files');
}

test('applies exactly the one-await backport to both pinned formats and preserves modes', () => withFixture(root => {
  const report = applyPatch({ nextPackagePath: root });
  assert.equal(report.changedFiles, 2);
  TARGETS.forEach((target, index) => {
    const contents = fs.readFileSync(filename(root, index));
    assert.equal(hash(contents), target.patchedSha256);
    assert.equal(contents.toString('utf8').replace(PATCH_AFTER, PATCH_BEFORE), pristine[index].toString('utf8'));
    assert.equal(fs.statSync(filename(root, index)).mode & 0o777, 0o640);
  });
  assert.ok(!Object.keys(snapshot(root)).some(name => name.endsWith('.tmp')));
}));
test('second application is idempotent without rewriting either file', () => withFixture(root => {
  applyPatch({ nextPackagePath: root }); const before = snapshot(root);
  assert.equal(applyPatch({ nextPackagePath: root }).changedFiles, 0);
  assert.deepEqual(snapshot(root), before);
}));
test('check-only requires both patched files and never applies the patch', () => withFixture(root => {
  rejectWithoutWrites(root, { mode: 'check' }, 'patch_required');
  applyPatch({ nextPackagePath: root }); const before = snapshot(root);
  assert.equal(applyPatch({ nextPackagePath: root, mode: 'check' }).changedFiles, 0);
  assert.deepEqual(snapshot(root), before);
}));
for (const [label, metadata] of Object.entries({
  unknown_version: { name: 'next', version: '15.5.25' },
  wrong_package: { name: 'not-next', version: NEXT_VERSION },
  absent_version: { name: 'next' },
})) test(`rejects ${label} before writes`, () => withFixture(root => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata));
  rejectWithoutWrites(root, {}, 'unsupported_next_package');
}));
test('rejects malformed metadata before writes', () => withFixture(root => {
  fs.writeFileSync(path.join(root, 'package.json'), '{');
  rejectWithoutWrites(root, {}, 'invalid_package_metadata');
}));
for (const index of [0, 1]) {
  test(`rejects unexpected content in format ${index} before modifying either file`, () => withFixture(root => {
    fs.appendFileSync(filename(root, index), '\n// unexpected external edit\n');
    rejectWithoutWrites(root, {}, 'unexpected_file_hash');
  }));
  test(`rejects a partial or malformed patch in format ${index}`, () => withFixture(root => {
    fs.writeFileSync(filename(root, index), pristine[index].toString('utf8').replace('requestData.body.finalize();', 'void requestData.body.finalize();'));
    rejectWithoutWrites(root, {}, 'unexpected_file_hash');
  }));
  test(`completes recognized mixed state with format ${index} already patched`, () => withFixture(root => {
    fs.writeFileSync(filename(root, index), patched[index]);
    const unchangedTime = fs.statSync(filename(root, index), { bigint: true }).mtimeNs;
    assert.equal(applyPatch({ nextPackagePath: root }).changedFiles, 1);
    assert.equal(fs.statSync(filename(root, index), { bigint: true }).mtimeNs, unchangedTime);
    assert.equal(applyPatch({ nextPackagePath: root, mode: 'check' }).changedFiles, 0);
  }));
}
test('ordinary apply and check require ESM even when CJS is available', () => withFixture(root => {
  fs.unlinkSync(filename(root, 1));
  rejectWithoutWrites(root, {}, 'required_file_unreadable');
  rejectWithoutWrites(root, { mode: 'check' }, 'required_file_unreadable');
}));
test('explicit standalone check permits untraced ESM but requires patched CJS', () => withFixture(root => {
  fs.unlinkSync(filename(root, 1));
  rejectWithoutWrites(root, { mode: 'check-standalone' }, 'patch_required');
  fs.writeFileSync(filename(root, 0), patched[0]); const before = snapshot(root);
  const report = applyPatch({ nextPackagePath: root, mode: 'check-standalone' });
  assert.equal(report.changedFiles, 0); assert.equal(report.files[1].state, 'not-traced');
  assert.deepEqual(snapshot(root), before);
}));
test('standalone check validates ESM when it is present', () => withFixture(root => {
  fs.writeFileSync(filename(root, 0), patched[0]);
  rejectWithoutWrites(root, { mode: 'check-standalone' }, 'patch_required');
  fs.appendFileSync(filename(root, 1), '// unexpected');
  rejectWithoutWrites(root, { mode: 'check-standalone' }, 'unexpected_file_hash');
}));
test('standalone check never permits missing CJS', () => withFixture(root => {
  fs.unlinkSync(filename(root, 0));
  rejectWithoutWrites(root, { mode: 'check-standalone' }, 'required_file_unreadable');
}));
test('explicit standalone mode requires an explicit package path', () => {
  assert.throws(() => applyPatch({ mode: 'check-standalone' }), error => error.code === 'standalone_path_required');
});
test('rejects individual target symlinks before touching either format', () => withFixture(root => {
  const backing = path.join(root, 'synthetic-backing.js');
  fs.renameSync(filename(root, 1), backing); fs.symlinkSync(backing, filename(root, 1));
  rejectWithoutWrites(root, {}, 'target_not_regular_file');
}));
test('a patch marker cannot substitute for validated dependency bytes', () => withFixture(root => {
  fs.writeFileSync(path.join(root, '.middleware-patched'), 'true');
  rejectWithoutWrites(root, { mode: 'check' }, 'patch_required');
}));
test('invalid CLI flags and combinations fail before changing valid files', () => withFixture(root => {
  const before = snapshot(root);
  for (const args of [ ['--unknown'], ['--next-package'], ['--check', '--check-standalone'],
    ['--next-package', root, '--next-package', root], ['--next-package', '--check'] ]) {
    assert.throws(() => cli(args), error => error.code === 'invalid_arguments');
  }
  assert.deepEqual(snapshot(root), before);
}));
test('CLI reports sanitized failures and applies/checks an explicit synthetic package', () => withFixture(root => {
  const args = [installer, '--next-package', root];
  let result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /"changedFiles":2/);
  result = spawnSync(process.execPath, [...args, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /"changedFiles":0/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'next', version: 'untrusted-private-content\n' }));
  result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /unsupported_next_package/);
  assert.ok(!result.stderr.includes('untrusted-private-content'));
}));
