import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendDirectory = fileURLToPath(new URL('../../backend/', import.meta.url));

// Keep this exact inventory aligned with the existing disposable-database inventory test.
// Producer-only fixtures and suites with global DELETE/TRUNCATE participate as well.
export const databaseTests = Object.freeze([
  'alerts/alert-dispositions.database-integration.test.ts',
  'alerts/finding-pipeline.database-integration.test.ts',
  'alerts/in-app-visibility.database-integration.test.ts',
  'alerts/send-job-withdrawal.database-integration.test.ts',
  'alerts/send-store.database-integration.test.ts',
  'alerts/suppressed-evidence-reader.database-integration.test.ts',
  'alerts/suppression-store.database-integration.test.ts',
  'identity-risk/identity-risk-key.database-integration.test.ts',
  'identity-risk/native-alert-retention.database-integration.test.ts',
  'identity-risk/qa-security-events-never-zero.database-integration.test.ts',
  'identity-risk/risk-assessment-connected.database-integration.test.ts',
  'identity-risk/risk-attempt-causality.database-integration.test.ts',
  'identity-risk/risk-global-lifecycle.database-integration.test.ts',
  'identity-risk/risk-history-retention.database-integration.test.ts',
  'identity-risk/risk-key-operator.database-integration.test.ts',
  'identity-risk/risk-utc-session.database-integration.test.ts',
  'identity-risk/wrapped-risk-key.database-integration.test.ts',
  'prisma/alert-table-rls.database-integration.test.ts',
  'prisma/public-schema-lockdown.database-integration.test.ts',
  'risky-users-wiring/expired-native-finding-alert.database-integration.test.ts',
  'risky-users-wiring/native-alert-publication-lifecycle.database-integration.test.ts',
  'risky-users-wiring/native-finding-to-alert.database-integration.test.ts',
  'secrets/secret-store.database-integration.test.ts',
  'tenants/tenant-directory.database-integration.test.ts',
  'workspace/workspace-audit.database-integration.test.ts',
  // This older filename contains an explicitly opted-in real PostgreSQL test.
  'tenants/sign-in-provisioning.test.ts',
].map(path => `src/${path}`).sort());

// Content identities prevent a reviewed mock exception from silently gaining real DB IO.
// Git blob identities use normalized LF bytes so Windows checkouts remain equivalent.
export const syntheticExceptions = Object.freeze({
  'src/identity-risk/mailbox-read-transaction.test.ts': {
    blob: '05b183e12495bba38ac8c628e344edcf10a33331',
    reason: 'Malformed URL and test-owned synthetic loopback transport, not shared PostgreSQL.',
  },
  'src/identity-risk/risk-bounded-prisma-transaction.test.ts': {
    blob: '955aa06a1b3192453dd37b4200a6f3526268ad11',
    reason: 'Test-owned fake PostgreSQL wire server on an ephemeral loopback port.',
  },
  'src/identity-risk/risk-cycle-failure-stages.test.ts': {
    blob: '01ba665f37c7afa6a856f671ed3c9cef03e311cb',
    reason: 'Synthetic dependency failures and closed-port configuration, not fixture DB IO.',
  },
  'src/risky-users-wiring/risky-users-gates.test.ts': {
    blob: '68312cdbf7268eacecea9901a307694c67b4b90c',
    reason: 'Mocked gate dependencies with synthetic closed-port configuration.',
  },
  'src/identity-risk/risk-cycle-second-evaluation.test.ts': {
    blob: 'd242c21630ca18d465a0bb78de29c054c738b8f9',
    reason: 'Mocked evaluator dependencies with synthetic closed-port configuration.',
  },
  'src/identity-risk/risk-key-operator.test.ts': {
    blob: '10f25fbba7dfb0d7a23bc2d58a1b5471933afe1f',
    reason: 'Injected operator dependencies; invalid synthetic connection configuration.',
  },
  'src/prisma/native-alert-test-database.test.ts': {
    blob: 'f0c40c2b21ef3ce957804045d7222c6ddf398c1d',
    reason: 'Pure disposable-boundary parsing assertions; no connection is opened.',
  },
  'src/prisma/native-alert-test-database.inventory.test.ts': {
    blob: '1e250eb557d48b3be52d68f8963de86bb62a178d',
    reason: 'Source/token inventory of database guards, not execution of database fixtures.',
  },
});

const databaseMarkers = /HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS|assertDisposable(?:NativeAlert|Test)Database|DATABASE_URL|new\s+(?:pg\.)?(?:Client|Pool|PrismaService|PrismaClient)\s*\(|\.\$connect\s*\(/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeTestPath(path) {
  requireCondition(typeof path === 'string' && !/[\x00-\x1f\x7f:]/.test(path), 'Unsafe test path');
  const normalized = path.replaceAll('\\', '/');
  requireCondition(normalized.startsWith('src/') && normalized.endsWith('.test.ts'), 'Unsafe test path');
  requireCondition(normalized.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe test path');
  return normalized;
}

export function reviewedBlob(source) {
  const bytes = Buffer.from(source.replaceAll('\r\n', '\n'));
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function discoverTests(directory = backendDirectory) {
  const entries = [];
  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      requireCondition(!entry.isSymbolicLink(), 'Symlink in backend test discovery requires review');
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        entries.push({ path, source: readFileSync(join(directory, path), 'utf8') });
      }
    }
  }
  visit('src');
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function planTests(entries, suppliedPaths) {
  const sources = new Map();
  for (const entry of entries) {
    const path = normalizeTestPath(entry.path);
    requireCondition(!sources.has(path), 'Duplicate discovered test');
    requireCondition(typeof entry.source === 'string', 'Missing test source');
    sources.set(path, entry.source);
  }
  const all = [...sources.keys()].sort();
  const supplied = suppliedPaths.map(normalizeTestPath).sort();
  requireCondition(new Set(supplied).size === supplied.length, 'Duplicate supplied test');
  requireCondition(JSON.stringify(all) === JSON.stringify(supplied), 'Supplied test discovery is incomplete or changed');

  const expected = new Set(databaseTests);
  for (const path of databaseTests) requireCondition(sources.has(path), `Missing database suite: ${path}`);
  const ordinary = [];
  for (const [path, source] of sources) {
    if (expected.has(path)) continue;
    requireCondition(!path.endsWith('.database-integration.test.ts'), `Unclassified database suite: ${path}`);
    const exception = Object.hasOwn(syntheticExceptions, path) ? syntheticExceptions[path] : undefined;
    if (exception) {
      requireCondition(reviewedBlob(source) === exception.blob, `Synthetic database exemption needs review: ${path}`);
    } else {
      requireCondition(!databaseMarkers.test(source), `Unclassified database-looking test: ${path}`);
    }
    ordinary.push(path);
  }
  requireCondition(ordinary.length > 0 && databaseTests.length > 0, 'Both backend test phases must be nonempty');
  return { ordinary: ordinary.sort(), database: [...databaseTests] };
}

export function runPhase(args, {
  spawnImpl = spawn, runtime = process, cwd = backendDirectory,
} = {}) {
  return new Promise(resolveResult => {
    let child;
    let interrupted = null;
    let spawnFailed = false;
    const listeners = new Map();
    try {
      child = spawnImpl(process.execPath, args, { cwd, stdio: 'inherit', shell: false });
    } catch {
      resolveResult({ code: 1, signal: null });
      return;
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const listener = () => {
        interrupted ??= signal;
        child.kill(signal);
      };
      listeners.set(signal, listener);
      runtime.on(signal, listener);
    }
    // Wait for close, not merely exit: child teardown and inherited streams must be finished.
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code, signal) => {
      for (const [name, listener] of listeners) runtime.removeListener(name, listener);
      resolveResult({ code: spawnFailed ? 1 : (code ?? 1), signal: interrupted ?? signal ?? null });
    });
  });
}

export async function runPlan(plan, options = {}) {
  const ordinary = await runPhase(['--import', 'tsx', '--test', ...plan.ordinary], options);
  if (ordinary.code !== 0 || ordinary.signal) return ordinary;
  return runPhase(['--import', 'tsx', '--test', '--test-concurrency=1', ...plan.database], options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = planTests(discoverTests(), process.argv.slice(2));
    console.log(`Backend tests: ${plan.ordinary.length} ordinary files, then ${plan.database.length} exclusive database files.`);
    const outcome = await runPlan(plan);
    if (outcome.signal) process.kill(process.pid, outcome.signal);
    else process.exitCode = outcome.code;
  } catch {
    // Do not echo connection configuration or arbitrary child error text into CI metadata.
    console.error('Backend test inventory or launcher failed; review the harness contract tests.');
    process.exitCode = 1;
  }
}
