import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssessmentProtectionLoader, loadAssessmentProtection } from './risk-assessment-protection-loader.js';

const ORG = '10000000-0000-4000-8000-000000000001', TENANT = '10000000-0000-4000-8000-000000000002';
const USER = '10000000-0000-4000-8000-000000000003', GROUP = '10000000-0000-4000-8000-000000000004', ROLE = '10000000-0000-4000-8000-000000000005';
const scope = { organizationId: ORG, customerTenantId: TENANT };
const NOW = new Date('2026-09-08T21:00:00.000Z');
const at = (hours: number): Date => new Date(NOW.getTime() + hours * 3600000);
const policy = (users = { includeUsers: ['All'] } as Record<string, unknown>) => ({ id: 'policy', displayName: 'Synthetic MFA policy', state: 'enabled', conditions: { users, applications: { includeApplications: ['All'] } }, grantControls: { operator: 'OR', builtInControls: ['mfa'] } });
const registration = () => ({ id: USER, isMfaRegistered: true, perUserMfaState: 'enforced', conditionalAccessContext: { membershipComplete: true, transitiveGroupIds: [GROUP], observedAt: NOW.toISOString() } });
function fixture() {
  const tenant: Record<string, unknown> = { ...scope, microsoftTenantId: '10000000-0000-4000-8000-000000000006', organizationStatus: 'ACTIVE', tenantStatus: 'ACTIVE', connectionStatus: 'CONNECTED',
    usersSyncStatus: 'SUCCEEDED', usersLastSuccessfulAt: NOW, usersLastAttemptAt: at(-0.1), usersUpdatedAt: NOW, usersGenerationValid: true };
  const users: Record<string, unknown>[] = [{ ...scope, microsoftUserId: USER, userType: 'Member', userGenerationValid: true, accountEnabled: false }];
  const snapshots = new Map<string, Record<string, unknown>>();
  const payloads: Record<string, unknown[]> = { CONDITIONAL_ACCESS: [policy()], AUTHENTICATION_STRENGTHS: [], AUTH_REGISTRATIONS: [registration()], DIRECTORY_ROLES: [{ principalId: GROUP, roleDefinition: { templateId: ROLE } }], SECURITY_DEFAULTS: [{ isEnabled: true }] };
  for (const [resourceType, payload] of Object.entries(payloads)) snapshots.set(resourceType, { ...scope, resourceType, observedAt: NOW, syncStatus: 'SUCCEEDED', lastSuccessfulAt: NOW, lastAttemptAt: at(-0.1), syncUpdatedAt: NOW, generationValid: true, shapeValid: true, capped: false, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), payload });
  const trace: { sql: string; values: unknown[] }[] = [];
  let transactions = 0;
  const read: Parameters<typeof createAssessmentProtectionLoader>[0] = async (_deadline, maximum, work) => {
    transactions += 1; assert.equal(maximum, 12000);
    const client = { query: async (sql: string, values: unknown[] = []) => {
      trace.push({ sql, values });
      if (sql.includes('protection:scope')) return { rows: [tenant] };
      if (sql.includes('protection:users')) return { rows: users };
      if (sql.includes('protection:snapshot')) return { rows: snapshots.has(String(values[2])) ? [snapshots.get(String(values[2]))] : [] };
      return { rows: [] };
    } };
    return work(client as unknown as Parameters<Parameters<typeof createAssessmentProtectionLoader>[0]>[2] extends (client: infer Client, ...args: never[]) => unknown ? Client : never, Date.now() + 12000);
  };
  const run = (ids: readonly string[] = [USER], selectedScope = scope, deadline = Date.now() + 15000) => createAssessmentProtectionLoader(read)(selectedScope, ids, NOW, deadline);
  return { tenant, users, snapshots, trace, run, transactions: () => transactions };
}

test('one bounded transaction returns independent scoped facts, including disabled current users', async () => {
  const f = fixture(); const output = await f.run(); const value = output.get(USER)!;
  assert.equal(f.transactions(), 1); assert.equal(output.size, 1);
  assert.equal(value.registration.state, 'REGISTERED'); assert.equal(value.securityDefaults.state, 'ENABLED'); assert.equal(value.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
  const queries = f.trace.filter(row => row.sql.includes('protection:'));
  assert.equal(queries.length, 7); assert.ok(queries.every(row => row.values[0] === ORG && row.values[1] === TENANT));
  const userQuery = queries.find(row => row.sql.includes('protection:users'))!;
  assert.ok(userQuery.sql.includes('deleted_at IS NULL')); assert.ok(!/account_enabled\s*=\s*true/i.test(userQuery.sql));
  assert.ok(userQuery.sql.includes('u.updated_at <= y.last_successful_at'));
});
test('SQL gates every snapshot payload by row and bytes before driver transfer', async () => {
  const f = fixture(); await f.run(); const snapshots = f.trace.filter(row => row.sql.includes('protection:snapshot'));
  assert.equal(snapshots.length, 5);
  for (const row of snapshots) {
    assert.ok(row.sql.includes('octet_length(candidate::text)<=$6::integer')); assert.ok(row.sql.includes('jsonb_array_length(candidate)<=$9::integer'));
    assert.ok(row.sql.includes('AS MATERIALIZED')); assert.ok(row.sql.includes("lower(row->>'id')=ANY($8::text[])"));
    assert.ok(row.sql.includes('s.updated_at <= y.last_successful_at'));
    assert.equal(row.values[5], 180000); assert.deepEqual(row.values[7], [USER]);
    assert.ok(!row.sql.includes('last_error_message'));
  }
});
test('GUID validation, deduplication and unique-user cap occur before reads', async () => {
  const f = fixture(); assert.equal((await f.run([USER, USER.toUpperCase()])).size, 1); assert.equal(f.transactions(), 1);
  assert.equal((await f.run(['not-a-guid'])).size, 0); assert.equal(f.transactions(), 1);
  const many = Array.from({ length: 101 }, (_, i) => `20000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  assert.equal((await f.run(many)).size, 0); assert.equal(f.transactions(), 1);
  assert.equal((await loadAssessmentProtection(scope, ['invalid'], NOW, Date.now() + 1000)).size, 0);
});
test('expired deadlines do not begin a read transaction', async () => {
  const f = fixture(); const value = (await f.run([USER], scope, Date.now() - 1)).get(USER)!;
  assert.equal(f.transactions(), 0); assert.equal(value.registration.state, 'UNKNOWN');
});
for (const field of ['organizationStatus', 'tenantStatus', 'connectionStatus']) test(`inactive ${field} cannot return protection facts`, async () => {
  const f = fixture(); f.tenant[field] = 'DISCONNECTED';
  assert.equal((await f.run()).get(USER)!.registration.state, 'UNKNOWN'); assert.equal(f.trace.filter(row => row.sql.includes('protection:')).length, 1);
});
for (const field of ['organizationId', 'customerTenantId']) test(`foreign ${field} is rejected`, async () => {
  const f = fixture(); f.users[0]![field] = '10000000-0000-4000-8000-000000000099';
  assert.equal((await f.run()).get(USER)!.registration.state, 'UNKNOWN');
});
for (const override of [{ usersSyncStatus: 'RUNNING' }, { usersLastSuccessfulAt: at(-27) }, { usersLastSuccessfulAt: at(1) }, { usersLastAttemptAt: at(1) }, { usersGenerationValid: false }]) test(`directory generation cannot be guessed ${JSON.stringify(override)}`, async () => {
  const f = fixture(); Object.assign(f.tenant, override);
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'UNKNOWN'); assert.equal(f.trace.filter(row => row.sql.includes('protection:')).length, 1);
});
test('absent or ambiguous directory rows remain unknown', async () => {
  const f = fixture(); f.users.push({ ...f.users[0] }); assert.equal((await f.run()).get(USER)!.registration.state, 'UNKNOWN');
  f.users.length = 0; assert.equal((await f.run()).get(USER)!.registration.state, 'UNKNOWN');
});
test('one oversized CA source does not erase independent registration/default facts', async () => {
  const f = fixture(); Object.assign(f.snapshots.get('CONDITIONAL_ACCESS')!, { payload: null, payloadBytes: 0, capped: true });
  const output = (await f.run()).get(USER)!;
  assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.equal(output.registration.state, 'REGISTERED'); assert.equal(output.securityDefaults.state, 'ENABLED');
});
for (const override of [{ syncStatus: 'FAILED' }, { generationValid: false }, { observedAt: at(1) }, { lastAttemptAt: at(1) }, { observedAt: at(-27) }]) test(`source generation independently gates CA ${JSON.stringify(override)}`, async () => {
  const f = fixture(); Object.assign(f.snapshots.get('CONDITIONAL_ACCESS')!, override);
  const output = (await f.run()).get(USER)!; assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.equal(output.registration.state, 'REGISTERED');
});
test('registration membership and active role template mapping reuse the original source shape', async () => {
  const f = fixture(); f.snapshots.get('CONDITIONAL_ACCESS')!.payload = [policy({ includeRoles: [ROLE] })];
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
  f.snapshots.get('DIRECTORY_ROLES')!.payload = [{ principalId: GROUP, roleDefinition: {} }];
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'UNKNOWN');
});
test('incomplete group closure cannot hide group-assigned role exclusions', async () => {
  const f = fixture(); f.snapshots.get('CONDITIONAL_ACCESS')!.payload = [policy({ includeUsers: ['All'], excludeRoles: [ROLE] })];
  const registrationRow = registration(); registrationRow.conditionalAccessContext.membershipComplete = false;
  f.snapshots.get('AUTH_REGISTRATIONS')!.payload = [registrationRow];
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'UNKNOWN');
  f.snapshots.get('CONDITIONAL_ACCESS')!.payload = [policy()];
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
});
test('stale membership timestamp is not refreshed by a newer registration snapshot', async () => {
  const f = fixture(); f.snapshots.get('CONDITIONAL_ACCESS')!.payload = [policy({ includeGroups: [GROUP] })];
  const registrationRow = registration(); registrationRow.conditionalAccessContext.observedAt = at(-27).toISOString();
  f.snapshots.get('AUTH_REGISTRATIONS')!.payload = [registrationRow];
  const output = (await f.run()).get(USER)!; assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.equal(output.registration.state, 'REGISTERED');
});
test('duplicate registration identity is unknown rather than last-write-wins', async () => {
  const f = fixture(); f.snapshots.get('AUTH_REGISTRATIONS')!.payload = [registration(), { ...registration(), isMfaRegistered: false }];
  assert.equal((await f.run()).get(USER)!.registration.state, 'UNKNOWN');
});
test('security defaults require one actual singleton row and exact boolean', async () => {
  const f = fixture(); f.snapshots.get('SECURITY_DEFAULTS')!.payload = [{ isEnabled: 'true' }];
  assert.equal((await f.run()).get(USER)!.securityDefaults.state, 'UNKNOWN');
  f.snapshots.get('SECURITY_DEFAULTS')!.payload = [];
  assert.equal((await f.run()).get(USER)!.securityDefaults.state, 'UNKNOWN');
});
test('transaction failures expose no raw provider or database errors', async () => {
  const read: Parameters<typeof createAssessmentProtectionLoader>[0] = async () => { throw new Error('private-database-detail'); };
  const output = await createAssessmentProtectionLoader(read)(scope, [USER], NOW, Date.now() + 15000);
  assert.equal(output.get(USER)!.registration.state, 'UNKNOWN'); assert.ok(!JSON.stringify([...output]).includes('private-database-detail'));
});
test('stale membership cannot make a hidden role exclusion appear safely absent', async () => {
  const f = fixture(); f.snapshots.get('CONDITIONAL_ACCESS')!.payload = [policy({ includeUsers: ['All'], excludeRoles: [ROLE] })];
  const row = registration(); row.conditionalAccessContext.transitiveGroupIds = [];
  row.conditionalAccessContext.observedAt = at(-27).toISOString();
  f.snapshots.get('AUTH_REGISTRATIONS')!.payload = [row];
  const output = (await f.run()).get(USER)!;
  assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.equal(output.conditionalAccess.freshness, 'STALE');
  assert.equal(output.registration.state, 'REGISTERED');
});
test('derived roles inherit membership observation at the exact 26-hour boundary', async () => {
  const f = fixture(); f.snapshots.get('CONDITIONAL_ACCESS')!.payload = [policy({ includeUsers: ['All'], excludeRoles: [ROLE] })];
  const row = registration(); row.conditionalAccessContext.transitiveGroupIds = [];
  row.conditionalAccessContext.observedAt = at(-26).toISOString(); f.snapshots.get('AUTH_REGISTRATIONS')!.payload = [row];
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
  row.conditionalAccessContext.observedAt = new Date(at(-26).getTime() - 1).toISOString();
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'UNKNOWN');
  row.conditionalAccessContext.observedAt = '2026-02-30T12:00:00Z';
  assert.equal((await f.run()).get(USER)!.conditionalAccess.status, 'UNKNOWN');
});
