import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { after } from 'node:test';
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' };
import {
  HAW70_STAGE_CAPS, materializeHaw70UpgradeSource, materializeMigrationSource,
  validateHaw70UpgradeStagedSource, validateMigrationStagedSource,
} from './haw70-upgrade-materializer.mjs';

/**
 * Focused nonconnecting tests for the inactive HAW-70 materializer.
 *
 * These exercise ACTUAL copied bytes and ACTUAL refusal behaviour: every
 * expectation is recomputed from the pinned Git trees or from the synthetic
 * fixture's own bytes, never read back out of the implementation's receipt. No
 * database, no migration CLI, no socket and no hosted claim is involved.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'haw70-materializer-test-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
function git(root, ...args) {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=HawkView Test', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args],
  { env: environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
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
let serial = 0;
const parentFor = name => {
  const parent = join(scratch, `parent-${name}-${++serial}`);
  mkdirSync(parent, { recursive: true });
  return realpathSync(parent);
};

/* ------------------------- synthetic repository families ------------------------- */

const MIGRATION = /^backend\/prisma\/migrations\/[0-9]{14}_[a-z0-9_]+\/migration\.sql$/;
const COMPATIBILITY = ['backend/package.json', 'backend/package-lock.json', 'backend/prisma.config.ts'];

/**
 * Builds a template repo whose baseline and candidate selected sets are exactly
 * the supplied path lists, with distinct synthetic bytes, then returns per-case
 * copies. The manifest is computed from those bytes, so a test that mutates a
 * byte genuinely diverges from the pin rather than from a restated constant.
 */
function family(name, baselinePaths, candidatePaths, sizeFor = () => 0) {
  const template = join(scratch, `template-${name}`);
  mkdirSync(template, { recursive: true });
  const emptyTemplate = join(scratch, `empty-template-${name}`);
  mkdirSync(emptyTemplate, { recursive: true });
  git(template, 'init', '--initial-branch=main', `--template=${emptyTemplate}`);
  const data = (path, stage) => {
    const head = Buffer.from(`synthetic ${name} ${path}${path.endsWith('/schema.prisma') ? ':' + stage : ''}\n`);
    // `sizeFor` names the EXACT total length, so a byte cap can be probed at
    // precisely cap and cap+1 rather than approximately.
    const total = sizeFor(path, stage);
    if (!(total > 0)) return head;
    const buffer = Buffer.alloc(total, 0x61);
    head.copy(buffer, 0, 0, Math.min(head.length, total));
    return buffer;
  };
  const manifest = {
    baselineFiles: baselinePaths.map(path => ({ path, mode: '100644', sha256: sha256(data(path, 'baselineFiles')) })),
    candidateFiles: candidatePaths.map(path => ({ path, mode: '100644', sha256: sha256(data(path, 'candidateFiles')) })),
  };
  for (const path of baselinePaths) put(template, path, data(path, 'baselineFiles'));
  const baseline = commit(template, 'synthetic baseline');
  git(template, 'checkout', '-b', 'candidate');
  for (const path of baselinePaths) if (!candidatePaths.includes(path)) rmSync(join(template, path));
  for (const path of candidatePaths) put(template, path, data(path, 'candidateFiles'));
  const reviewed = commit(template, 'synthetic reviewed source');
  git(template, 'checkout', 'main');
  put(template, 'unrelated-note.txt', 'synthetic first parent\n');
  commit(template, 'synthetic main advance');
  git(template, 'merge', '--no-ff', '--no-gpg-sign', 'candidate', '-m', 'synthetic merge');
  const head = git(template, 'rev-parse', 'HEAD');
  return {
    data, manifest, baseline, reviewed, head,
    fixture() {
      const created = join(scratch, `case-${name}-${++serial}`);
      cpSync(template, created, { recursive: true });
      const root = realpathSync(created);
      return { root, source: { repositoryRoot: root, expectedCandidateCommit: head,
        baselineCommit: baseline, reviewedCandidateCommit: reviewed, manifest } };
    },
  };
}

/** The real pinned path profile, with synthetic bytes. */
const pinned = family('pinned', pins.baselineFiles.map(f => f.path), pins.candidateFiles.map(f => f.path));

const stamp = index => `2026010100${String(index).padStart(4, '0')}`;
const migrationPath = index => `backend/prisma/migrations/${stamp(index)}_synthetic_${index}/migration.sql`;
const smallSet = count => [...COMPATIBILITY, 'backend/prisma/schema.prisma',
  'backend/prisma/migrations/migration_lock.toml', ...Array.from({ length: count }, (_, i) => migrationPath(i + 1))];
/** Baseline IS the sorted prefix of candidate: the forbidden selection. */
const prefixFamily = family('prefix', smallSet(3), smallSet(5));
/**
 * A deliberately small NON-prefix family for the refusal and mutation cases.
 * Baseline keeps migrations 1, 2 and 4 while the candidate adds 3 and 5, so the
 * sorted baseline is not the sorted candidate prefix and the fixed mapping is
 * still exercised end to end — without restaging 178 files per case.
 */
const base = [...COMPATIBILITY, 'backend/prisma/schema.prisma',
  'backend/prisma/migrations/migration_lock.toml'];
const small = family('small', [...base, migrationPath(1), migrationPath(2), migrationPath(4)],
  [...base, ...[1, 2, 3, 4, 5].map(migrationPath)]);

/* ----------------------------- helpers over a root ----------------------------- */

function walk(root) {
  const files = [];
  const directories = [];
  const visit = relative => {
    for (const entry of readdirSync(relative ? join(root, relative) : root, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { directories.push(path); visit(path); } else files.push(path);
    }
  };
  visit('');
  return { files: files.sort(), directories: directories.sort() };
}
const snapshotRoot = root => {
  const { files } = walk(root);
  return files.map(path => [path, sha256(readFileSync(join(root, path)))]);
};

/* ================================== actual source ================================== */

const repositoryRoot = realpathSync(join(import.meta.dirname, '..', '..'));
const actualHead = git(repositoryRoot, 'rev-parse', 'HEAD');

test('actual committed source stages exactly the pinned 82 and 96 file sets and their real bytes', () => {
  const parent = parentFor('actual');
  const result = materializeHaw70UpgradeSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, scratchParent: parent });
  assert.equal(result.executionAllowed, false);
  assert.equal(result.receipt.executionAllowed, false);
  assert.equal(result.receipt.candidateCommit, actualHead);
  assert.equal(result.receipt.baselineCommit, pins.baselineCommit);
  assert.equal(result.receipt.reviewedCandidateCommit, pins.reviewedCandidateCommit);
  assert.equal(result.receipt.baselineDigest, pins.baselineDigest);
  assert.equal(result.receipt.candidateDigest, pins.candidateDigest);
  assert.ok(result.outputRoot.startsWith(`${parent}/`));

  // Counts and bytes, recomputed from the pinned Git trees rather than restated.
  const staged = (commitish, expected) => {
    const lines = git(repositoryRoot, 'ls-tree', '-r', '--full-tree', commitish,
      '--', 'backend/prisma/migrations', 'backend/prisma/schema.prisma').split('\n');
    const rows = lines.map(line => line.split('\t')[1]).filter(Boolean);
    const sql = rows.filter(path => MIGRATION.test(path)).sort();
    assert.equal(sql.length, expected);
    return { sql, all: [...sql, 'backend/prisma/schema.prisma', 'backend/prisma/migrations/migration_lock.toml'] };
  };
  const baselineSource = staged(pins.baselineCommit, 80);
  const candidateSource = staged(actualHead, 94);
  assert.equal(result.receipt.stages.baseline.migrationCount, 80);
  assert.equal(result.receipt.stages.candidate.migrationCount, 94);
  assert.equal(result.receipt.stages.baseline.fileCount, 82);
  assert.equal(result.receipt.stages.candidate.fileCount, 96);
  assert.equal(result.receipt.stages.baseline.bytes, 300_956);
  assert.equal(result.receipt.stages.candidate.bytes, 333_691);
  assert.equal(candidateSource.sql.filter(path => !baselineSource.sql.includes(path)).length, 14);

  // ACTUAL copied bytes: every staged file equals the raw Git blob it came from.
  for (const [stage, commitish, source] of [['baseline', pins.baselineCommit, baselineSource],
    ['candidate', actualHead, candidateSource]]) {
    const entries = result.receipt.stages[stage].files;
    assert.equal(entries.length, source.all.length);
    for (const sourcePath of source.all) {
      const relative = sourcePath === 'backend/prisma/schema.prisma' ? `${stage}/schema.prisma`
        : `${stage}/migrations/${sourcePath.slice('backend/prisma/migrations/'.length)}`;
      const blob = spawnSync('/usr/bin/git', ['-C', repositoryRoot, 'cat-file', 'blob',
        `${commitish}:${sourcePath}`], { maxBuffer: 8 * 1024 * 1024 });
      assert.equal(blob.status, 0, sourcePath);
      const onDisk = readFileSync(join(result.outputRoot, relative));
      assert.ok(blob.stdout.equals(onDisk), `staged bytes differ from the Git blob: ${relative}`);
      const recorded = entries.find(entry => entry.path === relative);
      assert.equal(recorded.bytes, onDisk.length);
      assert.equal(recorded.sha256, sha256(onDisk));
      const stat = statSync(join(result.outputRoot, relative));
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o111, 0);
    }
  }

  // Compatibility inputs are verified by the adapter and absent from scratch.
  const { files, directories } = walk(result.outputRoot);
  for (const path of [...COMPATIBILITY, 'backend/prisma.config.ts']) {
    assert.equal(files.some(entry => entry.endsWith(path.split('/').pop())), false, path);
  }
  assert.equal(files.length, 82 + 96 + 1);
  assert.equal(directories.length, 2 + 2 + 80 + 94);
  assert.deepEqual(files.filter(path => !path.includes('/')), ['receipt.json']);
  assert.equal(files.some(path => /\.(ts|json)$/.test(path) && path !== 'receipt.json'), false);

  // The baseline stage is NOT the first 80 candidate names: the interleaved
  // counterexample, measured on the real selection.
  const baselineNames = result.receipt.stages.baseline.files
    .filter(f => f.path.endsWith('/migration.sql')).map(f => f.path.split('/')[2]);
  const candidateNames = result.receipt.stages.candidate.files
    .filter(f => f.path.endsWith('/migration.sql')).map(f => f.path.split('/')[2]);
  assert.notDeepEqual(baselineNames, candidateNames.slice(0, baselineNames.length));
  assert.deepEqual(baselineNames, [...baselineNames].sort());

  const validated = validateHaw70UpgradeStagedSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, outputRoot: result.outputRoot });
  assert.equal(validated.executionAllowed, false);
  assert.deepEqual(validated.receipt, result.receipt);
});

test('two materializations never reuse, clean or disturb an earlier output root', () => {
  const parent = parentFor('distinct');
  const first = materializeHaw70UpgradeSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, scratchParent: parent });
  const before = snapshotRoot(first.outputRoot);
  const second = materializeHaw70UpgradeSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, scratchParent: parent });
  assert.notEqual(first.outputRoot, second.outputRoot);
  assert.deepEqual(snapshotRoot(first.outputRoot), before, 'the earlier root must be untouched');
  assert.deepEqual(snapshotRoot(second.outputRoot), before, 'and byte-identical, from the same pinned source');
  for (const root of [first.outputRoot, second.outputRoot]) {
    assert.equal(validateHaw70UpgradeStagedSource(
      { repositoryRoot, expectedCandidateCommit: actualHead, outputRoot: root }).executionAllowed, false);
  }
});

/* ================================ source authority ================================ */

test('the pinned materializer accepts no snapshot, manifest, baseline ref, executable or datasource', () => {
  const parent = parentFor('authority');
  const base = { repositoryRoot, expectedCandidateCommit: actualHead, scratchParent: parent };
  for (const extra of [
    { manifest: { baselineFiles: pins.baselineFiles, candidateFiles: pins.candidateFiles } },
    { baselineCommit: pins.baselineCommit },
    { reviewedCandidateCommit: pins.reviewedCandidateCommit },
    { snapshots: { baselineFiles: [], candidateFiles: [] } },
    { baselineFiles: pins.baselineFiles },
    { checksums: { 'backend/prisma/schema.prisma': 'a'.repeat(64) } },
    { executable: '/usr/bin/true' }, { datasourceUrl: 'postgresql://synthetic/invalid' },
    { prismaConfig: '/dev/null' }, { executionAllowed: true },
  ]) {
    assert.throws(() => materializeHaw70UpgradeSource({ ...base, ...extra }), /unexpected shape/);
    assert.throws(() => validateHaw70UpgradeStagedSource(
      { repositoryRoot, expectedCandidateCommit: actualHead, outputRoot: parent, ...extra }), /unexpected shape/);
  }
  for (const missing of ['repositoryRoot', 'expectedCandidateCommit', 'scratchParent']) {
    const input = { ...base };
    delete input[missing];
    assert.throws(() => materializeHaw70UpgradeSource(input), /unexpected shape/);
  }
  assert.equal(existsSync(join(parent, 'baseline')), false);
  assert.deepEqual(readdirSync(parent), [], 'a refused call creates nothing');
});

test('moved HEAD, absent raw ancestry and mutated selected source all fail closed with no output', () => {
  for (const shape of ['head', 'ancestry', 'bytes', 'extra-file', 'mode']) {
    const { root, source } = small.fixture();
    const parent = parentFor(`closed-${shape}`);
    const firstMigration = migrationPath(1);
    if (shape === 'head') source.expectedCandidateCommit = 'b'.repeat(40);
    if (shape === 'ancestry') source.baselineCommit = 'c'.repeat(40);
    if (shape === 'bytes') writeFileSync(join(root, firstMigration), '-- mutated after review\n');
    if (shape === 'extra-file') put(root, 'backend/prisma/migrations/20261121180000_extra/migration.sql', '-- extra\n');
    if (shape === 'mode') chmodSync(join(root, firstMigration), 0o755);
    assert.throws(() => materializeMigrationSource({ ...source, scratchParent: parent }), undefined, shape);
    assert.deepEqual(readdirSync(parent), [], `${shape} must not leave a staged root`);
  }
});

test('a prefix-of-candidate baseline selection is refused even with correct counts and bytes', () => {
  const { source } = prefixFamily.fixture();
  const parent = parentFor('prefix');
  assert.throws(() => materializeMigrationSource({ ...source, scratchParent: parent }),
    /not the candidate name prefix/);
  assert.deepEqual(readdirSync(parent), []);
  // Positive control: the real pinned profile is NOT a prefix, so it stages.
  const ok = pinned.fixture();
  const okParent = parentFor('prefix-control');
  const result = materializeMigrationSource({ ...ok.source, scratchParent: okParent });
  assert.equal(result.receipt.stages.baseline.migrationCount, 80);
  assert.equal(result.receipt.stages.candidate.migrationCount, 94);
});

test('a traversal or alias path in a supplied manifest never reaches the filesystem', () => {
  const { source } = small.fixture();
  const parent = parentFor('traversal');
  for (const path of ['backend/prisma/migrations/20261121190000_x/../migration.sql',
    '../outside/migration.sql', '/absolute/migration.sql',
    'backend/prisma/migrations/20261121190000_x/migration.sql/../../escape']) {
    const manifest = { baselineFiles: [...source.manifest.baselineFiles, { path, mode: '100644', sha256: 'd'.repeat(64) }],
      candidateFiles: source.manifest.candidateFiles };
    assert.throws(() => materializeMigrationSource({ ...source, manifest, scratchParent: parent }), undefined, path);
  }
  assert.deepEqual(readdirSync(parent), []);
});

/* ================================= bounded writes ================================= */

test('a selected file over one mebibyte is refused during acquisition, before anything is staged', () => {
  // ISOLATED: exactly ONE file is oversized and everything else is tiny, so the
  // snapshot and combined aggregates stay well inside their own caps and only
  // the per-file cap can refuse this. A fixture where every migration was
  // oversized passed for the wrong reason, on the snapshot aggregate.
  const only = migrationPath(2);
  const paths = [...base, migrationPath(1), migrationPath(2), migrationPath(4)];
  const candidatePaths = [...base, ...[1, 2, 3, 4, 5].map(migrationPath)];
  // Exactly cap+1: the descriptor bound returns it, and the explicit length
  // check is what refuses it.
  const boundary = family('oversized', paths, candidatePaths,
    path => path === only ? HAW70_STAGE_CAPS.file + 1 : 0);
  const parent = parentFor('file-cap');
  assert.throws(() => materializeMigrationSource({ ...boundary.fixture().source, scratchParent: parent }),
    /Acquired selected file exceeds its byte cap/);
  assert.deepEqual(readdirSync(parent), [], 'nothing is written once a cap is breached');
  // Far over the bound: the read itself is cut off at cap+1, so an oversized
  // blob is never buffered whole and then size-checked afterwards.
  const huge = family('oversized-huge', paths, candidatePaths,
    path => path === only ? HAW70_STAGE_CAPS.file * 4 : 0);
  const hugeParent = parentFor('file-cap-huge');
  assert.throws(() => materializeMigrationSource({ ...huge.fixture().source, scratchParent: hugeParent }),
    /Git verification failed: cat-file/);
  assert.deepEqual(readdirSync(hugeParent), []);
  // Exactly AT the cap is accepted, so the boundary is pinned from both sides.
  const atCap = family('at-cap', paths, candidatePaths,
    path => path === only ? HAW70_STAGE_CAPS.file : 0);
  const accepted = materializeMigrationSource(
    { ...atCap.fixture().source, scratchParent: parentFor('file-cap-at') });
  assert.equal(accepted.receipt.stages.candidate.files
    .find(file => file.path.endsWith(`${stamp(2)}_synthetic_2/migration.sql`)).bytes, HAW70_STAGE_CAPS.file);
  // The aggregates really were not the refusing term: one oversized file plus a
  // handful of tiny ones is far under both.
  assert.ok(HAW70_STAGE_CAPS.file + 1 + 8 * 1024 < HAW70_STAGE_CAPS.snapshot);
  assert.ok(2 * (HAW70_STAGE_CAPS.file + 1 + 8 * 1024) < HAW70_STAGE_CAPS.combined);
  assert.equal(accepted.receipt.stages.candidate.migrationCount, 5);
});

test('a selected snapshot over two mebibytes is refused incrementally during acquisition', () => {
  // ISOLATED on the per-snapshot aggregate: the CANDIDATE snapshot alone goes
  // past its 2 MiB cap while every individual file stays under the 1 MiB cap
  // and the combined total stays under 4 MiB, so neither of the other two
  // bounds can be what refuses this.
  // Only the candidate-ONLY additions are padded. A retained migration must be
  // byte-identical in both stages, which the source plan independently
  // enforces, so padding a retained path would refuse for the wrong reason.
  const baselinePaths = [...base, migrationPath(1), migrationPath(2), migrationPath(10)];
  const additions = [3, 11, 12, 13, 14].map(migrationPath);
  const candidatePaths = [...base, migrationPath(1), migrationPath(2), migrationPath(10), ...additions];
  const chunk = Math.ceil((HAW70_STAGE_CAPS.snapshot + 4096) / additions.length);
  const bulky = family('bulky', baselinePaths, candidatePaths,
    path => additions.includes(path) ? chunk : 0);
  const parent = parentFor('snapshot-cap');
  assert.throws(() => materializeMigrationSource({ ...bulky.fixture().source, scratchParent: parent }),
    /Acquired selected snapshot exceeds its byte cap/);
  assert.deepEqual(readdirSync(parent), []);
  assert.ok(chunk < HAW70_STAGE_CAPS.file, 'the per-file cap must not be what refuses this case');
  assert.ok(additions.length * chunk + 16 * 1024 < HAW70_STAGE_CAPS.combined,
    'the combined cap must not be what refuses this case either');

  // The combined bound is implemented and charged incrementally, but under the
  // REVIEWED caps it can never bind first: the per-snapshot check runs before
  // it, and 2 x snapshot is exactly combined, so exceeding 4 MiB in total
  // requires one snapshot to have already exceeded 2 MiB. Recorded rather than
  // dressed up as an independently exercised limit.
  assert.equal(2 * HAW70_STAGE_CAPS.snapshot, HAW70_STAGE_CAPS.combined);

  // POSITIVE CONTROL: the same shape just under the snapshot cap stages.
  const under = Math.floor((HAW70_STAGE_CAPS.snapshot - 32 * 1024) / additions.length);
  const fits = family('bulky-control', baselinePaths, candidatePaths,
    path => additions.includes(path) ? under : 0);
  const ok = materializeMigrationSource(
    { ...fits.fixture().source, scratchParent: parentFor('snapshot-cap-control') });
  assert.equal(ok.receipt.stages.candidate.migrationCount, 8);
  assert.ok(ok.receipt.stages.candidate.bytes <= HAW70_STAGE_CAPS.stage);
  assert.ok(ok.receipt.stages.candidate.bytes > HAW70_STAGE_CAPS.snapshot - 64 * 1024,
    'the control must sit just under the cap, not far below it');
});

test('the scratch parent must be a canonical real directory outside the checkout and its Git metadata', () => {
  const { root, source } = small.fixture();
  const gitDirectory = realpathSync(git(root, 'rev-parse', '--absolute-git-dir'));
  const link = join(scratch, `parent-link-${++serial}`);
  symlinkSync(parentFor('link-target'), link);
  const file = join(scratch, `parent-file-${++serial}`);
  writeFileSync(file, 'not a directory\n');
  for (const [label, scratchParent] of [
    ['checkout', root], ['inside checkout', join(root, 'backend')], ['git metadata', gitDirectory],
    ['symlinked parent', link], ['file', file], ['missing', join(scratch, 'absent-parent')],
    ['relative', 'relative/parent'], ['trailing', `${parentFor('trailing')}/`],
  ]) {
    assert.throws(() => materializeMigrationSource({ ...source, scratchParent }), undefined, label);
  }
});

/* ============================== mutation after creation ============================== */

function stagedCase(name, source_family = small) {
  const { root, source } = source_family.fixture();
  const parent = parentFor(name);
  const result = materializeMigrationSource({ ...source, scratchParent: parent });
  const consume = () => validateMigrationStagedSource({ ...source, outputRoot: result.outputRoot });
  assert.equal(consume().executionAllowed, false, 'the untouched root must validate first');
  return { root, source, result, consume };
}
const anyStagedMigration = receipt => receipt.stages.candidate.files
  .find(file => file.path.endsWith('/migration.sql')).path;

test('the small refusal family still stages a real non-prefix selection end to end', () => {
  const { source } = small.fixture();
  const parent = parentFor('small-control');
  const result = materializeMigrationSource({ ...source, scratchParent: parent });
  assert.equal(result.receipt.stages.baseline.migrationCount, 3);
  assert.equal(result.receipt.stages.candidate.migrationCount, 5);
  const names = stage => result.receipt.stages[stage].files
    .filter(file => file.path.endsWith('/migration.sql')).map(file => file.path.split('/')[2]);
  assert.notDeepEqual(names('baseline'), names('candidate').slice(0, 3),
    'the refusal family must not itself be a candidate prefix');
  assert.equal(validateMigrationStagedSource({ ...source, outputRoot: result.outputRoot }).executionAllowed, false);
});

test('changed, truncated, deleted, extra and empty entries under a staged root are refused on consumption', () => {
  for (const change of ['bytes', 'truncate', 'delete', 'extra-file', 'extra-directory', 'empty-directory',
    'receipt-removed', 'stage-removed']) {
    const { result, consume } = stagedCase(`mutate-${change}`);
    const target = join(result.outputRoot, anyStagedMigration(result.receipt));
    if (change === 'bytes') writeFileSync(target, '-- mutated after staging\n');
    if (change === 'truncate') writeFileSync(target, '');
    if (change === 'delete') rmSync(target);
    if (change === 'extra-file') writeFileSync(join(result.outputRoot, 'candidate/migrations/extra.sql'), '-- extra\n');
    if (change === 'extra-directory') mkdirSync(join(result.outputRoot, 'candidate/migrations/20260101000000_extra'), { mode: 0o700 });
    if (change === 'empty-directory') mkdirSync(join(result.outputRoot, 'candidate/empty'), { mode: 0o700 });
    if (change === 'receipt-removed') rmSync(join(result.outputRoot, 'receipt.json'));
    if (change === 'stage-removed') rmSync(join(result.outputRoot, 'baseline'), { recursive: true });
    assert.throws(consume, undefined, change);
  }
});

test('a symlink, hardlink, executable mode or loosened directory mode under a staged root is refused', () => {
  for (const change of ['file-symlink', 'directory-symlink', 'hardlink', 'executable', 'directory-mode']) {
    const { result, consume } = stagedCase(`substitute-${change}`);
    const relative = anyStagedMigration(result.receipt);
    const target = join(result.outputRoot, relative);
    if (change === 'file-symlink') {
      const copy = join(scratch, `sub-${++serial}.sql`);
      cpSync(target, copy);
      rmSync(target);
      symlinkSync(copy, target);
    }
    if (change === 'directory-symlink') {
      const directory = dirname(target);
      const copy = join(scratch, `subdir-${++serial}`);
      cpSync(directory, copy, { recursive: true });
      rmSync(directory, { recursive: true });
      symlinkSync(copy, directory);
    }
    if (change === 'hardlink') {
      const copy = join(result.outputRoot, 'candidate/migrations/20260101000000_link/migration.sql');
      mkdirSync(dirname(copy), { mode: 0o700 });
      linkSync(target, copy);
    }
    if (change === 'executable') chmodSync(target, 0o700);
    if (change === 'directory-mode') chmodSync(join(result.outputRoot, 'candidate'), 0o755);
    assert.throws(consume, undefined, change);
  }
});

test('source movement after staging is refused on consumption, and during materialization', () => {
  const { root, result, consume } = stagedCase('source-movement');
  const relative = anyStagedMigration(result.receipt);
  const sourcePath = relative.replace(/^candidate\/migrations\//, 'backend/prisma/migrations/');
  const stagedBefore = readFileSync(join(result.outputRoot, relative));
  writeFileSync(join(root, sourcePath), '-- source moved after staging\n');
  assert.throws(consume, undefined, 'a moved source cannot certify an older staged root');
  // The staged bytes themselves are untouched; it is the SOURCE that changed,
  // and the staged copy still equals the fixture's own committed bytes.
  const stagedAfter = readFileSync(join(result.outputRoot, relative));
  assert.ok(stagedBefore.equals(stagedAfter));
  assert.ok(stagedAfter.equals(small.data(sourcePath, 'candidateFiles')));

  const moved = small.fixture();
  writeFileSync(join(moved.root, sourcePath), '-- moved before staging\n');
  const parent = parentFor('source-movement-pre');
  assert.throws(() => materializeMigrationSource({ ...moved.source, scratchParent: parent }));
  assert.deepEqual(readdirSync(parent), []);
});

/* ================================= receipt forgery ================================= */

test('an altered, extended, stale or substituted receipt is refused by independent reconstruction', () => {
  const alterations = [
    receipt => { receipt.executionAllowed = true; },
    receipt => { receipt.candidateCommit = 'e'.repeat(40); },
    receipt => { receipt.candidateTree = 'f'.repeat(40); },
    receipt => { receipt.baselineCommit = '0'.repeat(40); },
    receipt => { receipt.candidateDigest = '1'.repeat(64); },
    receipt => { receipt.kind = 'haw70-migration-stage-receipt-v2'; },
    receipt => { receipt.databaseUrl = 'postgresql://synthetic/invalid'; },
    receipt => { receipt.stages.candidate.migrationCount = 80; },
    receipt => { receipt.stages.candidate.fileCount = 95; },
    receipt => { receipt.stages.candidate.bytes += 1; },
    receipt => { receipt.stages.candidate.schema = 'baseline/schema.prisma'; },
    receipt => { receipt.stages.candidate.files[0].sha256 = '2'.repeat(64); },
    receipt => { receipt.stages.candidate.files[0].bytes += 1; },
    receipt => { receipt.stages.candidate.files[0].path = 'baseline/schema.prisma'; },
    receipt => { receipt.stages.candidate.files[0].extra = true; },
    receipt => { receipt.stages.candidate.files.push({ ...receipt.stages.candidate.files[0] }); },
    receipt => { receipt.stages.candidate.files.shift(); },
    receipt => { delete receipt.stages.baseline; },
    receipt => { receipt.stages.extra = receipt.stages.baseline; },
  ];
  for (const [index, alter] of alterations.entries()) {
    const { result, consume } = stagedCase(`receipt-${index}`);
    const path = join(result.outputRoot, 'receipt.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    alter(receipt);
    writeFileSync(path, `${JSON.stringify(receipt, null, 1)}\n`);
    assert.throws(consume, undefined, `alteration ${index}`);
  }
});

test('an unparseable or oversized receipt is refused before it is parsed', () => {
  for (const content of ['not json at all\n', '[]\n', 'null\n', '{"kind":"haw70-migration-stage-receipt-v1"}\n',
    'x'.repeat(HAW70_STAGE_CAPS.receipt + 1)]) {
    const { result, consume } = stagedCase(`receipt-shape-${++serial}`);
    writeFileSync(join(result.outputRoot, 'receipt.json'), content);
    assert.throws(consume, undefined, content.slice(0, 20));
  }
});

test('a staged root from a different source cannot be certified by the pinned validator', () => {
  // Non-prefix, and a different selection from `small`, so the refusal below is
  // "a different source" rather than the prefix counterexample.
  const other = family('other', [...base, migrationPath(2), migrationPath(6)],
    [...base, ...[2, 4, 6, 7].map(migrationPath)]);
  const foreign = other.fixture();
  const parent = parentFor('foreign');
  const staged = materializeMigrationSource({ ...foreign.source, scratchParent: parent });
  assert.equal(staged.executionAllowed, false);
  assert.throws(() => validateHaw70UpgradeStagedSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, outputRoot: staged.outputRoot }),
  /Receipt does not match|namespace differs/);
  const { source } = small.fixture();
  assert.throws(() => validateMigrationStagedSource({ ...source, outputRoot: staged.outputRoot }),
    /Receipt does not match|namespace differs/);
});

/* ==================================== inactivity ==================================== */

test('importing the materializer performs no filesystem, Git or network work', () => {
  const probe = parentFor('import-probe');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import('${join(import.meta.dirname, 'haw70-upgrade-materializer.mjs')}')
       .then(module => { if (typeof module.materializeHaw70UpgradeSource !== 'function') process.exit(9); });`],
  { cwd: probe, encoding: 'utf8', timeout: 30_000, env: { ...environment, HOME: probe } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  assert.deepEqual(readdirSync(probe), [], 'an import must not create anything');
});

test('materialization and validation open no socket, resolve no name and start no migration CLI', () => {
  const connect = net.Socket.prototype.connect;
  const createConnection = net.createConnection;
  const lookup = dns.lookup;
  let attempts = 0;
  const refuse = () => { attempts += 1; throw new Error('synthetic network guard'); };
  net.Socket.prototype.connect = refuse;
  net.createConnection = refuse;
  dns.lookup = refuse;
  try {
    const parent = parentFor('nonconnecting');
    const result = materializeHaw70UpgradeSource(
      { repositoryRoot, expectedCandidateCommit: actualHead, scratchParent: parent });
    validateHaw70UpgradeStagedSource(
      { repositoryRoot, expectedCandidateCommit: actualHead, outputRoot: result.outputRoot });
    assert.equal(attempts, 0, 'no connection or name resolution was attempted');
    // POSITIVE CONTROL: the guard really fires, so zero is not vacuous.
    assert.throws(() => net.createConnection({ port: 1 }), /synthetic network guard/);
    assert.equal(attempts, 1);
  } finally {
    net.Socket.prototype.connect = connect;
    net.createConnection = createConnection;
    dns.lookup = lookup;
  }
});

test('neither module imports a database client, dotenv or an unsanitized subprocess', () => {
  const materializer = readFileSync(join(import.meta.dirname, 'haw70-upgrade-materializer.mjs'), 'utf8');
  const adapter = readFileSync(join(import.meta.dirname, 'haw70-upgrade-git-source.mjs'), 'utf8');
  const imports = source => [...source.matchAll(/^import[^;]*from\s+'([^']+)';/gm)].map(match => match[1]);
  for (const [label, source] of [['materializer', materializer], ['adapter', adapter]]) {
    for (const forbidden of ['@prisma/client', 'prisma', 'pg', 'dotenv', 'node:http', 'node:https', 'node:net', 'node:dns']) {
      assert.equal(imports(source).includes(forbidden), false, `${label} imports ${forbidden}`);
    }
    assert.doesNotMatch(source, /migrate\s+deploy|PrismaClient|DATABASE_URL|process\.env/, label);
  }
  // Only the sanitized adapter spawns anything, and only Git.
  assert.equal(imports(materializer).includes('node:child_process'), false);
  assert.ok(imports(adapter).includes('node:child_process'), 'positive control: the probe does detect a real import');
  assert.deepEqual([...adapter.matchAll(/spawnSync\(([^,]+),/g)].map(match => match[1].trim()), ["'/usr/bin/git'"]);
});

test('every returned receipt and result is deeply frozen and refuses execution', () => {
  const parent = parentFor('frozen');
  const result = materializeHaw70UpgradeSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, scratchParent: parent });
  const validated = validateHaw70UpgradeStagedSource(
    { repositoryRoot, expectedCandidateCommit: actualHead, outputRoot: result.outputRoot });
  for (const value of [result, result.receipt, result.receipt.stages.baseline,
    result.receipt.stages.candidate.files[0], validated, validated.receipt]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => { result.executionAllowed = true; }, TypeError);
  assert.throws(() => { result.receipt.stages.candidate.migrationCount = 0; }, TypeError);
  assert.throws(() => { result.receipt.stages.candidate.files.push({}); }, TypeError);
  assert.equal(JSON.stringify(result.receipt).includes('postgres'), false);
  assert.equal(JSON.stringify(result.receipt).includes('://'), false);
});
