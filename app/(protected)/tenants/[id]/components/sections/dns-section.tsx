'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import CopyPill from '../shared/copy-pill'

// If CopyPill is in page.tsx currently, import it from wherever you have it.
// If it only exists inside page.tsx, we will move it next.
// For now, keep the same import path you used in page.tsx.

export default function DnsSection({
  tenant,
  domains,
  isMicrosoft,
  dns,
}: {
  tenant: any
  domains: any[]
  isMicrosoft: boolean
  dns: any
}) {
  const [domainOpen, setDomainOpen] = useState(false)
  const [domainSelected, setDomainSelected] = useState<string>('')

  const spf = dns?.spf ?? '—'
  const dkim = dns?.dkim ?? '—'
  const dmarc = dns?.dmarc ?? '—'

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Domain Health</div>

          <div className="relative">
            <button
              onClick={() => setDomainOpen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-semibold shadow-sm hover:shadow-md transition"
              title="Select domain"
            >
              <span className="h-4 w-4 text-muted-foreground">🌐</span>
              {domainSelected || tenant.domain}
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>

            {domainOpen && (
              <div className="absolute right-0 mt-2 w-[260px] rounded-xl border bg-white shadow-lg overflow-hidden z-10">
                {(domains.length ? domains : [tenant.domain]).map((d: any) => (
                  <button
                    key={d}
                    onClick={() => {
                      setDomainSelected(d)
                      setDomainOpen(false)
                    }}
                    className={`w-full text-left px-4 py-3 text-sm hover:bg-muted/40 ${
                      d === domainSelected ? 'bg-blue-50 text-blue-700' : ''
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-1 text-xs text-muted-foreground">
          DNS Records & Reputation
        </div>

        <div className="mt-5 rounded-2xl border bg-muted/20 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-green-600" />
            <div className="text-sm font-semibold">Blacklist Status: Clean</div>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Domain is not present on any major blocklists (checked 50+ sources).
          </div>
        </div>

        <div className="mt-6 space-y-6">
          <div className="rounded-2xl border p-4 bg-white">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="font-semibold text-sm">SPF</div>
                <Badge className="bg-green-50 text-green-700 border border-green-200 uppercase">
                  Healthy
                </Badge>
              </div>
              <button className="text-xs font-medium text-blue-600 hover:underline">
                How to fix
              </button>
            </div>
            <CopyPill value={spf} />
            <div className="mt-2 text-xs text-muted-foreground">
              Sender Policy Framework prevents spoofing.
            </div>
          </div>

          <div className="rounded-2xl border p-4 bg-white">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="font-semibold text-sm">DKIM</div>
                <Badge className="bg-green-50 text-green-700 border border-green-200 uppercase">
                  Healthy
                </Badge>
              </div>
              <button className="text-xs font-medium text-blue-600 hover:underline">
                How to fix
              </button>
            </div>
            <CopyPill value={dkim} />
            <div className="mt-2 text-xs text-muted-foreground">
              DomainKeys Identified Mail verifies message integrity.
            </div>
          </div>

          <div className="rounded-2xl border p-4 bg-white">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="font-semibold text-sm">DMARC</div>
                <Badge
                  className={`${
                    isMicrosoft
                      ? 'bg-orange-50 text-orange-700 border border-orange-200'
                      : 'bg-green-50 text-green-700 border border-green-200'
                  } uppercase`}
                >
                  {isMicrosoft ? 'Warning' : 'Healthy'}
                </Badge>
              </div>
              <button className="text-xs font-medium text-blue-600 hover:underline">
                How to fix
              </button>
            </div>
            <div className="mt-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs font-mono break-all">
              {spf}
            </div>

            <div className="mt-2 text-xs text-muted-foreground">
              Domain-based Message Authentication, Reporting, and Conformance.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
