import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' };
import { createHaw70UpgradeSourcePlan, verifyMigrationSourceSnapshots } from './haw70-upgrade-source-plan.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const schema = 'backend/prisma/schema.prisma';
const isMigration = file => file.path.endsWith('/migration.sql');
const baselineOnlyBoundary = [
  '20261113005500_tenant_audit_reconciliation_work',
  '20261113015000_tenant_audit_reconciliation_revision_guard',
];
const newlyInterleaved = [
  '20261109150000_tenant_health_source_authority_foundation',
  '20261109150100_tenant_health_exact_source_index',
];

// All test payloads are synthetic and committed here by construction. Tests need
// no historical Git objects, filesystem reads, process, socket or database.
function fixture() {
  const files = (entries, stage) => entries.map(({ path, mode }) => ({ path, mode,
    bytes: Buffer.from(`synthetic fixture: ${path}${path === schema ? ':' + stage : ''}\n`),
  }));
  const snapshots = { baselineFiles: files(pins.baselineFiles, 'baseline'),
    candidateFiles: files(pins.candidateFiles, 'candidate') };
  const expected = Object.fromEntries(Object.entries(snapshots).map(([stage, entries]) => [stage,
    entries.map(({ path, mode, bytes }) => ({ path, mode, sha256: hash(bytes) }))]));
  return { expected, snapshots };
}

test('exact baseline membership, not candidate sorted prefix, yields the fourteen pending migrations', () => {
  const { expected, snapshots } = fixture();
  const plan = verifyMigrationSourceSnapshots(expected, snapshots);
  assert.equal(plan.executionAllowed, false);
  assert.equal(plan.gitProvenanceVerified, false);
  assert.equal(plan.baselineFiles.filter(isMigration).length, 80);
  assert.equal(plan.candidateFiles.filter(isMigration).length, 94);
  assert.equal(plan.migrationAdditions.length, 14);
  for (const name of baselineOnlyBoundary) assert.ok(plan.baselineFiles.some(file => file.path.includes(name)));
  for (const name of newlyInterleaved) assert.ok(plan.migrationAdditions.some(file => file.path.includes(name)));
  assert.deepEqual(verifyMigrationSourceSnapshots(expected, {
    baselineFiles: [...snapshots.baselineFiles].reverse(),
    candidateFiles: [...snapshots.candidateFiles].reverse(),
  }), plan);
});

test('wrong first-eighty plan is refused despite the right count and unchanged individual bytes', () => {
  const { expected, snapshots } = fixture();
  snapshots.baselineFiles = [...snapshots.candidateFiles.filter(isMigration).slice(0, 80),
    ...snapshots.baselineFiles.filter(file => !isMigration(file))];
  assert.equal(snapshots.baselineFiles.length, 85);
  for (const name of newlyInterleaved) assert.ok(snapshots.baselineFiles.some(file => file.path.includes(name)));
  for (const name of baselineOnlyBoundary) assert.ok(!snapshots.baselineFiles.some(file => file.path.includes(name)));
  assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /Baseline snapshot differs/);
});

for (const stage of ['baselineFiles', 'candidateFiles']) {
  test(`${stage}: missing, extra and duplicate migrations cannot hide in a map`, () => {
    for (const mutation of ['missing', 'extra', 'duplicate']) {
      const { expected, snapshots } = fixture();
      const index = snapshots[stage].findIndex(isMigration);
      if (mutation === 'missing') snapshots[stage].splice(index, 1);
      if (mutation === 'extra') snapshots[stage].push({ path:
        'backend/prisma/migrations/20261121160000_unapproved/migration.sql', mode: '100644', bytes: Buffer.from('-- extra') });
      if (mutation === 'duplicate') snapshots[stage].push({ ...snapshots[stage][index] });
      assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /differs|duplicate/);
    }
  });

  test(`${stage}: raw-byte changes in migrations, schema and every compatibility file are refused`, () => {
    const { snapshots: initial } = fixture();
    const selected = [initial[stage].find(isMigration).path,
      ...initial[stage].filter(file => !isMigration(file)).map(file => file.path)];
    if (stage === 'candidateFiles') selected.push(initial[stage].find(file => file.path.includes(newlyInterleaved[0])).path);
    for (const path of selected) {
      const { expected, snapshots } = fixture();
      const entry = snapshots[stage].find(file => file.path === path);
      entry.bytes = Buffer.concat([entry.bytes, Buffer.from('\n')]);
      assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /snapshot differs/, path);
    }
  });

  test(`${stage}: alias paths, symlinks, executable blobs and supplied checksums are refused`, () => {
    for (const patch of [
      { path: '/backend/prisma/schema.prisma' }, { path: 'backend/prisma/../prisma/schema.prisma' },
      { path: './backend/prisma/schema.prisma' }, { path: 'backend\\prisma\\schema.prisma' },
      { path: 'backend/prisma/schema.prisma/' }, { path: 'backend/prisma/schema.prisma\0' },
      { mode: '120000' }, { mode: '100755' }, { mode: '160000' }, { mode: 100644 },
      { sha256: 'a'.repeat(64) }, { bytes: 'not raw bytes' },
      { bytes: new Uint8Array(new SharedArrayBuffer(1)) },
    ]) {
      const { expected, snapshots } = fixture();
      Object.assign(snapshots[stage][0], patch);
      assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots));
    }
  });
}

test('expected manifests cannot authorize rewriting existing migrations or compatibility files', () => {
  for (const path of ['backend/package.json', 'backend/prisma/migrations/migration_lock.toml',
    pins.baselineFiles.find(isMigration).path]) {
    const { expected, snapshots } = fixture();
    expected.candidateFiles.find(file => file.path === path).sha256 = 'a'.repeat(64);
    assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /does not preserve/);
  }
  const { expected, snapshots } = fixture();
  expected.candidateFiles = expected.candidateFiles.filter(file => file.path !== pins.baselineFiles.find(isMigration).path);
  assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /does not preserve/);
});

test('malformed or incomplete inventories and forged provenance never become execution authority', () => {
  for (const input of [null, {}, { baselineFiles: [], candidateFiles: [] },
    { ...fixture().snapshots, candidateCommit: 'a'.repeat(40) },
    { ...fixture().snapshots, gitProvenanceVerified: true }]) {
    assert.throws(() => createHaw70UpgradeSourcePlan(input));
  }
  const { expected, snapshots } = fixture();
  snapshots.baselineFiles = snapshots.baselineFiles.filter(file => file.path !== schema);
  assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /missing schema/);
  expected.baselineFiles[0].sha256 = 'not-a-checksum';
  assert.throws(() => verifyMigrationSourceSnapshots(expected, snapshots), /invalid checksum/);
});

test('plans are deeply immutable metadata with no retained byte references', () => {
  const { expected, snapshots } = fixture();
  const plan = verifyMigrationSourceSnapshots(expected, snapshots);
  const serialized = JSON.stringify(plan);
  const inspect = value => {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value));
      assert.ok(!(value instanceof Uint8Array));
      Object.values(value).forEach(inspect);
    }
  };
  inspect(plan);
  assert.throws(() => { plan.executionAllowed = true; }, TypeError);
  assert.throws(() => plan.migrationAdditions.pop(), TypeError);
  assert.throws(() => { plan.baselineFiles[0].sha256 = 'a'.repeat(64); }, TypeError);
  snapshots.baselineFiles[0].bytes.fill(0);
  expected.baselineFiles[0].path = 'changed';
  assert.equal(JSON.stringify(plan), serialized);
});

test('production wrapper stays pinned; valid synthetic-core bytes cannot impersonate reviewed source', () => {
  const { snapshots } = fixture();
  assert.throws(() => createHaw70UpgradeSourcePlan(snapshots), /Baseline snapshot differs/);
  assert.throws(() => createHaw70UpgradeSourcePlan({ ...snapshots, expected: fixture().expected }), /unexpected shape/);
  assert.equal(pins.baselineCommit, '8928934406fdcaf5fdb911d2003ac03439b05145');
  assert.equal(pins.reviewedCandidateCommit, 'a88af992b4ee156a8abf9c1a64c3725055acc42a');
  for (const stage of ['baselineFiles', 'candidateFiles']) {
    const rows = [...pins[stage]].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.equal(hash(JSON.stringify(rows.map(file => [file.path, file.mode, file.sha256]))),
      pins[stage === 'baselineFiles' ? 'baselineDigest' : 'candidateDigest']);
  }
});
