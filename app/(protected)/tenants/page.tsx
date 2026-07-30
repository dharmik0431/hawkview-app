'use client'

import { NeedsAttentionCell } from '@/components/tenants/needs-attention-cell'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, Plus, Clock, ChevronRight, AlertCircle, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useTenants } from '@/lib/api/hooks'
import { useQueryClient } from '@tanstack/react-query'

type Provider = 'microsoft' | 'google'
type TenantStatus = 'pending' | 'active' | 'suspended' | 'disconnected'

type FilterType = 'all' | 'microsoft' | 'google'

function statusBadge(status: TenantStatus) {
  switch (status) {
    case 'active':
      return 'bg-green-50 text-green-700 border border-green-200'
    case 'pending':
      return 'bg-orange-50 text-orange-700 border border-orange-200'
    case 'suspended':
    case 'disconnected':
      return 'bg-red-50 text-red-700 border border-red-200'
  }
}

function scoreColor(score: number) {
  if (score >= 80) return 'text-green-600'
  if (score >= 50) return 'text-orange-600'
  return 'text-red-600'
}

function formatSyncTime(timeStr: string | null) {
  if (!timeStr) return 'Not synced yet'
  if (timeStr.includes('T')) {
    try {
      const d = new Date(timeStr)
      if (isNaN(d.getTime())) return 'time unavailable'
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d)
    } catch {
      return timeStr
    }
  }
  return timeStr
}

function ProviderIcon({ provider }: { provider: Provider }) {
  return provider === 'microsoft' ? <MicrosoftMark /> : <GoogleMark />
}

function MicrosoftMark() {
  return (
    <div className="w-14 h-14 rounded-2xl flex items-center justify-center border shadow-sm bg-blue-50 border-blue-100">
      <div className="grid grid-cols-2 gap-1">
        <span className="h-3 w-3 bg-[#F25022] rounded-[3px]" />
        <span className="h-3 w-3 bg-[#7FBA00] rounded-[3px]" />
        <span className="h-3 w-3 bg-[#00A4EF] rounded-[3px]" />
        <span className="h-3 w-3 bg-[#FFB900] rounded-[3px]" />
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <div className="w-14 h-14 rounded-2xl flex items-center justify-center border shadow-sm bg-red-50 border-red-100">
      <svg width="28" height="28" viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#FFC107"
          d="M43.611 20.083H42V20H24v8h11.303C33.708 32.91 29.22 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.651-.389-3.917z"
        />
        <path
          fill="#FF3D00"
          d="M6.306 14.691l6.571 4.819C14.655 16.108 19.009 12 24 12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4c-7.682 0-14.409 4.328-17.694 10.691z"
        />
        <path
          fill="#4CAF50"
          d="M24 44c5.118 0 9.786-1.969 13.314-5.186l-6.143-5.197C29.136 35.091 26.7 36 24 36c-5.199 0-9.677-3.067-11.29-7.463l-6.52 5.02C9.44 39.556 16.227 44 24 44z"
        />
        <path
          fill="#1976D2"
          d="M43.611 20.083H42V20H24v8h11.303c-.792 2.26-2.231 4.191-4.132 5.617l.002-.001 6.143 5.197C36.91 39.186 44 34 44 24c0-1.341-.138-2.651-.389-3.917z"
        />
      </svg>
    </div>
  )
}

export default function TenantsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, isFetching, error, refetch } = useTenants()

  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<FilterType>('all')

  const loading = isLoading || isFetching
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0)
      return
    }
    setElapsedSeconds(0)
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [loading])

  const tenants = data?.tenants || []
  const errorMessage = error ? (error as Error).message : data?.error || null

  const handleRetry = () => {
    queryClient.invalidateQueries({ queryKey: ['tenants'] })
    refetch()
  }

  const filteredTenants = useMemo(() => {
    const list = data?.tenants || []
    return list.filter((tenant: any) => {
      const q = searchQuery.toLowerCase()
      const matchesSearch =
        tenant.name?.toLowerCase().includes(q) ||
        tenant.domain?.toLowerCase().includes(q) ||
        tenant.id?.toLowerCase().includes(q)

      const matchesFilter = filter === 'all' || tenant.provider === filter
      return matchesSearch && matchesFilter
    })
  }, [data?.tenants, searchQuery, filter])

  const loadingText =
    elapsedSeconds < 15
      ? `Loading tenant directory… ${elapsedSeconds}s`
      : `HawkView API is taking longer than expected… ${elapsedSeconds}s`

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              Tenant Directory
            </h1>
            <Badge className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-3 py-1 rounded-full text-xs shadow-sm flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Database-backed API
            </Badge>
          </div>
          <p className="mt-2 text-base text-slate-500 dark:text-slate-400">
            Select a tenant environment to manage security, licenses, and users.
          </p>
        </div>
        <Button className="gap-2 rounded-xl">
          <Plus className="h-4 w-4" />
          Onboard New Tenant
        </Button>
      </div>

      {/* Database API Error Alert */}
      {errorMessage && !loading && (
        <Card className="border-red-200 bg-red-50/80 dark:bg-red-950/20 dark:border-red-900/50 p-4 rounded-2xl">
          <div className="flex items-start gap-3 text-red-800 dark:text-red-300">
            <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
            <div className="flex-1 text-sm">
              <p className="font-semibold">Unable to load the tenant directory</p>
              <p className="mt-1 text-red-700 dark:text-red-400">{errorMessage}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              className="gap-1.5 bg-white border-red-200 text-red-800 hover:bg-red-100"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </Card>
      )}

      {/* Search + Filter bar */}
      <div className="bg-white dark:bg-slate-900 p-2 rounded-2xl border shadow-sm flex flex-col md:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by name, domain, or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-11 h-12 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>

        <div className="flex items-center border-t md:border-t-0 md:border-l px-1 md:px-3">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
            {(['all', 'microsoft', 'google'] as FilterType[]).map((type) => (
              <button
                key={type}
                onClick={() => setFilter(type)}
                className={[
                  'px-4 py-2 rounded-lg text-sm font-semibold transition-all',
                  filter === type
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white',
                ].join(' ')}
              >
                {type === 'all'
                  ? 'All'
                  : type === 'microsoft'
                    ? 'Microsoft'
                    : 'Google'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-slate-400">
            <RefreshCw className="h-4 w-4 animate-spin text-blue-600" />
            <span>{loadingText}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse p-6 bg-white dark:bg-slate-900 rounded-3xl border">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-14 h-14 bg-slate-100 dark:bg-slate-800 rounded-2xl" />
                  <div className="space-y-2 flex-1">
                    <div className="h-5 bg-slate-100 dark:bg-slate-800 rounded w-3/4" />
                    <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-1/2" />
                  </div>
                </div>
                <div className="h-16 bg-slate-50 dark:bg-slate-800/60 rounded-xl mb-4" />
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-14 bg-slate-50 dark:bg-slate-800/60 rounded-xl" />
                  <div className="h-14 bg-slate-50 dark:bg-slate-800/60 rounded-xl" />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Grid */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredTenants.map((tenant: any) => (
            <Link key={tenant.id} href={`/tenants/${tenant.id}`}>
              <Card className="group bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 p-0 hover:border-blue-200 hover:shadow-xl hover:shadow-blue-500/5 transition-all duration-300 cursor-pointer relative overflow-hidden">
                {/* accent */}
                <div
                  className={[
                    'absolute top-0 right-0 w-32 h-32 opacity-5 rounded-bl-full pointer-events-none -mr-8 -mt-8',
                    tenant.provider === 'microsoft'
                      ? 'bg-blue-500'
                      : 'bg-red-500',
                  ].join(' ')}
                />

                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-5 relative z-10">
                    <div className="flex items-center gap-4">
                      <ProviderIcon provider={tenant.provider} />
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors">
                          {tenant.name}
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                          {tenant.domain || 'Domain not synced'}
                        </p>
                      </div>
                    </div>

                    <Badge
                      className={`uppercase tracking-wide ${statusBadge(tenant.status)}`}
                    >
                      {tenant.status}
                    </Badge>
                  </div>

                  {/* Needs Attention tags */}
                  <div className="mb-5 relative z-10">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                      Needs Attention
                    </p>
                    <NeedsAttentionCell tenant={tenant} />
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-6 relative z-10">
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-100 dark:border-slate-800">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                        Secure Score
                      </p>
                      {tenant.secureScore == null ? (
                        <span className="text-sm font-semibold text-slate-500">
                          Not synced
                        </span>
                      ) : (
                        <div className="flex items-end gap-1">
                          <span
                            className={`text-xl font-bold ${scoreColor(tenant.secureScore)}`}
                          >
                            {tenant.secureScore}%
                          </span>
                          <span className="text-xs font-semibold text-slate-400 mb-1">
                            / 100
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-100 dark:border-slate-800">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                        Licenses
                      </p>
                      {tenant.licenseCount == null ? (
                        <span className="text-sm font-semibold text-slate-500">
                          Not synced
                        </span>
                      ) : (
                        <div className="flex items-end gap-1">
                          <span className="text-xl font-bold text-slate-900 dark:text-white">
                            {tenant.licenseCount}
                          </span>
                          <span className="text-xs font-semibold text-slate-400 mb-1">
                            assigned
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-800 relative z-10">
                    <span
                      className="flex items-center gap-1.5 text-xs font-semibold text-slate-400"
                      title={tenant.lastSync || ''}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      {tenant.lastSync
                        ? `Synced ${formatSyncTime(tenant.lastSync)}`
                        : 'Not synced yet'}
                    </span>
                    <span className="text-sm font-semibold text-blue-600 flex items-center gap-1 group-hover:underline">
                      Manage Tenant <ChevronRight className="h-4 w-4" />
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {!loading && !error && filteredTenants.length === 0 && (
        <div className="text-center py-20 bg-white dark:bg-slate-900 rounded-3xl border border-dashed">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            No tenants found
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Try adjusting your search or filters.
          </p>
        </div>
      )}
    </div>
  )
}
