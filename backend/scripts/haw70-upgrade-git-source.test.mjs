import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { after } from 'node:test';
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' };
import { inspectHaw70UpgradeGitSource, inspectMigrationGitSource } from './haw70-upgrade-git-source.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'haw70-git-source-test-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
function git(root, ...args) {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=HawkView Test', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args],
  { env: environment, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function put(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function commit(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '--no-gpg-sign', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}
const template = join(scratch, 'template');
mkdirSync(template);
const emptyTemplate = join(scratch, 'empty-template');
mkdirSync(emptyTemplate);
git(template, 'init', '--initial-branch=main', `--template=${emptyTemplate}`);
const data = (path, stage) => Buffer.from(`synthetic Git fixture ${path}${path.endsWith('/schema.prisma') ? ':' + stage : ''}\n`);
const manifest = {};
for (const [stage, records] of [['baselineFiles', pins.baselineFiles], ['candidateFiles', pins.candidateFiles]]) {
  manifest[stage] = records.map(({ path, mode }) => ({ path, mode,
    sha256: createHash('sha256').update(data(path, stage)).digest('hex') }));
}
for (const entry of pins.baselineFiles) put(template, entry.path, data(entry.path, 'baselineFiles'));
const baseline = commit(template, 'synthetic baseline');
git(template, 'checkout', '-b', 'candidate');
for (const entry of pins.candidateFiles) put(template, entry.path, data(entry.path, 'candidateFiles'));
const reviewed = commit(template, 'synthetic reviewed source');
git(template, 'checkout', 'main');
put(template, 'unrelated-note.txt', 'public synthetic first parent\n');
const firstParent = commit(template, 'synthetic main advance');
git(template, 'merge', '--no-ff', '--no-gpg-sign', 'candidate', '-m', 'synthetic merge');
const head = git(template, 'rev-parse', 'HEAD');
let serial = 0;
function fixture() {
  const root = join(scratch, `case-${++serial}`);
  cpSync(template, root, { recursive: true });
  return { root, input: { repositoryRoot: root, expectedCandidateCommit: head,
    baselineCommit: baseline, reviewedCandidateCommit: reviewed, manifest } };
}
const firstMigration = pins.baselineFiles.find(file => file.path.endsWith('/migration.sql')).path;

test('raw second-parent ancestry, selected Git blobs and worktree bytes produce immutable non-executable evidence', () => {
  const { root, input } = fixture();
  assert.deepEqual(git(root, 'rev-list', '--parents', '-n', '1', head).split(' '), [head, firstParent, reviewed]);
  const result = inspectMigrationGitSource(input);
  assert.equal(result.candidateCommit, head);
  assert.equal(result.candidateTree, git(root, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(result.gitSnapshotVerified, true);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.sourcePlan.executionAllowed, false);
  assert.equal(result.sourcePlan.baselineFiles.length, 85);
  assert.equal(result.sourcePlan.candidateFiles.length, 99);
  assert.equal(result.sourcePlan.migrationAdditions.length, 14);
  assert.ok(Object.isFrozen(result.sourcePlan.candidateFiles[0]));
  assert.throws(() => { result.executionAllowed = true; }, TypeError);
});

test('moving refs, wrong exact HEAD, subdirectory and overridden pinned profile are refused', () => {
  const { root, input } = fixture();
  for (const expectedCandidateCommit of ['HEAD', '--help', 'a'.repeat(40), `${head}\n`]) {
    assert.throws(() => inspectMigrationGitSource({ ...input, expectedCandidateCommit }));
  }
  assert.throws(() => inspectMigrationGitSource({ ...input, repositoryRoot: join(root, 'backend') }), /root mismatch/);
  assert.throws(() => inspectHaw70UpgradeGitSource({ repositoryRoot: root, expectedCandidateCommit: head,
    baselineCommit: baseline }), /Unexpected adapter input/);
  assert.throws(() => inspectHaw70UpgradeGitSource({ repositoryRoot: root, expectedCandidateCommit: head }), /Git verification failed|not a raw ancestor/);
});

test('missing and present-but-unrelated commit objects cannot satisfy ancestry', () => {
  const { root, input } = fixture();
  assert.throws(() => inspectMigrationGitSource({ ...input, reviewedCandidateCommit: 'f'.repeat(40) }), /not a raw ancestor/);
  git(root, 'checkout', '--orphan', 'unrelated');
  const unrelated = commit(root, 'unrelated root with the same selected bytes');
  git(root, 'checkout', 'main');
  assert.throws(() => inspectMigrationGitSource({ ...input, reviewedCandidateCommit: unrelated }), /not a raw ancestor/);
});

test('shallow, partial, replacement, graft and alternate-object repositories fail closed', () => {
  for (const shape of ['shallow', 'partial', 'replace', 'graft', 'alternates']) {
    const { root, input } = fixture();
    if (shape === 'shallow') put(root, '.git/shallow', head + '\n');
    if (shape === 'partial') git(root, 'config', 'remote.origin.promisor', 'true');
    if (shape === 'replace') git(root, 'update-ref', 'refs/replace/' + head, reviewed);
    if (shape === 'graft') put(root, '.git/info/grafts', `${head} ${baseline}\n`);
    if (shape === 'alternates') put(root, '.git/objects/info/alternates', '/nonexistent-synthetic-object-path\n');
    assert.throws(() => inspectMigrationGitSource(input), /not qualified/);
  }
});

test('changed selected worktree bytes, executable modes and missing files are refused', () => {
  for (const change of ['bytes', 'mode', 'missing']) {
    const { root, input } = fixture();
    if (change === 'bytes') writeFileSync(join(root, firstMigration), '-- changed but uncommitted\n');
    if (change === 'mode') chmodSync(join(root, firstMigration), 0o755);
    if (change === 'missing') rmSync(join(root, firstMigration));
    assert.throws(() => inspectMigrationGitSource(input));
  }
});

test('untracked and committed extra migrations are rejected by independent namespaces', () => {
  for (const committed of [false, true]) {
    const { root, input } = fixture();
    put(root, 'backend/prisma/migrations/20261121170000_unapproved/migration.sql', '-- unapproved\n');
    if (committed) input.expectedCandidateCommit = commit(root, 'extra migration');
    assert.throws(() => inspectMigrationGitSource(input), /namespace differs|unexpected directory/);
  }
});

test('non-migration files in the selected migration namespace cannot be silently filtered away', () => {
  for (const committed of [false, true]) {
    const { root, input } = fixture();
    put(root, 'backend/prisma/migrations/unexpected.txt', 'synthetic extra\n');
    if (committed) input.expectedCandidateCommit = commit(root, 'extra non-sql file');
    assert.throws(() => inspectMigrationGitSource(input), /unexpected/);
  }
});

test('untracked empty migration and nested directories cannot hide from the selected namespace', () => {
  for (const path of ['backend/prisma/migrations/20261121170000_empty',
    `${dirname(firstMigration)}/empty-nested`]) {
    const { root, input } = fixture();
    mkdirSync(join(root, path));
    assert.throws(() => inspectMigrationGitSource(input), /unexpected directory/);
  }
});

test('symlink files and symlink parents are refused even if target bytes match', () => {
  for (const target of ['file', 'parent']) {
    const { root, input } = fixture();
    const path = target === 'file' ? join(root, firstMigration) : dirname(join(root, firstMigration));
    const outside = join(scratch, `outside-${serial}`);
    cpSync(path, outside, { recursive: true });
    rmSync(path, { recursive: true });
    symlinkSync(outside, path);
    assert.throws(() => inspectMigrationGitSource(input), /symlink|regular file/);
  }
});

test('a changed committed retained migration cannot hide behind a matching current worktree', () => {
  const { root, input } = fixture();
  writeFileSync(join(root, firstMigration), '-- changed committed history\n');
  input.expectedCandidateCommit = commit(root, 'rewrite retained bytes');
  assert.throws(() => inspectMigrationGitSource(input), /Candidate snapshot differs/);
});

test('ambient Git overrides, clean filters and fsmonitor hooks do not run or redirect inspection', () => {
  const { root, input } = fixture();
  const marker = join(root, 'SHOULD_NOT_EXIST');
  const probe = join(root, 'synthetic-probe.sh');
  writeFileSync(probe, '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o755 });
  git(root, 'config', 'core.fsmonitor', probe);
  git(root, 'config', 'filter.synthetic.clean', probe);
  git(root, 'config', 'filter.synthetic.required', 'true');
  put(root, '.gitattributes', '*.sql filter=synthetic\n');
  const poisoned = { GIT_DIR: '/nonexistent-synthetic-gitdir', GIT_WORK_TREE: '/nonexistent-synthetic-worktree',
    GIT_INDEX_FILE: '/nonexistent-synthetic-index', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/nonexistent-synthetic-objects',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: probe };
  const previous = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
  Object.assign(process.env, poisoned);
  try { assert.equal(inspectMigrationGitSource(input).gitSnapshotVerified, true); }
  finally { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } }
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(root, firstMigration), 'utf8'), data(firstMigration, 'candidateFiles').toString());
});
