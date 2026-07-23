import dns from 'node:dns/promises'

export interface DnsCheckRecord {
  record: string
  status: 'healthy' | 'warning'
}

export interface DomainDnsHealth {
  domain: string
  spf: DnsCheckRecord
  dkim: DnsCheckRecord
  dmarc: DnsCheckRecord
  blacklist: {
    record: string
    status: 'not_checked'
  }
}

interface CacheEntry {
  data: DomainDnsHealth
  expiresAt: number
}

const dnsCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function withDnsTimeout<T>(promise: Promise<T>, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS query timeout')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}

export async function checkDomainDnsHealth(
  domain: string,
  forceRefresh = false
): Promise<DomainDnsHealth> {
  const normalized = (domain || '').trim().toLowerCase()
  if (!normalized || normalized === 'unknown') {
    return {
      domain: 'unknown',
      spf: { record: 'No domain specified', status: 'warning' },
      dkim: { record: 'No domain specified', status: 'warning' },
      dmarc: { record: 'No domain specified', status: 'warning' },
      blacklist: { record: 'Not checked', status: 'not_checked' },
    }
  }

  if (!forceRefresh) {
    const cached = dnsCache.get(normalized)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data
    }
  }

  // Perform parallel server-side DNS queries
  const [spfResult, dmarcResult, selector1Result, selector2Result] =
    await Promise.allSettled([
      // 1. Root domain TXT for SPF
      withDnsTimeout(dns.resolveTxt(normalized)),
      // 2. _dmarc.domain TXT for DMARC
      withDnsTimeout(dns.resolveTxt(`_dmarc.${normalized}`)),
      // 3. selector1._domainkey.domain CNAME
      withDnsTimeout(dns.resolveCname(`selector1._domainkey.${normalized}`)),
      // 4. selector2._domainkey.domain CNAME
      withDnsTimeout(dns.resolveCname(`selector2._domainkey.${normalized}`)),
    ])

  // --- SPF ---
  let spf: DnsCheckRecord = { record: 'No SPF record found', status: 'warning' }
  if (spfResult.status === 'fulfilled' && Array.isArray(spfResult.value)) {
    const txtStrings = spfResult.value.map((chunks) => chunks.join(''))
    const spfMatch = txtStrings.find((t) =>
      t.toLowerCase().startsWith('v=spf1')
    )
    if (spfMatch) {
      spf = { record: spfMatch, status: 'healthy' }
    }
  }

  // --- DMARC ---
  let dmarc: DnsCheckRecord = {
    record: 'No DMARC record found',
    status: 'warning',
  }
  if (dmarcResult.status === 'fulfilled' && Array.isArray(dmarcResult.value)) {
    const txtStrings = dmarcResult.value.map((chunks) => chunks.join(''))
    const dmarcMatch = txtStrings.find((t) =>
      t.toLowerCase().startsWith('v=dmarc1')
    )
    if (dmarcMatch) {
      const lowerMatch = dmarcMatch.toLowerCase()
      // Check policy: p=quarantine or p=reject -> healthy; p=none or missing -> warning
      const isHealthyPolicy =
        lowerMatch.includes('p=quarantine') || lowerMatch.includes('p=reject')
      dmarc = {
        record: dmarcMatch,
        status: isHealthyPolicy ? 'healthy' : 'warning',
      }
    }
  }

  // --- DKIM ---
  let dkim: DnsCheckRecord = {
    record: 'DKIM selector CNAME record missing or unverified',
    status: 'warning',
  }
  const sel1Ok =
    selector1Result.status === 'fulfilled' &&
    Array.isArray(selector1Result.value) &&
    selector1Result.value.length > 0
  const sel2Ok =
    selector2Result.status === 'fulfilled' &&
    Array.isArray(selector2Result.value) &&
    selector2Result.value.length > 0

  if (sel1Ok && sel2Ok) {
    const target1 = selector1Result.value[0]
    const target2 = selector2Result.value[0]
    dkim = {
      record: `selector1: ${target1}, selector2: ${target2}`,
      status: 'healthy',
    }
  } else if (sel1Ok) {
    const target1 = selector1Result.value[0]
    dkim = {
      record: `selector1: ${target1} (selector2 missing)`,
      status: 'warning',
    }
  }

  const result: DomainDnsHealth = {
    domain: normalized,
    spf,
    dkim,
    dmarc,
    blacklist: {
      record: 'Not checked',
      status: 'not_checked',
    },
  }

  dnsCache.set(normalized, {
    data: result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })

  return result
}
