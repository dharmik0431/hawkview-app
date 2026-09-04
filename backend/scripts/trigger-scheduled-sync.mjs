import { runScheduledSync, summarizeScheduledSyncResult } from './scheduled-sync-trigger.mjs'

const result = await runScheduledSync({
  targetUrl: process.env.SCHEDULER_TARGET_URL?.trim() || 'https://api.hawkviewapp.com/api/internal/sync/due-tenants',
  sharedSecret: process.env.SCHEDULER_SHARED_SECRET?.trim() ?? '',
})
console.log('Scheduled synchronization completed.', summarizeScheduledSyncResult(result))
