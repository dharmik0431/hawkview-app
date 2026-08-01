import { Resolver } from 'node:dns/promises'

export type DnsRecordStatus = 'healthy' | 'warning'

export interface DomainDnsHealthResult {
  domain: string
  spf: { record: string; status: DnsRecordStatus }
  dkim: { record: string; status: DnsRecordStatus }
  dmarc: { record: string; status: DnsRecordStatus }
  blacklist: { record: 'Not checked'; status: 'not_checked' }
  checkedAt: string
}

async function resolveWithTimeout<T>(
  lookup: (resolver: Resolver) => Promise<T>
): Promise<T | null> {
  const resolver = new Resolver()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      lookup(resolver),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          resolver.cancel()
          reject(new Error('DNS query timed out'))
        }, 5_000)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function flattenTxt(records: string[][] | null) {
  return (records ?? []).map((chunks) => chunks.join(''))
}

export async function resolveDomainDnsHealth(
  domain: string
): Promise<DomainDnsHealthResult> {
  const normalized = domain.trim().toLowerCase()
  const [rootTxt, dmarcTxt, selector1, selector2] = await Promise.all([
    resolveWithTimeout((resolver) => resolver.resolveTxt(normalized)),
    resolveWithTimeout((resolver) =>
      resolver.resolveTxt(`_dmarc.${normalized}`)
    ),
    resolveWithTimeout((resolver) =>
      resolver.resolveCname(`selector1._domainkey.${normalized}`)
    ),
    resolveWithTimeout((resolver) =>
      resolver.resolveCname(`selector2._domainkey.${normalized}`)
    ),
  ])
  const spfRecord = flattenTxt(rootTxt).find((record) =>
    /^v=spf1(?:\s|$)/i.test(record)
  )
  const dmarcRecord = flattenTxt(dmarcTxt).find((record) =>
    /^v=dmarc1(?:;|\s|$)/i.test(record)
  )
  const dkimTargets = [
    ...(selector1 ?? []).map((target) => `selector1: ${target}`),
    ...(selector2 ?? []).map((target) => `selector2: ${target}`),
  ]
  const hasEnforcingDmarc = dmarcRecord
    ? /(?:^|;)\s*p\s*=\s*(quarantine|reject)\s*(?:;|$)/i.test(dmarcRecord)
    : false

  return {
    domain: normalized,
    spf: spfRecord
      ? { record: spfRecord, status: 'healthy' }
      : { record: 'No SPF record found', status: 'warning' },
    dkim:
      dkimTargets.length === 2
        ? { record: dkimTargets.join(', '), status: 'healthy' }
        : {
            record:
              dkimTargets.length === 1
                ? `${dkimTargets[0]} (other selector missing)`
                : 'No Microsoft 365 DKIM selector CNAMEs found',
            status: 'warning',
          },
    dmarc: dmarcRecord
      ? { record: dmarcRecord, status: hasEnforcingDmarc ? 'healthy' : 'warning' }
      : { record: 'No DMARC record found', status: 'warning' },
    blacklist: { record: 'Not checked', status: 'not_checked' },
    checkedAt: new Date().toISOString(),
  }
}
