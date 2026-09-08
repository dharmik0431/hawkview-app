import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const controllerPath = resolve(backendRoot, 'src/identity-risk/identity-risk.controller.ts')

// Compile the real controller, service and guard with the production bundler,
// ESM format and tsconfig. No TypeScript decorator-metadata emitter is involved.
// Only the database and external token verifier are synthetic providers. The
// HTTP assertions exercise real Nest routing, DI, auth guard and service scope.
async function runRuntimeProbe(removeInjection) {
  const source = readFileSync(controllerPath, 'utf8')
  assert.match(source, /@Inject\(IdentityRiskService\)/)
  const controllerSource = removeInjection
    ? source.replace('@Inject(IdentityRiskService)', '')
    : source
  const harness = `
    import 'reflect-metadata';
    import assert from 'node:assert/strict';
    import { Module, UnauthorizedException } from '@nestjs/common';
    import { APP_GUARD, NestFactory } from '@nestjs/core';
    import { IdentityRiskController } from './src/identity-risk/identity-risk.controller.ts';
    import { IdentityRiskService } from './src/identity-risk/identity-risk.service.ts';
    import { RiskAssessmentReader } from './src/identity-risk/risk-assessment-reader.service.ts';
    import { RiskAssessmentProjector } from './src/identity-risk/risk-assessment-projector.service.ts';
    import { MailboxRiskProjector } from './src/identity-risk/mailbox-risk-projector.service.ts';
    import { IdentityRiskPseudonymProvider } from './src/identity-risk/identity-risk-pseudonym.ts';
    import { IdentityAuthGuard } from './src/auth/identity-auth.guard.ts';
    import { IdentityTokenVerifier } from './src/auth/identity-token-verifier.service.ts';
    import { PrismaService } from './src/prisma/prisma.service.ts';

    const organizationId = '11111111-1111-4111-8111-111111111111';
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const foreignTenantId = '33333333-3333-4333-8333-333333333333';
    const identity = { subject: 'synthetic-owner', email: 'owner@example.invalid', assuranceLevel: 'aal2' };
    let scopeReads = 0;
    let riskReads = 0;
    const database = {
      user: { findUnique: async (args) => {
        scopeReads++;
        assert.deepEqual(args.where, { authProviderUserId: identity.subject });
        assert.deepEqual(args.select.memberships.where, {
          status: 'ACTIVE', organization: { status: 'ACTIVE' },
        });
        return { disabledAt: null, memberships: [{ organizationId, role: 'MSP_OWNER' }] };
      } },
      customerTenant: { findFirst: async (args) => {
        assert.deepEqual(args.where.organizationId, { in: [organizationId] });
        return args.where.id === tenantId ? { id: tenantId, organizationId } : null;
      } },
      identityRiskOperationalControl: { findMany: async () => { riskReads++; return []; } },
      $executeRawUnsafe: async (sql) => {
        assert.equal(sql, "SET LOCAL TIME ZONE 'UTC'");
        return 0;
      },
      $queryRawUnsafe: async (sql, ...args) => {
        if (sql === "SELECT current_setting('TimeZone') AS timezone") return [{ timezone: 'UTC' }];
        assert.match(sql, /FROM identity_risk_attempt_heads/);
        assert.deepEqual(args, [organizationId, tenantId, 'test']);
        riskReads++;
        return []; // No attempt head/completed run: not evaluated, never clean.
      },
    };
    database.$transaction = async (read) => read(database);
    class ProbeModule {}
    Module({
      controllers: [IdentityRiskController],
      providers: [
        IdentityRiskService,
        RiskAssessmentReader, RiskAssessmentProjector, MailboxRiskProjector,
        { provide: IdentityRiskPseudonymProvider, useValue: { configured: false, allowsScope: () => false } },
        { provide: PrismaService, useValue: database },
        { provide: IdentityTokenVerifier, useValue: {
          verify: async (token) => {
            if (token === 'synthetic-valid') return identity;
            if (token === 'synthetic-aal1') return { ...identity, assuranceLevel: 'aal1' };
            throw new UnauthorizedException('Invalid synthetic token');
          },
        } },
        { provide: APP_GUARD, useClass: IdentityAuthGuard },
      ],
    })(ProbeModule);
    const app = await NestFactory.create(ProbeModule, { logger: false });
    try {
      await app.init();
      const controller = app.get(IdentityRiskController);
      assert.equal(Reflect.getMetadata('design:paramtypes', IdentityRiskController), undefined);
      if (${removeInjection}) {
        assert.equal(controller.service, undefined);
        for (const method of ['summary', 'findings', 'riskyUsers']) {
          assert.throws(() => controller[method]({ auth: identity }, tenantId), TypeError);
        }
        assert.equal(scopeReads, 0);
        console.log(JSON.stringify({ missingInjectionReproduced: true, failingMethods: 3 }));
      } else {
        assert.equal(controller.service, app.get(IdentityRiskService));
        assert.equal(app.get(IdentityRiskService).assessmentReader, app.get(RiskAssessmentReader));
        assert.equal(app.get(RiskAssessmentProjector).mailbox, app.get(MailboxRiskProjector));
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        const routes = ['identity-signals/summary', 'identity-signals/findings', 'microsoft-entra-risky-users', 'identity-signals/assessment'];
        const results = [];
        for (const route of routes) {
          const url = base + '/api/tenants/' + tenantId + '/' + route;
          const response = await fetch(url, { headers: { Authorization: 'Bearer synthetic-valid' } });
          assert.equal(response.status, 200);
          assert.match(response.headers.get('content-type'), /^application\\/json/);
          const payload = await response.json();
          const body = route.endsWith('/assessment') ? payload.meta : payload;
          if (route.endsWith('/assessment')) {
            assert.equal(payload.schemaVersion, 'hawkview-risk-assessment/v1');
            assert.deepEqual(payload.users, []);
            assert.equal(payload.rules.length, 3);
            assert.match(response.headers.get('cache-control'), /no-store/);
          }
          assert.equal(body.version, 1);
          assert.equal(body.capability, 'UNAVAILABLE');
          assert.equal(body.freshness, 'UNKNOWN');
          assert.equal(body.evaluatedAt, null);
          assert.equal(body.observedAt, null);
          assert.equal(body.channel, route === 'microsoft-entra-risky-users'
            ? 'MICROSOFT_ENTRA_RISKY_USERS' : 'HAWKVIEW_IDENTITY_SIGNALS');
          assert.equal(body.status, route === 'microsoft-entra-risky-users' ? 'UNAVAILABLE' : 'NOT_EVALUATED');
          if (route.endsWith('/summary')) {
            for (const count of Object.values(body.counts)) assert.deepEqual(count, { value: 0, exact: false, capped: false });
          } else if (!route.endsWith('/assessment')) {
            assert.deepEqual(body.pageInfo, { hasMore: false, nextCursor: null });
            assert.deepEqual(route.endsWith('/findings') ? body.findings : body.users, []);
          }
          const readsBeforeDenial = { scopeReads, riskReads };
          for (const headers of [{}, { Authorization: 'Bearer synthetic-invalid' }, { Authorization: 'Bearer synthetic-aal1' }]) {
            const denied = await fetch(url, { headers });
            assert.equal(denied.status, headers.Authorization === 'Bearer synthetic-aal1' ? 403 : 401);
            await denied.arrayBuffer();
          }
          assert.deepEqual({ scopeReads, riskReads }, readsBeforeDenial);
          const foreign = await fetch(base + '/api/tenants/' + foreignTenantId + '/' + route,
            { headers: { Authorization: 'Bearer synthetic-valid' } });
          assert.equal(foreign.status, 403);
          await foreign.arrayBuffer();
          assert.equal(riskReads, readsBeforeDenial.riskReads);
          results.push({ route, authorized: 200, unauthenticated: 401, invalidToken: 401, insufficientAssurance: 403, crossOrganization: 403, status: body.status });
        }
        console.log(JSON.stringify({ serviceInjected: true, results }));
      }
    } finally { await app.close(); }
  `
  const compiled = await build({
    stdin: { contents: harness, resolveDir: backendRoot, sourcefile: 'identity-risk-runtime-probe.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    tsconfig: resolve(backendRoot, 'tsconfig.json'),
    write: false,
    logLevel: 'silent',
    // Both variants load the real source; the negative control removes only
    // the annotation in memory, without editing source or a build artifact.
    plugins: [{
      name: 'controller-negative-control',
      setup(build) {
        build.onLoad({ filter: /identity-risk\.controller\.ts$/ }, () => ({ contents: controllerSource, loader: 'ts' }))
      },
    }],
  })
  const environment = {
    ...process.env,
    HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
    HAWKVIEW_IDENTITY_RISK_MODE: 'shadow',
    HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1',
    HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'test',
    HAWKVIEW_MICROSOFT_RISK_DISPLAY_ENABLED: 'false',
    HAWKVIEW_CANARY_ENABLED: 'false',
  }
  delete environment.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
  const child = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: backendRoot,
    input: compiled.outputFiles[0].text,
    encoding: 'utf8',
    env: environment,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout.trim())
}

test('production esbuild negative control reproduces missing controller injection', { timeout: 45_000 }, async () => {
  assert.deepEqual(await runRuntimeProbe(true), { missingInjectionReproduced: true, failingMethods: 3 })
})

test('production esbuild Nest DI serves guarded identity-risk HTTP envelopes with isolated scope', { timeout: 45_000 }, async () => {
  const result = await runRuntimeProbe(false)
  assert.equal(result.serviceInjected, true)
  assert.equal(result.results.length, 4)
  assert.deepEqual(result.results.map((entry) => entry.status), ['NOT_EVALUATED', 'NOT_EVALUATED', 'UNAVAILABLE', 'NOT_EVALUATED'])
})
