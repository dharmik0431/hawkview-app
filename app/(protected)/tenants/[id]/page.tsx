'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Shield,
  Key,
  Users,
  AlertTriangle,
  FileText,
  Clock,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { tenants, mockUsers, mockLicenses, mockAlerts, type Tenant } from '@/lib/mock-data'

type TabType = 'security' | 'licenses' | 'users' | 'alerts' | 'reports'

const navItems: { id: TabType; label: string; icon: LucideIcon }[] = [
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'licenses', label: 'Licenses', icon: Key },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'alerts', label: 'Alerts', icon: AlertTriangle },
  { id: 'reports', label: 'Reports', icon: FileText },
]

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

function ProviderBadge({ provider }: { provider: 'microsoft' | 'google' }) {
  if (provider === 'microsoft') {
    return (
      <Badge variant="outline" className="gap-1.5 border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
        <svg className="h-3 w-3" viewBox="0 0 21 21" fill="none">
          <rect x="1" y="1" width="9" height="9" fill="#f25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
          <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
        </svg>
        Microsoft 365
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1.5 border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
      <svg className="h-3 w-3" viewBox="0 0 24 24">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
      Google Workspace
    </Badge>
  )
}

export default function TenantDetailsPage() {
  const params = useParams()
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabType>('security')

  const tenantId = Array.isArray(params.id) ? params.id[0] : params.id
  
  if (!tenantId) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <h2 className="text-xl font-semibold">Invalid tenant ID</h2>
        <Link href="/tenants" className="mt-4 text-blue-600 hover:underline">
          Back to Tenant Directory
        </Link>
      </div>
    )
  }

  const tenant = tenants.find((t) => t.id === tenantId)

  if (!tenant) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <h2 className="text-xl font-semibold">Tenant not found</h2>
        <Link href="/tenants" className="mt-4 text-blue-600 hover:underline">
          Back to Tenant Directory
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] gap-6">
      <aside className="hidden w-56 shrink-0 lg:block">
        <nav className="sticky top-6 space-y-1 rounded-lg border bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = activeTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="flex-1 space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/tenants')}
              className="shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
                  {tenant.name}
                </h1>
                <Badge className={getStatusColor(tenant.status)}>{tenant.status}</Badge>
              </div>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-sm text-gray-500 dark:text-gray-400">{tenant.domain}</span>
                <ProviderBadge provider={tenant.provider} />
                <span className="flex items-center gap-1 text-xs text-gray-400">
                  <Clock className="h-3 w-3" />
                  Synced {tenant.lastSync}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:hidden">
          <div className="flex gap-2 overflow-x-auto pb-2">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = activeTab === item.id
              return (
                <Button
                  key={item.id}
                  variant={isActive ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setActiveTab(item.id)}
                  className="shrink-0 gap-2"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Secure Score
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${getScoreColor(tenant.secureScore)}`}>
                {tenant.secureScore}
                <span className="text-lg font-normal text-gray-400">/100</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className={`h-2 rounded-full ${
                    tenant.secureScore >= 80
                      ? 'bg-green-500'
                      : tenant.secureScore >= 60
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                  style={{ width: `${tenant.secureScore}%` }}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                MFA Coverage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${getScoreColor(tenant.mfaCoverage)}`}>
                {tenant.mfaCoverage}%
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {Math.round((tenant.userCount * tenant.mfaCoverage) / 100)} of {tenant.userCount} users
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                License Usage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-gray-900 dark:text-white">
                {tenant.licenseUsed}
                <span className="text-lg font-normal text-gray-400">/{tenant.licenseCount}</span>
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {tenant.licenseCount - tenant.licenseUsed} available
              </p>
            </CardContent>
          </Card>
        </div>

        {activeTab === 'security' && (
          <Card>
            <CardHeader>
              <CardTitle>Security Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border p-4 dark:border-gray-700">
                  <h4 className="font-medium">Conditional Access Policies</h4>
                  <p className="mt-1 text-2xl font-bold">8</p>
                  <p className="text-sm text-gray-500">5 active, 3 disabled</p>
                </div>
                <div className="rounded-lg border p-4 dark:border-gray-700">
                  <h4 className="font-medium">Privileged Users</h4>
                  <p className="mt-1 text-2xl font-bold">12</p>
                  <p className="text-sm text-gray-500">Global admins and role members</p>
                </div>
                <div className="rounded-lg border p-4 dark:border-gray-700">
                  <h4 className="font-medium">Risky Sign-ins</h4>
                  <p className="mt-1 text-2xl font-bold text-yellow-600">3</p>
                  <p className="text-sm text-gray-500">Last 7 days</p>
                </div>
                <div className="rounded-lg border p-4 dark:border-gray-700">
                  <h4 className="font-medium">Compliance Score</h4>
                  <p className="mt-1 text-2xl font-bold text-green-600">92%</p>
                  <p className="text-sm text-gray-500">Data protection policies</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === 'licenses' && (
          <Card>
            <CardHeader>
              <CardTitle>License Inventory</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>License Name</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Assigned</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mockLicenses.map((license) => (
                    <TableRow key={license.id}>
                      <TableCell className="font-medium">{license.name}</TableCell>
                      <TableCell className="text-gray-500">{license.sku}</TableCell>
                      <TableCell className="text-right">{license.total}</TableCell>
                      <TableCell className="text-right">{license.assigned}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={license.available < 5 ? 'destructive' : 'secondary'}>
                          {license.available}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {activeTab === 'users' && (
          <Card>
            <CardHeader>
              <CardTitle>User Directory</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>MFA</TableHead>
                    <TableHead>Last Sign-in</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mockUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.name}</TableCell>
                      <TableCell className="text-gray-500">{user.email}</TableCell>
                      <TableCell>{user.role}</TableCell>
                      <TableCell>
                        <Badge variant={user.mfaEnabled ? 'default' : 'destructive'}>
                          {user.mfaEnabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-gray-500">{user.lastSignIn}</TableCell>
                      <TableCell>
                        <Badge
                          className={
                            user.status === 'active'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                          }
                        >
                          {user.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {activeTab === 'alerts' && (
          <Card>
            <CardHeader>
              <CardTitle>Active Alerts</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {mockAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`rounded-lg border p-4 ${
                      alert.severity === 'high'
                        ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
                        : alert.severity === 'medium'
                        ? 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20'
                        : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <AlertTriangle
                          className={`h-4 w-4 ${
                            alert.severity === 'high'
                              ? 'text-red-600'
                              : alert.severity === 'medium'
                              ? 'text-yellow-600'
                              : 'text-gray-500'
                          }`}
                        />
                        <h4 className="font-medium">{alert.title}</h4>
                      </div>
                      <Badge
                        className={
                          alert.severity === 'high'
                            ? 'bg-red-100 text-red-700'
                            : alert.severity === 'medium'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-gray-100 text-gray-700'
                        }
                      >
                        {alert.severity}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                      {alert.description}
                    </p>
                    <p className="mt-2 text-xs text-gray-400">{alert.timestamp}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTab === 'reports' && (
          <Card>
            <CardHeader>
              <CardTitle>Reports</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { name: 'Security Assessment', date: 'Generated Jan 10, 2026' },
                  { name: 'License Utilization', date: 'Generated Jan 8, 2026' },
                  { name: 'User Activity Summary', date: 'Generated Jan 5, 2026' },
                  { name: 'Compliance Report', date: 'Generated Jan 3, 2026' },
                ].map((report) => (
                  <button
                    key={report.name}
                    className="flex items-center justify-between rounded-lg border p-4 text-left transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                  >
                    <div>
                      <h4 className="font-medium">{report.name}</h4>
                      <p className="text-sm text-gray-500">{report.date}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
