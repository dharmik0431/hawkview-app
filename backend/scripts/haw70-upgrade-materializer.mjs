import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' };
import { acquireHaw70UpgradeGitSource, acquireMigrationGitSource } from './haw70-upgrade-git-source.mjs';

/**
 * HAW-70 raw-Git migration-stage materializer, numbered requirements 1-7 of the
 * reviewed source-materialization contract.
 *
 * UNUSED BY DESIGN. Nothing in the application imports this module, no runtime
 * caller exists, and importing it performs no work: every constant below is
 * pure data and no filesystem or Git operation runs at module scope.
 *
 * It copies pinned baseline and candidate migration source out of their exact
 * Git trees into a private scratch root and returns a descriptive frozen
 * receipt with `executionAllowed: false`. It NEVER creates a database client,
 * invokes a migration CLI, opens a socket, reads ambient environment or
 * resolves a datasource URL. A receipt is data, not a capability.
 *
 * SOURCE AUTHORITY. The public entry points take only a canonical repository
 * root, an exact candidate identity and a canonical scratch parent, and they
 * invoke the pinned Git acquisition themselves. A caller-supplied snapshot,
 * file list, checksum map, baseline reference, executable, config or datasource
 * is never accepted, and the generic offline-fixture core below is a synthetic
 * seam for refusal tests only: it still acquires every byte from the Git trees
 * it is pointed at, and it cannot execute anything either.
 *
 * SUPPORTED CONTEXT, stated rather than exaggerated. A private hosted-job
 * scratch directory with no untrusted concurrent writer sharing this OS
 * identity. The namespace, mode, link-count, length and digest checks detect
 * ordinary substitution and mutation; they are NOT a filesystem-race guarantee
 * against a hostile process running as the same user.
 */

const MiB = 1024 * 1024;
/** Reviewed bounds. Enforced incrementally during acquisition and while
 *  reading descriptors, at most cap plus one byte, never by trusting a
 *  pre-read size and then reading without a bound. */
export const HAW70_STAGE_CAPS = Object.freeze({
  file: MiB, snapshot: 2 * MiB, combined: 4 * MiB, stage: 2 * MiB, receipt: 128 * 1024,
});

const SCHEMA_SOURCE = 'backend/prisma/schema.prisma';
const MIGRATION_ROOT = 'backend/prisma/migrations';
const LOCK_SOURCE = `${MIGRATION_ROOT}/migration_lock.toml`;
const MIGRATION_SOURCE = /^backend\/prisma\/migrations\/([0-9]{14}_[a-z0-9_]+)\/migration\.sql$/;
/** Verified as compatibility inputs by the adapter, deliberately never staged. */
const COMPATIBILITY_ONLY = Object.freeze([
  'backend/package.json', 'backend/package-lock.json', 'backend/prisma.config.ts',
]);
const STAGES = Object.freeze(['baseline', 'candidate']);
const RECEIPT_ENTRY = 'receipt.json';
const RECEIPT_KIND = 'haw70-migration-stage-receipt-v1';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function exactKeys(value, names, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) {
    throw new Error(`${label}: unexpected shape`);
  }
  return value;
}
function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
    || realpathSync(value) !== value || !lstatSync(value).isDirectory()) {
    throw new Error(`${label}: canonical real directory required`);
  }
  return value;
}
const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

/* ----------------------------- fixed stage mapping ----------------------------- */

/**
 * Requirement 5. One fixed mapping, derived from each stage's OWN verified
 * selected set. The baseline stage is never "the first N candidate names":
 * `assertDistinctMigrationSelection` refuses exactly that counterexample.
 */
function stageLayout(stage, files) {
  const migrations = [];
  const mapped = [];
  let schema = null;
  let lock = null;
  for (const file of files) {
    if (file.path === SCHEMA_SOURCE) {
      schema = `${stage}/schema.prisma`;
      mapped.push({ source: file.path, stagePath: schema });
      continue;
    }
    if (file.path === LOCK_SOURCE) {
      lock = `${stage}/migrations/migration_lock.toml`;
      mapped.push({ source: file.path, stagePath: lock });
      continue;
    }
    const match = MIGRATION_SOURCE.exec(file.path);
    if (match) {
      migrations.push(match[1]);
      mapped.push({ source: file.path, stagePath: `${stage}/migrations/${match[1]}/migration.sql` });
      continue;
    }
    if (!COMPATIBILITY_ONLY.includes(file.path)) throw new Error('Unmappable selected source path');
  }
  if (!schema || !lock || migrations.length === 0) throw new Error('Stage is missing its schema, lock or migrations');
  if (new Set(mapped.map(entry => entry.stagePath)).size !== mapped.length) throw new Error('Duplicate stage path');
  return { stage, schema, lock, migrations: migrations.sort(), mapped: mapped.sort((a, b) => a.stagePath < b.stagePath ? -1 : 1) };
}

/** Requirement 5 and the reviewed interleaved counterexample. */
function assertDistinctMigrationSelection(baseline, candidate) {
  const retained = new Set(candidate.migrations);
  if (baseline.migrations.some(name => !retained.has(name))) {
    throw new Error('Baseline migration is absent from the candidate selection');
  }
  if (candidate.migrations.length <= baseline.migrations.length) {
    throw new Error('Candidate selection must add migrations to the baseline');
  }
  const prefix = candidate.migrations.slice(0, baseline.migrations.length);
  if (prefix.join('\u0000') === baseline.migrations.join('\u0000')) {
    throw new Error('Baseline selection must come from the baseline tree, not the candidate name prefix');
  }
}

/* --------------------------- bounded descriptor access --------------------------- */

/** Reads at most `cap + 1` bytes, so overflow is observed instead of inferred
 *  from a size the file no longer has. */
function readBoundedFile(absolutePath, cap, label) {
  const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label}: regular file required`);
    if (stat.nlink !== 1) throw new Error(`${label}: staged file must have a single link`);
    if ((stat.mode & 0o111) !== 0) throw new Error(`${label}: staged file must not be executable`);
    const buffer = Buffer.allocUnsafe(cap + 1);
    let total = 0;
    for (;;) {
      if (total > cap) break;
      const read = readSync(fd, buffer, total, cap + 1 - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > cap) throw new Error(`${label}: exceeds its byte cap`);
    return { bytes: buffer.subarray(0, total), stat };
  } finally { closeSync(fd); }
}

function writeExclusiveFile(absolutePath, bytes, label) {
  const fd = openSync(absolutePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (!(count > 0)) throw new Error(`${label}: short write`);
      written += count;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== bytes.length || stat.nlink !== 1 || (stat.mode & 0o111) !== 0) {
      throw new Error(`${label}: short or irregular staged write`);
    }
  } finally { closeSync(fd); }
}

function makeExclusiveDirectory(absolutePath, label) {
  // Non-recursive: an existing path is refused rather than reused.
  mkdirSync(absolutePath, { mode: DIRECTORY_MODE });
  const stat = lstatSync(absolutePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}: directory expected`);
  return absolutePath;
}

/* ------------------------------ namespace inspection ------------------------------ */

/**
 * Requirement 6. Enumerates the WHOLE root, so an extra file, an extra or
 * empty directory, a symlink, a device node or a wrong mode is observed rather
 * than skipped. Enumeration stops after the exact expected entry count plus
 * one so a hostile fan-out cannot be walked indefinitely.
 */
function inspectNamespace(root, expectedFiles, expectedDirectories) {
  const limit = expectedFiles.size + expectedDirectories.size + 1;
  const files = new Set();
  const directories = new Set();
  const pending = [''];
  let seen = 0;
  while (pending.length) {
    const relative = pending.shift();
    const absolute = relative ? join(root, relative) : root;
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Staged namespace contains a nondirectory parent');
    if ((stat.mode & 0o7777) !== DIRECTORY_MODE) throw new Error('Staged directory must stay owner-only');
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (++seen > limit) throw new Error('Staged namespace enumeration bound exceeded');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Staged namespace contains a symlink');
      if (entry.isDirectory()) { directories.add(path); pending.push(path); }
      else if (entry.isFile()) files.add(path);
      else throw new Error('Staged namespace contains a nonregular entry');
    }
  }
  const same = (actual, expected, what) => {
    if ([...actual].sort().join('\u0000') !== [...expected].sort().join('\u0000')) {
      throw new Error(`Staged ${what} namespace differs from the fixed mapping`);
    }
  };
  same(files, expectedFiles, 'file');
  same(directories, expectedDirectories, 'directory');
}

const expectedDirectorySet = layouts => {
  const directories = new Set();
  for (const layout of layouts) {
    directories.add(layout.stage);
    directories.add(`${layout.stage}/migrations`);
    for (const name of layout.migrations) directories.add(`${layout.stage}/migrations/${name}`);
  }
  return directories;
};

/* ---------------------------------- receipt ---------------------------------- */

const RECEIPT_KEYS = ['kind', 'executionAllowed', 'candidateCommit', 'candidateTree',
  'baselineCommit', 'reviewedCandidateCommit', 'baselineDigest', 'candidateDigest', 'stages'];
const STAGE_KEYS = ['schema', 'migrationLock', 'migrationCount', 'fileCount', 'bytes', 'files'];
const STAGE_FILE_KEYS = ['path', 'bytes', 'sha256'];

/**
 * Requirement 7. Descriptive data only: actual identities, stage paths, source
 * digests, copied counts and hashes, and an explicit refusal to authorise
 * execution. No datasource URL and no ambient environment is recorded.
 */
function buildReceipt(evidence, stageFiles) {
  const stages = {};
  for (const [layout, entries] of stageFiles) {
    stages[layout.stage] = {
      schema: layout.schema,
      migrationLock: layout.lock,
      migrationCount: layout.migrations.length,
      fileCount: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      files: entries.map(entry => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
    };
  }
  return {
    kind: RECEIPT_KIND,
    executionAllowed: false,
    candidateCommit: evidence.candidateCommit,
    candidateTree: evidence.candidateTree,
    baselineCommit: evidence.baselineCommit,
    reviewedCandidateCommit: evidence.reviewedCandidateCommit,
    baselineDigest: evidence.sourcePlan.baselineDigest,
    candidateDigest: evidence.sourcePlan.candidateDigest,
    stages,
  };
}

/** One canonical encoding, so comparison cannot be defeated by key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkReceiptShape(receipt) {
  exactKeys(receipt, RECEIPT_KEYS, 'receipt');
  if (receipt.kind !== RECEIPT_KIND) throw new Error('receipt: unexpected kind');
  if (receipt.executionAllowed !== false) throw new Error('receipt: execution is never allowed');
  exactKeys(receipt.stages, STAGES, 'receipt stages');
  for (const stage of STAGES) {
    const entry = exactKeys(receipt.stages[stage], STAGE_KEYS, `receipt stage ${stage}`);
    if (!Array.isArray(entry.files) || entry.files.length !== entry.fileCount) {
      throw new Error(`receipt stage ${stage}: file count does not match its entries`);
    }
    for (const file of entry.files) exactKeys(file, STAGE_FILE_KEYS, `receipt stage ${stage} file`);
  }
  return receipt;
}

/* --------------------------------- materialize --------------------------------- */

function materializeAcquired(acquired, scratchParent, reacquire) {
  const { evidence, raw, gitDirectories } = acquired;
  const checkout = evidence.repositoryRoot;
  const layouts = STAGES.map((stage, index) => stageLayout(stage, index === 0 ? raw.baseline : raw.candidate));
  assertDistinctMigrationSelection(layouts[0], layouts[1]);

  // Requirement 2: the copies that will be written are the ones that were
  // verified. A buffer swapped between hashing and writing is refused here.
  const verified = new Map();
  for (const [index, layout] of layouts.entries()) {
    const plan = index === 0 ? evidence.sourcePlan.baselineFiles : evidence.sourcePlan.candidateFiles;
    const pinned = new Map(plan.map(file => [file.path, file.sha256]));
    const owned = new Map((index === 0 ? raw.baseline : raw.candidate).map(file => [file.path, file.bytes]));
    for (const entry of layout.mapped) {
      const bytes = owned.get(entry.source);
      if (!bytes || sha256(bytes) !== pinned.get(entry.source)) {
        throw new Error('Privately acquired bytes do not match the verified source digest');
      }
      verified.set(entry.stagePath, bytes);
    }
  }

  // Requirement 4: exclusive private root outside the checkout, the actual
  // worktree Git metadata directory and the common Git directory. A linked
  // worktree's `.git` pointer file is not a containment boundary, so both are
  // resolved from Git itself.
  const parent = canonicalDirectory(scratchParent, 'scratch parent');
  for (const forbidden of [checkout, ...gitDirectories]) {
    if (within(parent, forbidden) || within(forbidden, parent)) {
      throw new Error('Scratch parent must lie outside the checkout and its Git metadata');
    }
  }
  const root = makeExclusiveDirectory(
    join(parent, `haw70-stage-${randomBytes(16).toString('hex')}`), 'output root');
  for (const forbidden of [checkout, ...gitDirectories]) {
    if (within(root, forbidden) || within(forbidden, root)) throw new Error('Output root is not isolated');
  }

  // Requirement 4 and 5: fixed mapped paths, exclusive regular nonexecutable
  // files, per-stage aggregate charged as each file is written.
  const stageFiles = [];
  for (const layout of layouts) {
    makeExclusiveDirectory(join(root, layout.stage), 'stage root');
    makeExclusiveDirectory(join(root, layout.stage, 'migrations'), 'stage migrations');
    for (const name of layout.migrations) {
      makeExclusiveDirectory(join(root, layout.stage, 'migrations', name), 'stage migration');
    }
    let staged = 0;
    const entries = [];
    for (const entry of layout.mapped) {
      const bytes = verified.get(entry.stagePath);
      if (bytes.length > HAW70_STAGE_CAPS.file) throw new Error('Staged file exceeds its byte cap');
      staged += bytes.length;
      if (staged > HAW70_STAGE_CAPS.stage) throw new Error('Staged stage exceeds its byte cap');
      writeExclusiveFile(join(root, entry.stagePath), bytes, entry.stagePath);
      entries.push({ path: entry.stagePath, bytes: bytes.length, sha256: sha256(bytes) });
    }
    stageFiles.push([layout, entries.sort((a, b) => a.path < b.path ? -1 : 1)]);
  }

  const receipt = checkReceiptShape(buildReceipt(evidence, stageFiles));
  const encoded = Buffer.from(`${JSON.stringify(receipt, null, 1)}\n`, 'utf8');
  if (encoded.length > HAW70_STAGE_CAPS.receipt) throw new Error('Receipt exceeds its byte cap');
  writeExclusiveFile(join(root, RECEIPT_ENTRY), encoded, RECEIPT_ENTRY);

  // Requirement 6: re-read everything that was just written, then prove the
  // source has not moved underneath the copy. A failed root is left in place
  // for inspection and never reused or deleted.
  verifyStagedRoot(root, receipt, verified);
  const again = reacquire();
  if (again.candidateCommit !== evidence.candidateCommit || again.candidateTree !== evidence.candidateTree
    || again.sourcePlan.baselineDigest !== evidence.sourcePlan.baselineDigest
    || again.sourcePlan.candidateDigest !== evidence.sourcePlan.candidateDigest) {
    throw new Error('Source identity or selected bytes changed during materialization');
  }
  return freeze({ kind: 'haw70-migration-stage-result-v1', executionAllowed: false,
    outputRoot: root, receiptPath: join(root, RECEIPT_ENTRY), receipt });
}

/** Shared by materialization's post-write pass and the independent consumer. */
function verifyStagedRoot(root, expectedReceipt, expectedBytes) {
  const expectedFiles = new Set([RECEIPT_ENTRY]);
  const directories = new Set();
  for (const stage of STAGES) {
    const entry = expectedReceipt.stages[stage];
    directories.add(stage);
    directories.add(`${stage}/migrations`);
    for (const file of entry.files) {
      expectedFiles.add(file.path);
      const match = /^(.+)\/[^/]+$/.exec(file.path);
      if (match && match[1] !== stage) directories.add(match[1]);
    }
  }
  inspectNamespace(root, expectedFiles, directories);
  for (const stage of STAGES) {
    for (const file of expectedReceipt.stages[stage].files) {
      const { bytes } = readBoundedFile(join(root, file.path), HAW70_STAGE_CAPS.file, file.path);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`Staged file does not match its recorded bytes: ${file.path}`);
      }
      const owned = expectedBytes?.get(file.path);
      if (owned && (owned.length !== bytes.length || sha256(owned) !== sha256(bytes))) {
        throw new Error(`Staged file differs from the acquired source: ${file.path}`);
      }
    }
  }
}

/** Generic offline-fixture core. Supplied refs/manifest grant no execution. */
export function materializeMigrationSource(input) {
  exactKeys(input, ['repositoryRoot', 'expectedCandidateCommit', 'baselineCommit',
    'reviewedCandidateCommit', 'manifest', 'scratchParent'], 'materializer input');
  const { scratchParent, ...source } = input;
  return materializeAcquired(
    acquireMigrationGitSource(source, HAW70_STAGE_CAPS), scratchParent,
    () => acquireMigrationGitSource(source, HAW70_STAGE_CAPS).evidence);
}

/** Requirement 1. Pinned, and the only input is root, identity and scratch parent. */
export function materializeHaw70UpgradeSource(input) {
  exactKeys(input, ['repositoryRoot', 'expectedCandidateCommit', 'scratchParent'], 'materializer input');
  const { scratchParent, ...source } = input;
  return materializeAcquired(
    acquireHaw70UpgradeGitSource(source, HAW70_STAGE_CAPS), scratchParent,
    () => acquireHaw70UpgradeGitSource(source, HAW70_STAGE_CAPS).evidence);
}

/* ------------------------- independent staged validation ------------------------- */

function validateAcquired(acquired, outputRoot) {
  const { evidence, raw } = acquired;
  const layouts = STAGES.map((stage, index) => stageLayout(stage, index === 0 ? raw.baseline : raw.candidate));
  assertDistinctMigrationSelection(layouts[0], layouts[1]);
  const owned = new Map();
  const stageFiles = [];
  for (const [index, layout] of layouts.entries()) {
    const bytesBySource = new Map((index === 0 ? raw.baseline : raw.candidate).map(file => [file.path, file.bytes]));
    const entries = [];
    for (const entry of layout.mapped) {
      const bytes = bytesBySource.get(entry.source);
      owned.set(entry.stagePath, bytes);
      entries.push({ path: entry.stagePath, bytes: bytes.length, sha256: sha256(bytes) });
    }
    stageFiles.push([layout, entries.sort((a, b) => a.path < b.path ? -1 : 1)]);
  }
  // The expected receipt is reconstructed from the pinned source, NOT read off
  // the disk. The disk copy is only ever compared against it.
  const expected = checkReceiptShape(buildReceipt(evidence, stageFiles));

  const root = canonicalDirectory(outputRoot, 'output root');
  const { bytes } = readBoundedFile(join(root, RECEIPT_ENTRY), HAW70_STAGE_CAPS.receipt, RECEIPT_ENTRY);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('receipt: unreadable or malformed'); }
  checkReceiptShape(parsed);
  if (canonical(parsed) !== canonical(expected)) {
    throw new Error('Receipt does not match the independently reconstructed expectation');
  }
  verifyStagedRoot(root, expected, owned);
  return freeze({ kind: 'haw70-migration-stage-validation-v1', executionAllowed: false,
    outputRoot: root, receipt: expected });
}

export function validateMigrationStagedSource(input) {
  exactKeys(input, ['repositoryRoot', 'expectedCandidateCommit', 'baselineCommit',
    'reviewedCandidateCommit', 'manifest', 'outputRoot'], 'validator input');
  const { outputRoot, ...source } = input;
  return validateAcquired(acquireMigrationGitSource(source, HAW70_STAGE_CAPS), outputRoot);
}

export function validateHaw70UpgradeStagedSource(input) {
  exactKeys(input, ['repositoryRoot', 'expectedCandidateCommit', 'outputRoot'], 'validator input');
  const { outputRoot, ...source } = input;
  return validateAcquired(acquireHaw70UpgradeGitSource(source, HAW70_STAGE_CAPS), outputRoot);
}

/** Reviewed pin identities, exposed as data for reports and tests only. */
export const HAW70_PINNED_SOURCE = Object.freeze({
  baselineCommit: pins.baselineCommit, reviewedCandidateCommit: pins.reviewedCandidateCommit,
  baselineDigest: pins.baselineDigest, candidateDigest: pins.candidateDigest,
});
