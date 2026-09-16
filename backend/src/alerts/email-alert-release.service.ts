import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { emailSqlRunner } from './email-sql-runner.js'
import { EmailReleaseStore } from './email-release-store.js'
import { runEmailRelease, type EmailRunReport } from './email-release.js'

@Injectable()
export class EmailAlertReleaseService {
  private readonly logger = new Logger(EmailAlertReleaseService.name)
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async runOnce(deadlineAt: number): Promise<EmailRunReport> {
    const boundedDeadline = Math.min(deadlineAt, Date.now() + 25_000)
    const report = await runEmailRelease({
      store: new EmailReleaseStore(emailSqlRunner(this.prisma, boundedDeadline)),
      env: process.env, fetchImpl: fetch, deadlineAt: boundedDeadline,
    })
    this.logger.log(JSON.stringify({ event: 'email_alert_release', ...report }))
    return report
  }
}
