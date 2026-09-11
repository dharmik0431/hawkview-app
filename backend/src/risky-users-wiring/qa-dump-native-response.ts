// QA: capture a REAL native assessment response from the shipped code path, so
// the frontend can be exercised against the contract it will actually receive
// rather than against a fixture someone authored from reading the type.
//
// Writes JSON to the path in QA_DUMP_TO. Synthetic tenant, disposable database,
// no production data.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { RiskyUsersController } from './risky-users.controller.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) })
const organizationId = randomUUID(), customerTenantId = randomUUID()
const microsoftTenantId = randomUUID()
const now = new Date()
const ago = (ms: number) => new Date(now.getTime() - ms)
const HOUR = 3600_000
const MODE = process.env.QA_MODE ?? 'positive'
const LOCKOUT = "The account is locked, you've tried to sign in too many times with an incorrect user ID or password."
const REJECT = 'Error validating credentials due to invalid username or password.'

// Four affected people, so the count is EXACT 4 — the figure PM flagged as the
// one whose scope must travel with it. Plus quiet users and excluded traffic so
// the coverage vector is not trivially empty.
const people = [
  { id: '11111111-1111-4111-8111-111111111111', upn: 'alice@fixture.invalid', name: 'Alice Fixture', lockouts: 6, rejects: 0 },
  { id: '22222222-2222-4222-8222-222222222222', upn: 'bruno@fixture.invalid', name: 'Bruno Fixture', lockouts: 0, rejects: 9 },
  { id: '33333333-3333-4333-8333-333333333333', upn: 'chen@fixture.invalid', name: 'Chen Fixture', lockouts: 2, rejects: 7 },
  { id: '44444444-4444-4444-8444-444444444444', upn: 'dara@fixture.invalid', name: 'Dara Fixture', lockouts: 1, rejects: 0 },
  { id: '55555555-5555-4555-8555-555555555555', upn: 'eve@fixture.invalid', name: 'Eve Fixture', lockouts: 0, rejects: 0 },
]

let seq = 0
const row = (userId: string, upn: string, code: number) => {
  const n = seq++
  const at = ago(HOUR + (n + 1) * 60_000)
  return {
    organizationId, customerTenantId, microsoftSignInId: `qa-dump-${n}`, eventDateTime: at,
    raw: {
      id: `qa-dump-${n}`, createdDateTime: at.toISOString(), userId, userPrincipalName: upn,
      appId: randomUUID(), ipAddress: '203.0.113.9', isInteractive: true,
      status: { errorCode: code, failureReason: code === 50053 ? LOCKOUT : code === 50126 ? REJECT : '' },
    },
    riskLevel: 'none', ingestedAt: ago(20 * 60_000), expiresAt: new Date(now.getTime() + 90 * 86_400_000),
  }
}

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA dump', slug: `qa-dump-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'Greentech-shaped fixture', status: 'ACTIVE' } })
  for (const p of people) {
    await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: p.id,
      displayName: p.name, userPrincipalName: p.upn, userType: 'Member',
      lastSeenAt: ago(24 * HOUR), updatedAt: ago(24 * HOUR) } })
  }
  await prisma.syncState.create({ data: { organizationId, customerTenantId, resourceType: 'SIGN_INS',
    status: 'IDLE', lastAttemptAt: ago(6 * 60_000), lastSuccessfulAt: ago(6 * 60_000), consecutiveFailures: 0 } })

  const rows =
    // ZERO: a genuinely quiet tenant. Successes only, nothing excluded, nothing
    // to find. The case that must reach a confident zero rather than a withhold.
    MODE === 'zero' ? people.flatMap(p => Array.from({ length: 6 }, () => row(p.id, p.upn, 0)))
    // UNAVAILABLE: every row correctly out of scope (50140, cited). Nothing
    // applied, so no claim is permitted and the count must not be a zero.
    : MODE === 'unavailable' ? people.flatMap(p => Array.from({ length: 6 }, () => row(p.id, p.upn, 50140)))
    // AT_LEAST: enough events that the evaluate budget truncates the window, so
    // every count is a floor.
    : MODE === 'atleast' ? people.flatMap(p => [
        ...Array.from({ length: 40 }, () => row(p.id, p.upn, 50053)),
        ...Array.from({ length: 40 }, () => row(p.id, p.upn, 50126)),
      ])
    : [
      ...people.flatMap(p => [
        ...Array.from({ length: p.lockouts }, () => row(p.id, p.upn, 50053)),
        ...Array.from({ length: p.rejects }, () => row(p.id, p.upn, 50126)),
      ]),
      ...people.flatMap(p => Array.from({ length: 3 }, () => row(p.id, p.upn, 0))),
      ...people.map(p => row(p.id, p.upn, 50140)),
    ]
  await prisma.signInLog.createMany({ data: rows })

  const persisted = await evaluateAndPersistTenant(prisma, { organizationId, customerTenantId },
    MODE === 'atleast' ? { now, maxEvents: 25 } : { now })

  const authorized = {
    authorizeRiskyUsersRead: async () => ({
      gate: null,
      tenant: { id: customerTenantId, organizationId, evidenceDetailAllowed: MODE !== 'unnamed' },
    }),
  }
  const controller = new RiskyUsersController(authorized as never, prisma as never)
  const response = await controller.assessment({ auth: { kind: 'qa-dump' } } as never, customerTenantId)

  const out = process.env.QA_DUMP_TO ?? 'qa-native-response.json'
  writeFileSync(out, JSON.stringify(response, null, 2))
  console.log(JSON.stringify({
    QA_DUMP: { mode: MODE, wroteTo: out, rowsFetched: persisted.rowsFetched, findings: persisted.findings },
  }))
} finally {
  await prisma.identityRiskEvaluationRun.deleteMany({ where: { customerTenantId } }).catch(() => {})
  await prisma.syncState.deleteMany({ where: { customerTenantId } })
  await prisma.signInLog.deleteMany({ where: { customerTenantId } })
  await prisma.directoryUser.deleteMany({ where: { customerTenantId } })
  await prisma.customerTenant.deleteMany({ where: { id: customerTenantId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
