'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Search, Plus, Building2, Shield, Clock, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { tenants, type Tenant } from '@/lib/mock-data'

type FilterType = 'all' | 'microsoft' | 'google'

function getStatusColor(status: Tenant['status']) {
  switch (status) {
    case 'healthy':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    case 'warning':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    case 'critical':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  }
}

function getScoreColor(score: number) {
  if (score >= 80) return 'text-green-600 dark:text-green-400'
  if (score >= 60) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-red-600 dark:text-red-400'
}

function ProviderLogo({ provider }: { provider: 'microsoft' | 'google' }) {
  if (provider === 'microsoft') {
    return (
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
        <svg className="h-7 w-7" viewBox="0 0 21 21" fill="none">
          <rect x="1" y="1" width="9" height="9" fill="#f25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
          <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
        </svg>
      </div>
    )
  }
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-red-100 dark:bg-red-900/30">
      <svg className="h-7 w-7" viewBox="0 0 24 24">
        <path
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          fill="#4285F4"
        />
        <path
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          fill="#34A853"
        />
        <path
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          fill="#FBBC05"
        />
        <path
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          fill="#EA4335"
        />
      </svg>
    </div>
  )
}

export default function TenantsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<FilterType>('all')

  const filteredTenants = tenants.filter((tenant) => {
    const matchesSearch =
      tenant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.domain.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.id.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesFilter =
      filter === 'all' || tenant.provider === filter

    return matchesSearch && matchesFilter
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Tenant Directory
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Select a tenant environment to manage security, licenses, and users.
          </p>
        </div>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Onboard New Tenant
        </Button>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="Search by name, domain, or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex gap-2">
          {(['all', 'microsoft', 'google'] as FilterType[]).map((type) => (
            <Button
              key={type}
              variant={filter === type ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(type)}
              className="capitalize"
            >
              {type === 'all' ? 'All' : type === 'microsoft' ? 'Microsoft' : 'Google'}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredTenants.map((tenant) => (
          <Link key={tenant.id} href={`/tenants/${tenant.id}`} prefetch={false}>
            <Card className="group cursor-pointer transition-all hover:shadow-md hover:border-blue-300 dark:hover:border-blue-700">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <ProviderLogo provider={tenant.provider} />
                    <div>
                      <h3 className="font-medium text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                        {tenant.name}
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {tenant.domain}
                      </p>
                    </div>
                  </div>
                  <Badge className={getStatusColor(tenant.status)}>
                    {tenant.status}
                  </Badge>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-gray-400" />
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Secure Score</p>
                      <p className={`text-sm font-semibold ${getScoreColor(tenant.secureScore)}`}>
                        {tenant.secureScore}/100
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-gray-400" />
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Licenses</p>
                      <p className="text-sm font-semibold text-gray-900 dark:text-white">
                        {tenant.licenseUsed}/{tenant.licenseCount}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t pt-3 dark:border-gray-700">
                  <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <Clock className="h-3 w-3" />
                    <span>Synced {tenant.lastSync}</span>
                  </div>
                  <div className="flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 group-hover:underline">
                    Manage Tenant
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {filteredTenants.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Building2 className="h-12 w-12 text-gray-300 dark:text-gray-600" />
          <h3 className="mt-4 text-lg font-medium text-gray-900 dark:text-white">
            No tenants found
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Try adjusting your search or filter criteria.
          </p>
        </div>
      )}
    </div>
  )
}
