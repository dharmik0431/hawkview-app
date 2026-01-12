'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Search, Plus, Building2, Clock, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

interface Tenant {
  id: string
  name: string
  domain: string
  provider: 'microsoft' | 'google'
  secureScore: number
  licenseCount: number
  status: 'healthy' | 'warning' | 'critical'
  lastSync: string
}

const tenants: Tenant[] = [
  {
    id: 'contoso-ms',
    name: 'Contoso Ltd',
    domain: 'contoso.com',
    provider: 'microsoft',
    secureScore: 87,
    licenseCount: 150,
    status: 'healthy',
    lastSync: '5 minutes ago',
  },
  {
    id: 'northwind-ms',
    name: 'Northwind Traders',
    domain: 'northwind.io',
    provider: 'microsoft',
    secureScore: 62,
    licenseCount: 85,
    status: 'warning',
    lastSync: '12 minutes ago',
  },
  {
    id: 'acme-gw',
    name: 'Acme Corp',
    domain: 'acme.org',
    provider: 'google',
    secureScore: 91,
    licenseCount: 200,
    status: 'healthy',
    lastSync: '2 minutes ago',
  },
  {
    id: 'globex-ms',
    name: 'Globex Industries',
    domain: 'globex.net',
    provider: 'microsoft',
    secureScore: 45,
    licenseCount: 320,
    status: 'critical',
    lastSync: '28 minutes ago',
  },
  {
    id: 'initech-gw',
    name: 'Initech Solutions',
    domain: 'initech.dev',
    provider: 'google',
    secureScore: 78,
    licenseCount: 45,
    status: 'healthy',
    lastSync: '8 minutes ago',
  },
  {
    id: 'umbrella-ms',
    name: 'Umbrella Corp',
    domain: 'umbrella.co',
    provider: 'microsoft',
    secureScore: 58,
    licenseCount: 180,
    status: 'warning',
    lastSync: '15 minutes ago',
  },
]

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
  if (score >= 50) return 'text-orange-500 dark:text-orange-400'
  return 'text-red-600 dark:text-red-400'
}

function getScoreBgColor(score: number) {
  if (score >= 80) return 'bg-green-50 dark:bg-green-900/20'
  if (score >= 50) return 'bg-orange-50 dark:bg-orange-900/20'
  return 'bg-red-50 dark:bg-red-900/20'
}

export default function TenantsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<FilterType>('all')

  const filteredTenants = tenants.filter((tenant) => {
    const matchesSearch =
      tenant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.domain.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.id.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesFilter = filter === 'all' || tenant.provider === filter

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
        <div className="inline-flex rounded-lg border bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800">
          {(['all', 'microsoft', 'google'] as FilterType[]).map((type) => (
            <button
              key={type}
              onClick={() => setFilter(type)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                filter === type
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
              }`}
            >
              {type === 'all' ? 'All' : type === 'microsoft' ? 'Microsoft' : 'Google'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {filteredTenants.map((tenant) => (
          <Link key={tenant.id} href={`/tenants/${tenant.id}`}>
            <Card className="group h-full cursor-pointer rounded-xl border bg-white shadow-sm transition-all hover:shadow-md hover:border-blue-300 dark:bg-gray-900 dark:border-gray-700 dark:hover:border-blue-600">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                      {tenant.name}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {tenant.domain}
                    </p>
                  </div>
                  <Badge className={`capitalize ${getStatusColor(tenant.status)}`}>
                    {tenant.status}
                  </Badge>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className={`rounded-lg p-3 ${getScoreBgColor(tenant.secureScore)}`}>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      Secure Score
                    </p>
                    <p className={`text-xl font-bold ${getScoreColor(tenant.secureScore)}`}>
                      {tenant.secureScore}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      Licenses
                    </p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {tenant.licenseCount}
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t pt-3 dark:border-gray-700">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Synced {tenant.lastSync}</span>
                  </div>
                  <span className="flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 group-hover:underline">
                    Manage Tenant
                    <ChevronRight className="h-4 w-4" />
                  </span>
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
