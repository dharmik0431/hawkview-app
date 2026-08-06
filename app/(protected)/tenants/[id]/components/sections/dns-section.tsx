'use client'

import { useState, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  ShieldCheck,
  Globe,
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Copy,
  Check,
  X,
  Loader2,
  ArrowUpRight,
} from 'lucide-react'

type CheckStatus = 'healthy' | 'warning' | 'failed' | 'not-synced' | 'checking'

interface DnsCheckItem {
  id: 'spf' | 'dkim' | 'dmarc'
  title: string
  description: string
  record: string
  status: CheckStatus
  diagnosticText: string
  resultSummary: string
  howToFix?: string
}

export default function DnsSection({
  tenant,
  domains = [],
  dns,
}: {
  tenant: any
  domains: string[]
  dns: any
}) {
  const [domainOpen, setDomainOpen] = useState(false)
  const [domainSelected, setDomainSelected] = useState<string>('')
  const [selectedCheck, setSelectedCheck] = useState<DnsCheckItem | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const domainList = useMemo(() => {
    if (Array.isArray(domains) && domains.length > 0) return domains
    if (tenant?.domain) return [tenant.domain]
    return []
  }, [domains, tenant?.domain])

  const activeDomain = domainSelected || domainList[0] || tenant?.domain || '—'

  // Get active DNS object (either byDomain or direct object)
  const activeDns = useMemo(() => {
    if (!dns) return null
    if (dns.byDomain && typeof dns.byDomain === 'object') {
      const key = String(activeDomain || '').toLowerCase()
      return dns.byDomain[key] || dns.byDomain[activeDomain] || dns
    }
    return dns
  }, [dns, activeDomain])

  const lastCheckedText = useMemo(() => {
    if (activeDns?.lastChecked) {
      try {
        const d = new Date(activeDns.lastChecked)
        if (!isNaN(d.getTime())) {
          return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(d)
        }
      } catch {
        // ignore
      }
    }
    return 'Synchronized'
  }, [activeDns])

  // Parse SPF, DKIM, DMARC check items
  const checks = useMemo<DnsCheckItem[]>(() => {
    function parseItem(
      id: 'spf' | 'dkim' | 'dmarc',
      title: string,
      description: string,
      rawVal: any,
      defaultFix: string,
      defaultWarningText: string
    ): DnsCheckItem {
      if (!rawVal) {
        return {
          id,
          title,
          description,
          record: '',
          status: 'not-synced',
          diagnosticText: 'Awaiting collection',
          resultSummary: 'Awaiting collection',
          howToFix: defaultFix,
        }
      }

      if (typeof rawVal === 'object') {
        const rec = String(rawVal.record || rawVal.value || '').trim()
        const st: CheckStatus = rawVal.status || 'not-synced'
        const diag =
          rawVal.message ||
          rec ||
          (st === 'healthy'
            ? 'Record configured correctly'
            : 'Awaiting collection')

        let summary = diag
        if (st === 'healthy') {
          summary = 'Record configured correctly.'
        } else if (st === 'warning' || st === 'failed') {
          summary = diag || defaultWarningText
        }

        return {
          id,
          title,
          description,
          record: rec,
          status: st,
          diagnosticText: diag,
          resultSummary: summary,
          howToFix: rawVal.howToFix || defaultFix,
        }
      }

      const str = String(rawVal).trim()
      if (
        !str ||
        str === '—' ||
        str.toLowerCase() === 'awaiting collection' ||
        str.toLowerCase() === 'not synchronized' ||
        str.toLowerCase() === 'not synced'
      ) {
        return {
          id,
          title,
          description,
          record: '',
          status: 'not-synced',
          diagnosticText: 'Awaiting collection',
          resultSummary: 'Awaiting collection',
          howToFix: defaultFix,
        }
      }

      const lower = str.toLowerCase()
      if (
        lower.startsWith('no ') ||
        lower.includes('not found') ||
        lower.includes('missing') ||
        lower.includes('error')
      ) {
        let summary = str
        if (id === 'dkim' && lower.includes('cname')) {
          summary = 'Microsoft 365 selector CNAMEs not found.'
        } else if (id === 'dmarc' && lower.includes('dmarc')) {
          summary = 'DMARC record not found.'
        } else if (id === 'spf' && lower.includes('spf')) {
          summary = 'SPF record missing or invalid.'
        }

        return {
          id,
          title,
          description,
          record: str,
          status: 'warning',
          diagnosticText: str,
          resultSummary: summary,
          howToFix: defaultFix,
        }
      }

      return {
        id,
        title,
        description,
        record: str,
        status: 'healthy',
        diagnosticText: str,
        resultSummary: 'Record configured correctly.',
        howToFix: defaultFix,
      }
    }

    return [
      parseItem(
        'spf',
        'SPF',
        'Sender Policy Framework specifies which mail servers are permitted to send email on behalf of your domain.',
        activeDns?.spf,
        'Add a TXT record for "@" with value "v=spf1 include:spf.protection.outlook.com -all" in your domain DNS control panel.',
        'SPF record missing or invalid.'
      ),
      parseItem(
        'dkim',
        'DKIM',
        'DomainKeys Identified Mail adds a cryptographic signature to outgoing messages to verify domain authenticity.',
        activeDns?.dkim,
        'Publish CNAME records selector1._domainkey and selector2._domainkey in your domain DNS and enable DKIM signing in Microsoft 365 Defender.',
        'Microsoft 365 selector CNAMEs not found.'
      ),
      parseItem(
        'dmarc',
        'DMARC',
        'Domain-based Message Authentication, Reporting & Conformance uses SPF and DKIM to determine email authenticity.',
        activeDns?.dmarc,
        'Create a TXT record for "_dmarc" with value "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com" in your DNS control panel.',
        'DMARC record not found.'
      ),
    ]
  }, [activeDns])

  // Determine Overall Domain Status
  const overallStatus = useMemo(() => {
    const hasSync = checks.some((c) => c.status !== 'not-synced')
    if (!hasSync)
      return {
        label: 'Awaiting collection',
        style:
          'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
      }
    const hasWarning = checks.some(
      (c) => c.status === 'warning' || c.status === 'failed'
    )
    if (hasWarning)
      return {
        label: 'Needs attention',
        style:
          'bg-amber-50 text-amber-700 border-amber-200/80 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800',
      }
    return {
      label: 'Protected',
      style:
        'bg-emerald-50 text-emerald-700 border-emerald-200/80 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800',
    }
  }, [checks])

  function isRecordCopyable(record: string): boolean {
    if (!record) return false
    const trimmed = record.trim()
    if (!trimmed || trimmed === '—') return false
    const lower = trimmed.toLowerCase()
    if (
      lower.startsWith('no ') ||
      lower.includes('not found') ||
      lower.includes('awaiting collection') ||
      lower.includes('not synced') ||
      lower.includes('missing') ||
      lower.includes('check failed') ||
      lower.includes('error')
    ) {
      return false
    }
    return true
  }

  async function handleCopy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1200)
    } catch {
      // ignore
    }
  }

  return (
    <>
      <Card className="rounded-2xl shadow-xs border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 w-full">
        <CardContent className="p-6">
          {/* Card Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200/60 dark:border-indigo-900/50 flex items-center justify-center shrink-0">
                <ShieldCheck className="h-4.5 w-4.5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    Email & Domain Protection
                  </h2>
                  <Badge
                    className={`text-[11px] font-bold px-2 py-0.5 border ${overallStatus.style}`}
                  >
                    {overallStatus.label}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Monitor SPF, DKIM and DMARC configuration for this domain.
                </p>
              </div>
            </div>

            {/* Domain Selector Dropdown */}
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setDomainOpen((v) => !v)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition shadow-xs"
                title="Select active domain"
                aria-label="Select active domain"
              >
                <Globe className="h-3.5 w-3.5 text-slate-500" />
                <span className="truncate max-w-[160px]">{activeDomain}</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {domainOpen && domainList.length > 0 && (
                <div className="absolute right-0 mt-2 w-[220px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden z-20">
                  <div className="px-3 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                    Select Domain
                  </div>
                  <div className="max-h-[200px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                    {domainList.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => {
                          setDomainSelected(d)
                          setDomainOpen(false)
                        }}
                        className={`w-full text-left px-3.5 py-2 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between ${
                          d === activeDomain
                            ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 font-semibold'
                            : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <span className="truncate">{d}</span>
                        {d === activeDomain && (
                          <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Clean Data Table Rows (Desktop) & List Rows (Mobile) */}
          <div className="mt-5 border-t border-slate-100 dark:border-slate-800">
            {/* Desktop Table Header */}
            <div className="hidden md:grid grid-cols-12 gap-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800">
              <div className="col-span-2">Check</div>
              <div className="col-span-2">Status</div>
              <div className="col-span-5">Current Result</div>
              <div className="col-span-2">Last Checked</div>
              <div className="col-span-1 text-right">Action</div>
            </div>

            {/* Table / List Rows */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {checks.map((check) => {
                const isWarningOrFailed =
                  check.status === 'warning' || check.status === 'failed'
                const actionLabel = isWarningOrFailed
                  ? 'Fix configuration'
                  : 'View details'

                return (
                  <div
                    key={check.id}
                    className="py-3.5 flex flex-col md:grid md:grid-cols-12 gap-2 md:gap-3 items-start md:items-center text-xs hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors"
                  >
                    {/* Check Name */}
                    <div className="col-span-2 flex items-center justify-between md:justify-start w-full md:w-auto font-bold text-slate-900 dark:text-slate-100">
                      <div className="flex items-center gap-2">
                        {check.status === 'healthy' && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        )}
                        {check.status === 'warning' && (
                          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        )}
                        {check.status === 'failed' && (
                          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
                        )}
                        {check.status === 'not-synced' && (
                          <HelpCircle className="h-4 w-4 text-slate-400 shrink-0" />
                        )}
                        {check.status === 'checking' && (
                          <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" />
                        )}
                        <span>{check.title}</span>
                      </div>

                      {/* Mobile Only Status Badge */}
                      <div className="md:hidden">
                        <Badge
                          className={`text-[10px] font-bold px-2 py-0.5 border uppercase ${
                            check.status === 'healthy'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800'
                              : check.status === 'warning'
                                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800'
                                : check.status === 'failed'
                                  ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800'
                                  : check.status === 'checking'
                                    ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800'
                                    : 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                          }`}
                        >
                          {check.status === 'healthy'
                            ? 'Healthy'
                            : check.status === 'warning'
                              ? 'Warning'
                              : check.status === 'failed'
                                ? 'Failed'
                                : check.status === 'checking'
                                  ? 'Checking'
                                  : 'Collection pending'}
                        </Badge>
                      </div>
                    </div>

                    {/* Desktop Status Badge */}
                    <div className="hidden md:flex col-span-2 items-center">
                      <Badge
                        className={`text-[10px] font-bold px-2 py-0.5 border uppercase ${
                          check.status === 'healthy'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800'
                            : check.status === 'warning'
                              ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800'
                              : check.status === 'failed'
                                ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800'
                                : check.status === 'checking'
                                  ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800'
                                  : 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                        }`}
                      >
                        {check.status === 'healthy'
                          ? 'Healthy'
                          : check.status === 'warning'
                            ? 'Warning'
                            : check.status === 'failed'
                              ? 'Failed'
                              : check.status === 'checking'
                                ? 'Checking'
                                : 'Collection pending'}
                      </Badge>
                    </div>

                    {/* Current Result */}
                    <div className="col-span-5 text-slate-700 dark:text-slate-300 leading-snug font-normal break-words">
                      {check.resultSummary}
                    </div>

                    {/* Last Checked */}
                    <div className="col-span-2 text-slate-500 dark:text-slate-400 font-normal">
                      {lastCheckedText}
                    </div>

                    {/* Action Button */}
                    <div className="col-span-1 flex justify-end w-full md:w-auto mt-1 md:mt-0">
                      <button
                        type="button"
                        onClick={() => setSelectedCheck(check)}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold transition shrink-0 ${
                          isWarningOrFailed
                            ? 'bg-amber-100 hover:bg-amber-200 text-amber-900 dark:bg-amber-950/70 dark:hover:bg-amber-900 dark:text-amber-300'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200'
                        }`}
                        title={`${actionLabel} for ${check.title}`}
                        aria-label={`${actionLabel} for ${check.title}`}
                      >
                        <span>{actionLabel}</span>
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Right Drawer Modal for Technical Details */}
      {selectedCheck && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-xs transition-opacity">
          <div
            className="fixed inset-0"
            onClick={() => setSelectedCheck(null)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-md bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full shadow-2xl p-6 flex flex-col z-10 overflow-y-auto">
            {/* Drawer Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  {selectedCheck.title} Details
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCheck(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                aria-label="Close details"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="py-5 space-y-5 flex-1">
              {/* Check Status */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Security Status
                </span>
                <Badge
                  className={`text-[10px] font-bold px-2 py-0.5 border uppercase ${
                    selectedCheck.status === 'healthy'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800'
                      : selectedCheck.status === 'warning'
                        ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-800'
                        : selectedCheck.status === 'failed'
                          ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800'
                          : 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                  }`}
                >
                  {selectedCheck.status === 'healthy'
                    ? 'Healthy'
                    : selectedCheck.status === 'warning'
                      ? 'Warning'
                      : selectedCheck.status === 'failed'
                        ? 'Failed'
                        : 'Collection pending'}
                </Badge>
              </div>

              {/* Current DNS Value / Diagnostic Result */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block">
                  Current DNS Value / Result
                </label>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3.5 text-xs font-mono text-slate-800 dark:text-slate-200 break-all select-all flex items-start justify-between gap-3 shadow-2xs">
                  <span>
                    {selectedCheck.record || selectedCheck.diagnosticText}
                  </span>

                  {isRecordCopyable(selectedCheck.record) && (
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(selectedCheck.id, selectedCheck.record)
                      }
                      className="inline-flex items-center gap-1.5 shrink-0 rounded-lg bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-200 dark:border-slate-600 px-2.5 py-1 text-[11px] font-sans font-semibold text-slate-700 dark:text-slate-200 transition"
                      title="Copy DNS value"
                      aria-label={`Copy ${selectedCheck.title} record`}
                    >
                      {copiedId === selectedCheck.id ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-emerald-600 dark:text-emerald-400">
                            Copied
                          </span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 text-slate-500 dark:text-slate-400" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Explanation */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block">
                  Explanation
                </label>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  {selectedCheck.description}
                </p>
              </div>

              {/* Recommended Remediation (Simple Amber Left Border) */}
              {(selectedCheck.status === 'warning' ||
                selectedCheck.status === 'failed') &&
                selectedCheck.howToFix && (
                  <div className="space-y-1.5 pt-1">
                    <label className="text-xs font-semibold text-slate-900 dark:text-slate-100 block">
                      Recommended Remediation
                    </label>
                    <div className="border-l-3 border-amber-500 pl-3.5 py-1 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                      {selectedCheck.howToFix}
                    </div>
                  </div>
                )}
            </div>

            {/* Drawer Footer */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedCheck(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
