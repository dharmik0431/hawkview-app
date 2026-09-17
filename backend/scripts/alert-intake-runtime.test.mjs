import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const servicePath = resolve(backendRoot, 'src/alerts/alert-intake.service.ts')

// Match production's esbuild ESM/packages-external path, not tsc metadata emission.
// Nest constructs the real services; only the database I/O provider is synthetic.
// runOnce, store(), runnerFor and findOpenFindings are NOT replaced.
async function runRuntimeProbe(removeInjection) {
  const source = readFileSync(servicePath, 'utf8')
  assert.match(source, /constructor\(@Inject\(PrismaService\) private readonly prisma: PrismaService\)/)
  const serviceSource = removeInjection ? source.replace('@Inject(PrismaService)', '') : source
  const harness = `
    import 'reflect-metadata';
    import assert from 'node:assert/strict';
    import { Module } from '@nestjs/common';
    import { NestFactory } from '@nestjs/core';
    import { AlertIntakeService } from './src/alerts/alert-intake.service.ts';
    import { EmailAlertReleaseService } from './src/alerts/email-alert-release.service.ts';
    import { PrismaService } from './src/prisma/prisma.service.ts';

    let reads = 0;
    let writes = 0;
    let transactions = 0;
    const tickAt = new Date('2026-09-17T00:00:00.000Z');
    const database = {
      $queryRawUnsafe: async (sql, ...params) => {
        reads++;
        assert.match(sql, /FROM identity_risk_findings/);
        assert.match(sql, /state = 'OPEN'/);
        assert.deepEqual(params, ['2026-09-16T00:00:00.000Z', tickAt.toISOString()]);
        return [];
      },
      $executeRawUnsafe: async () => {
        writes++;
        throw new Error('No writes are permitted in the construction probe');
      },
      $transaction: async () => {
        transactions++;
        throw new Error('Empty intake and disabled email must not open transactions');
      },
    };
    class ProbeModule {}
    Module({ providers: [
      AlertIntakeService,
      EmailAlertReleaseService,
      { provide: PrismaService, useValue: database },
    ] })(ProbeModule);

    const app = await NestFactory.createApplicationContext(ProbeModule, { logger: false });
    try {
      const intake = app.get(AlertIntakeService);
      const email = app.get(EmailAlertReleaseService);
      assert.equal(Reflect.getMetadata('design:paramtypes', AlertIntakeService), undefined);
      assert.equal(Reflect.getMetadata('design:paramtypes', EmailAlertReleaseService), undefined);
      assert.equal(email.prisma, database, 'adjacent email service uses its explicit injection token');
      assert.deepEqual(await email.runOnce(Date.now() + 30_000), { status: 'DISABLED', attempted: 0 });
      assert.equal(reads, 0, 'disabled email does not touch the database');

      const watermark = process.env.HAWKVIEW_ALERT_WATERMARK_ISO;
      delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO;
      assert.equal((await intake.runOnce(Date.now() + 30_000, tickAt)).kind, 'NOT_CONFIGURED');
      assert.equal(reads, 0, 'missing watermark still refuses before the database boundary');
      process.env.HAWKVIEW_ALERT_WATERMARK_ISO = watermark;

      const outcome = await intake.runOnce(Date.now() + 30_000, tickAt);
      assert.equal(process.env.HAWKVIEW_ALERT_WATERMARK_ISO, watermark);
      if (${removeInjection}) {
        assert.equal(intake.prisma, undefined);
        assert.equal(outcome.kind, 'FAILED');
        assert.equal(outcome.phase, 'READING');
        assert.match(outcome.because, /undefined/);
        assert.match(outcome.because, /\\$queryRawUnsafe/);
        assert.deepEqual(outcome.attempted, { findingsRead: 0, incidents: 0, notifications: 0, jobs: 0 });
        assert.equal(reads, 0, 'undefined dependency fails before the database boundary');
      } else {
        assert.equal(intake.prisma, database);
        assert.equal(outcome.kind, 'COMPLETED');
        assert.equal(outcome.report.findingsRead, 0);
        assert.equal(outcome.report.incidentsWritten, 0);
        assert.equal(outcome.report.notificationsWritten, 0);
        assert.equal(outcome.report.jobsWritten, 0);
        assert.equal(reads, 1, 'real intake/store/runner reaches the injected database');
      }
      assert.equal(writes, 0);
      assert.equal(transactions, 0);
      console.log(JSON.stringify({
        missingInjectionReproduced: ${removeInjection},
        outcome: outcome.kind,
        reads,
        writes,
        transactions,
        adjacentEmailInjected: true,
        emailDisabled: true,
      }));
    } finally {
      await app.close();
    }
  `
  const compiled = await build({
    stdin: { contents: harness, resolveDir: backendRoot, sourcefile: 'alert-intake-runtime-probe.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    tsconfig: resolve(backendRoot, 'tsconfig.json'),
    write: false,
    logLevel: 'silent',
    // Removing only the token in memory reproduces the accepted release's DI gap.
    plugins: [{
      name: 'intake-injection-negative-control',
      setup(builder) {
        builder.onLoad({ filter: /alert-intake\.service\.ts$/ }, () => ({ contents: serviceSource, loader: 'ts' }))
      },
    }],
  })
  const child = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: backendRoot,
    input: compiled.outputFiles[0].text,
    encoding: 'utf8',
    env: {
      ...process.env,
      HAWKVIEW_ALERT_WATERMARK_ISO: '2026-09-16T23:30:00.000Z',
      HAWKVIEW_ALERT_READ_WINDOW_HOURS: '24',
      HAWKVIEW_ALERT_EMAIL_MODE: 'disabled',
    },
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout.trim())
}

test('production compiler/Nest negative control reproduces undefined intake Prisma dependency', { timeout: 45_000 }, async () => {
  assert.deepEqual(await runRuntimeProbe(true), {
    missingInjectionReproduced: true,
    outcome: 'FAILED',
    reads: 0,
    writes: 0,
    transactions: 0,
    adjacentEmailInjected: true,
    emailDisabled: true,
  })
})

test('production compiler/Nest injects Prisma into real intake/store and adjacent disabled email service', { timeout: 45_000 }, async () => {
  assert.deepEqual(await runRuntimeProbe(false), {
    missingInjectionReproduced: false,
    outcome: 'COMPLETED',
    reads: 1,
    writes: 0,
    transactions: 0,
    adjacentEmailInjected: true,
    emailDisabled: true,
  })
})
