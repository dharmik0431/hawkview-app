// QA — THE THIRD STRANDING INSTANCE, registered before the fix exists.
//
// An incident is a PROJECTION over `notifications` — the set of rows sharing an incident_key —
// stated by its own migration, with no foreign key in either direction. So an incident with no
// matching notification rows projects over the EMPTY SET: invisible in the bell, absent from the
// unread count, and with nothing for read or dismiss to act on.
//
// THIS FILE MUST FAIL AGAINST HEAD. If it passes today it is not testing the fix — every
// incident is currently in exactly the state P1 forbids.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 }) })
const service = new AlertIntakeService(prisma as never)
process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const q = async <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)
const count = async (sql: string) => Number((await q<{ n: number }>(sql))[0]!.n)

const report = await service.runOnce(Date.now() + 30_000, new Date())

// P1 — NO INCIDENT PROJECTS OVER THE EMPTY SET.
const orphanIncidents = await q<{ incident_key: string }>(`
  SELECT i.incident_key FROM alert_incidents i
   WHERE NOT EXISTS (SELECT 1 FROM notifications n
                      WHERE n.organization_id = i.organization_id
                        AND n.incident_key = i.incident_key)`)

// P2 — THE ASYMMETRIC ONE. A job exists, so an email may go; but the incident is invisible
// in-app. The MSP is emailed about something absent from their alerts view, which is worse than
// either failure alone because it destroys confidence in the view as a record.
const loudButInvisible = await q<{ message_id: string }>(`
  SELECT j.message_id FROM alert_send_jobs j
    JOIN alert_incidents i
      ON j.message_id = 'incident/' || i.organization_id || '|' || i.incident_key
   WHERE NOT EXISTS (SELECT 1 FROM notifications n
                      WHERE n.organization_id = i.organization_id
                        AND n.incident_key = i.incident_key)`)

// P3 — THE REVERSE. A keyed notification with no incident to hold its state: visible in the bell
// with nothing owning acknowledgement or condition.
const notificationsWithoutIncident = await q<{ incident_key: string }>(`
  SELECT n.incident_key FROM notifications n
   WHERE n.incident_key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM alert_incidents i
                      WHERE i.organization_id = n.organization_id
                        AND i.incident_key = n.incident_key)`)

const incidents = await count('SELECT count(*)::int AS n FROM alert_incidents')
const jobs = await count('SELECT count(*)::int AS n FROM alert_send_jobs')
const keyed = await count('SELECT count(*)::int AS n FROM notifications WHERE incident_key IS NOT NULL')

const p1 = orphanIncidents.length === 0
const p2 = loudButInvisible.length === 0
const p3 = notificationsWithoutIncident.length === 0
console.log(JSON.stringify({
  QA_PROJECTION: {
    wrote: { incidents: report?.incidentsWritten, jobs: report?.jobsWritten },
    inTheDatabase: { incidents, jobs, keyedNotifications: keyed },
    P1_noIncidentProjectsOverTheEmptySet: {
      offending: orphanIncidents.map((x) => x.incident_key.slice(0, 40)), pass: p1,
      means: 'an incident with no notification rows is invisible in the bell, absent from the '
        + 'unread count, and has nothing for read or dismiss to act on',
    },
    P2_neverSilentInOneChannelAndLoudInTheOther: {
      offending: loudButInvisible.map((x) => x.message_id.slice(0, 48)), pass: p2,
      means: 'a send job exists so an email may go, while the incident is absent from the alerts '
        + 'view - the MSP is told about something their view says never happened',
    },
    P3_noKeyedNotificationWithoutItsIncident: { offending: notificationsWithoutIncident.length, pass: p3 },
    verdict: p1 && p2 && p3
      ? 'ALL THREE HOLD'
      : 'FAILS — and against HEAD it MUST fail, or it is not testing the fix',
  },
}, null, 2))
await prisma.$disconnect()
