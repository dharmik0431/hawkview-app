'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Building2, Clock, Plus, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Tenant = {
  name: string
  domain: string
  type: 'Microsoft 365' | 'Google Workspace'
  mfaCoverage: number
  licenseCount: number
  lastSync: string
  status: 'Healthy' | 'Issues'
}

type KpiCard = {
  title: string
  value: string
  iconType: 'lucide' | 'custom'
  icon: any
  iconBg: string
  iconColor?: string
}

const kpiCards: KpiCard[] = [
  {
    title: 'Total Tenants',
    value: '24',
    iconType: 'lucide',
    icon: Building2,
    iconBg: 'bg-blue-100 dark:bg-blue-900',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
  {
    title: 'Microsoft 365',
    value: '12',
    iconType: 'custom',
    icon: () => (
      <svg
        className="h-5 w-5"
        viewBox="0 0 21 21"
        fill="none"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
    ),
    iconBg: 'bg-orange-100 dark:bg-orange-900',
  },
  {
    title: 'Google Workspace',
    value: '12',
    iconType: 'custom',
    icon: () => (
      <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    ),
    iconBg: 'bg-green-100 dark:bg-green-900',
  },
  {
    title: 'Last Scan',
    value: '2m ago',
    iconType: 'lucide',
    icon: Clock,
    iconBg: 'bg-purple-100 dark:bg-purple-900',
    iconColor: 'text-purple-600 dark:text-purple-400',
  },
]

const tenants: Tenant[] = [
  {
    name: 'Acme Corporation',
    domain: 'acme.com',
    type: 'Microsoft 365',
    mfaCoverage: 95,
    licenseCount: 150,
    lastSync: '3 minutes ago',
    status: 'Healthy',
  },
  {
    name: 'TechStart Inc',
    domain: 'techstart.io',
    type: 'Google Workspace',
    mfaCoverage: 88,
    licenseCount: 45,
    lastSync: '5 minutes ago',
    status: 'Healthy',
  },
  {
    name: 'Global Services LLC',
    domain: 'globalservices.net',
    type: 'Microsoft 365',
    mfaCoverage: 72,
    licenseCount: 320,
    lastSync: '8 minutes ago',
    status: 'Issues',
  },
  {
    name: 'Innovate Labs',
    domain: 'innovatelabs.co',
    type: 'Google Workspace',
    mfaCoverage: 100,
    licenseCount: 28,
    lastSync: '2 minutes ago',
    status: 'Healthy',
  },
  {
    name: 'Enterprise Solutions',
    domain: 'enterprise-solutions.com',
    type: 'Microsoft 365',
    mfaCoverage: 65,
    licenseCount: 89,
    lastSync: '15 minutes ago',
    status: 'Issues',
  },
]

export default function DashboardPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const dev = searchParams.get('dev') === '1'
  const devSuffix = dev ? '?dev=1' : ''

  const [query, setQuery] = React.useState('')

  const filteredTenants = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tenants
    return tenants.filter((t) => {
      return (
        t.name.toLowerCase().includes(q) ||
        t.domain.toLowerCase().includes(q) ||
        t.type.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q)
      )
    })
  }, [query])

  const statusBadgeClass =
    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium'

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {kpiCards.map((card) => (
          <Card key={card.title}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-lg ${card.iconBg}`}>
                  {card.iconType === 'custom' ? (
                    <card.icon />
                  ) : (
                    <card.icon className={`h-5 w-5 ${card.iconColor ?? ''}`} />
                  )}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{card.title}</p>
                  <p className="text-2xl font-bold">{card.value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tenants Table */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle>Tenants Overview</CardTitle>
              <CardDescription>
                Manage and monitor all your client tenants.
              </CardDescription>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tenants by name, domain, status..."
                  className="pl-9 w-full sm:w-80"
                />
              </div>

              <Button
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => router.push(`/tenants${devSuffix}`)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Tenant
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>MFA Coverage</TableHead>
                  <TableHead>License Count</TableHead>
                  <TableHead>Last Sync</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {filteredTenants.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-10 text-center text-muted-foreground"
                    >
                      No tenants match “{query}”.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTenants.map((tenant) => (
                    <TableRow
                      key={tenant.domain}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => router.push(`/tenants${devSuffix}`)}
                      role="button"
                      tabIndex={0}
                    >
                      <TableCell>
                        <div>
                          <p className="font-medium">{tenant.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {tenant.domain}
                          </p>
                        </div>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2">
                          {tenant.type === 'Microsoft 365' ? (
                            <svg
                              className="h-4 w-4"
                              viewBox="0 0 21 21"
                              fill="none"
                              aria-hidden="true"
                            >
                              <rect
                                x="1"
                                y="1"
                                width="9"
                                height="9"
                                fill="#F25022"
                              />
                              <rect
                                x="11"
                                y="1"
                                width="9"
                                height="9"
                                fill="#7FBA00"
                              />
                              <rect
                                x="1"
                                y="11"
                                width="9"
                                height="9"
                                fill="#00A4EF"
                              />
                              <rect
                                x="11"
                                y="11"
                                width="9"
                                height="9"
                                fill="#FFB900"
                              />
                            </svg>
                          ) : (
                            <svg
                              className="h-4 w-4"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path
                                fill="#4285F4"
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                              />
                              <path
                                fill="#34A853"
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                              />
                              <path
                                fill="#FBBC05"
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                              />
                              <path
                                fill="#EA4335"
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                              />
                            </svg>
                          )}

                          <span className="text-sm">{tenant.type}</span>
                        </div>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-20 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full ${
                                tenant.mfaCoverage >= 90
                                  ? 'bg-green-500'
                                  : tenant.mfaCoverage >= 75
                                    ? 'bg-yellow-500'
                                    : 'bg-red-500'
                              }`}
                              style={{ width: `${tenant.mfaCoverage}%` }}
                            />
                          </div>
                          <span className="text-sm">{tenant.mfaCoverage}%</span>
                        </div>
                      </TableCell>

                      <TableCell>{tenant.licenseCount}</TableCell>

                      <TableCell className="text-muted-foreground">
                        {tenant.lastSync}
                      </TableCell>

                      <TableCell>
                        {/* If your shadcn Badge doesn't support variants like "success",
                            we use classes to keep it consistent. */}
                        <span
                          className={`${statusBadgeClass} ${
                            tenant.status === 'Healthy'
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                              : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
                          }`}
                        >
                          {tenant.status}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 text-xs text-muted-foreground">
            Tip: Click any tenant row to open tenant management.
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
