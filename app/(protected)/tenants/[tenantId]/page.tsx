'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Shield,
  Key,
  Users,
  Clock,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { tenants, mockUsers, mockLicenses, type Tenant } from '@/lib/mock-data'

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
  if (score >= 50) return 'text-orange-600 dark:text-orange-400'
  return 'text-red-600 dark:text-red-400'
}

function getScoreBgColor(score: number) {
  if (score >= 80) return 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
  if (score >= 50) return 'bg-orange-50 border-orange-200 dark:bg-orange-900/20 dark:border-orange-800'
  return 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
}

function ProviderIcon({ provider }: { provider: 'microsoft' | 'google' }) {
  if (provider === 'microsoft') {
    return (
      <svg className="h-5 w-5" viewBox="0 0 21 21" fill="none">
        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
        <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
      </svg>
    )
  }
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

export default function TenantDetailsPage() {
  const params = useParams()

  const tenantId = Array.isArray(params.tenantId) ? params.tenantId[0] : params.tenantId

  if (!tenantId) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <h2 className="text-xl font-semibold">Invalid tenant ID</h2>
        <Link href="/tenants" className="mt-4 text-blue-600 hover:underline">
          Back to Tenants
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
          Back to Tenants
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/tenants"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Tenants
        </Link>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg border bg-white dark:border-gray-700 dark:bg-gray-800">
            <ProviderIcon provider={tenant.provider} />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
                {tenant.name}
              </h1>
              <Badge className={getStatusColor(tenant.status)}>{tenant.status}</Badge>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{tenant.domain}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={`border ${getScoreBgColor(tenant.secureScore)}`}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
              <Shield className="h-4 w-4" />
              Secure Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${getScoreColor(tenant.secureScore)}`}>
              {tenant.secureScore}%
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
              <Key className="h-4 w-4" />
              Licenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-gray-900 dark:text-white">
              {tenant.licenseUsed}
              <span className="text-lg font-normal text-gray-400">/{tenant.licenseCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
              <Clock className="h-4 w-4" />
              Last Sync
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-medium text-gray-900 dark:text-white">
              {tenant.lastSync}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="licenses">Licenses</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">MFA Coverage</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${getScoreColor(tenant.mfaCoverage)}`}>
                  {tenant.mfaCoverage}%
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {Math.round((tenant.userCount * tenant.mfaCoverage) / 100)} of {tenant.userCount} users enabled
                </p>
                <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className={`h-2 rounded-full ${
                      tenant.mfaCoverage >= 80 ? 'bg-green-500' : tenant.mfaCoverage >= 50 ? 'bg-orange-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${tenant.mfaCoverage}%` }}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">User Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {tenant.userCount}
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Total active users</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border p-3 dark:border-gray-700">
                  <span className="text-sm">License assignment updated</span>
                  <span className="text-xs text-gray-500">2 hours ago</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3 dark:border-gray-700">
                  <span className="text-sm">Security policy sync completed</span>
                  <span className="text-xs text-gray-500">5 hours ago</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3 dark:border-gray-700">
                  <span className="text-sm">New user provisioned</span>
                  <span className="text-xs text-gray-500">1 day ago</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">User Directory</CardTitle>
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
        </TabsContent>

        <TabsContent value="licenses">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">License Inventory</CardTitle>
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
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Conditional Access Policies</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">8</div>
                <p className="text-sm text-gray-500">5 active, 3 disabled</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Privileged Users</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">12</div>
                <p className="text-sm text-gray-500">Global admins and role members</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Risky Sign-ins</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-orange-600">3</div>
                <p className="text-sm text-gray-500">Last 7 days</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Compliance Score</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">92%</div>
                <p className="text-sm text-gray-500">Data protection policies</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
