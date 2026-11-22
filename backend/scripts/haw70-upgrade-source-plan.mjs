import { createHash } from 'node:crypto';
import pinned from './haw70-upgrade-source-manifest.json' with { type: 'json' };

const schemaPath = 'backend/prisma/schema.prisma';
const compatibilityPaths = [
  'backend/package.json',
  'backend/package-lock.json',
  'backend/prisma.config.ts',
  'backend/prisma/migrations/migration_lock.toml',
];
const migrationPath = /^backend\/prisma\/migrations\/[0-9]{14}_[a-z0-9_]+\/migration\.sql$/;
const allowedPath = path => typeof path === 'string'
  && (path === schemaPath || compatibilityPaths.includes(path) || migrationPath.test(path));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
freeze(pinned);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label}: unexpected shape`);
  }
}

function inventory(entries, bytes, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label}: empty inventory`);
  const seen = new Set();
  const result = entries.map(entry => {
    exactKeys(entry, bytes ? ['path', 'mode', 'bytes'] : ['path', 'mode', 'sha256'], label);
    if (!allowedPath(entry.path)) throw new Error(`${label}: unapproved path`);
    if (seen.has(entry.path)) throw new Error(`${label}: duplicate path`);
    seen.add(entry.path);
    if (entry.mode !== '100644') throw new Error(`${label}: regular non-executable Git blob required`);
    let checksum;
    if (bytes) {
      if (!(entry.bytes instanceof Uint8Array)
        || entry.bytes.buffer instanceof SharedArrayBuffer) {
        throw new Error(`${label}: private raw bytes required`);
      }
      checksum = sha256(entry.bytes);
    } else {
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error(`${label}: invalid checksum pin`);
      }
      checksum = entry.sha256;
    }
    return { path: entry.path, mode: entry.mode, sha256: checksum };
  }).sort(order);
  for (const path of [schemaPath, ...compatibilityPaths]) {
    if (!seen.has(path)) throw new Error(`${label}: missing schema or compatibility file`);
  }
  return result;
}

const digest = files => sha256(JSON.stringify(files.map(file => [file.path, file.mode, file.sha256])));

// Pure core for synthetic refusal tests. An arbitrary expected manifest is NOT
// an authorization boundary: neither this core nor the pinned wrapper can execute.
export function verifyMigrationSourceSnapshots(expected, snapshots) {
  exactKeys(expected, ['baselineFiles', 'candidateFiles'], 'expected manifest');
  exactKeys(snapshots, ['baselineFiles', 'candidateFiles'], 'source snapshots');
  const baseline = inventory(expected.baselineFiles, false, 'expected baseline');
  const candidate = inventory(expected.candidateFiles, false, 'expected candidate');
  const candidateByPath = new Map(candidate.map(file => [file.path, file]));
  for (const file of baseline) {
    const retained = candidateByPath.get(file.path);
    if (!retained || (file.path !== schemaPath && retained.sha256 !== file.sha256)) {
      throw new Error('Expected candidate does not preserve the baseline and compatibility files');
    }
  }
  const actualBaseline = inventory(snapshots.baselineFiles, true, 'baseline snapshot');
  const actualCandidate = inventory(snapshots.candidateFiles, true, 'candidate snapshot');
  if (digest(actualBaseline) !== digest(baseline)) throw new Error('Baseline snapshot differs from pinned set or bytes');
  if (digest(actualCandidate) !== digest(candidate)) throw new Error('Candidate snapshot differs from pinned set or bytes');
  const baselinePaths = new Set(baseline.map(file => file.path));
  const additions = candidate.filter(file => !baselinePaths.has(file.path));
  if (additions.length === 0 || additions.some(file => !migrationPath.test(file.path))) {
    throw new Error('Expected additions must be migration files');
  }
  return freeze({
    kind: 'migration-source-plan-only-v1',
    executionAllowed: false,
    gitProvenanceVerified: false,
    baselineDigest: digest(actualBaseline),
    candidateDigest: digest(actualCandidate),
    baselineFiles: actualBaseline,
    candidateFiles: actualCandidate,
    migrationAdditions: additions.map(file => ({ ...file })),
  });
}

// These refs describe the reviewed pin source, not a verified caller checkout.
// A future Git adapter must prove actual HEAD, ancestry, complete tree enumeration
// and current bytes again before any separately guarded execution stage.
export function createHaw70UpgradeSourcePlan(snapshots) {
  const plan = verifyMigrationSourceSnapshots({
    baselineFiles: pinned.baselineFiles,
    candidateFiles: pinned.candidateFiles,
  }, snapshots);
  if (plan.baselineFiles.length !== 85 || plan.candidateFiles.length !== 99
    || plan.migrationAdditions.length !== 14
    || plan.baselineDigest !== pinned.baselineDigest
    || plan.candidateDigest !== pinned.candidateDigest) {
    throw new Error('HAW-70 reviewed source manifest is inconsistent');
  }
  return freeze({ ...plan, reviewedBaselineCommit: pinned.baselineCommit,
    reviewedCandidateCommit: pinned.reviewedCandidateCommit });
}
