'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ConnectorStatus {
  configured: boolean
  connector: {
    clientId: string
    homeTenantId: string
    credentialExpiresAt: string | null
    configuredAt: string
  } | null
}

export default function SettingsPage() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [homeTenantId, setHomeTenantId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [credentialExpiresAt, setCredentialExpiresAt] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiClient
      .get<ConnectorStatus>('/api/platform/microsoft-connector')
      .then((result) => {
        setStatus(result)
        if (result.connector) {
          setClientId(result.connector.clientId)
          setHomeTenantId(result.connector.homeTenantId)
        }
      })
      .catch((requestError) =>
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Connector settings could not be loaded.'
        )
      )
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const result = await apiClient.post<{
        configured: boolean
        verifiedOrganization: string
      }>('/api/platform/microsoft-connector', {
        clientId,
        homeTenantId,
        clientSecret,
        credentialExpiresAt: credentialExpiresAt
          ? new Date(`${credentialExpiresAt}T00:00:00Z`).toISOString()
          : null,
      })
      setClientSecret('')
      setMessage(
        `Microsoft connector verified for ${result.verifiedOrganization}. The secret is stored securely and is no longer available to the browser.`
      )
      const refreshed = await apiClient.get<ConnectorStatus>(
        '/api/platform/microsoft-connector'
      )
      setStatus(refreshed)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'The connector could not be configured.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>HawkView Microsoft Connector</CardTitle>
          <CardDescription>
            Platform Admin only. Configure the shared multitenant connector
            without storing its credential in the frontend or PostgreSQL.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {status?.configured && (
            <div className="flex gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">Connector configured</p>
                <p className="text-sm">
                  Client ID: {status.connector?.clientId}
                </p>
                <p className="text-sm">
                  Credential expiration:{' '}
                  {status.connector?.credentialExpiresAt
                    ? new Date(
                        status.connector.credentialExpiresAt
                      ).toLocaleDateString()
                    : 'Not recorded'}
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="connector-client-id">
                  Application (client) ID
                </Label>
                <Input
                  id="connector-client-id"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="connector-tenant-id">
                  Home directory tenant ID
                </Label>
                <Input
                  id="connector-tenant-id"
                  value={homeTenantId}
                  onChange={(event) => setHomeTenantId(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="connector-secret">
                  New client secret value
                </Label>
                <Input
                  id="connector-secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="connector-expiration">
                  Secret expiration date
                </Label>
                <Input
                  id="connector-expiration"
                  type="date"
                  value={credentialExpiresAt}
                  onChange={(event) =>
                    setCredentialExpiresAt(event.target.value)
                  }
                />
              </div>
            </div>
            <p className="text-sm text-slate-500">
              HawkView sends the secret directly to the backend, validates it
              with Microsoft, stores it in Secret Manager, and never returns it.
            </p>
            {message && (
              <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                {message}
              </p>
            )}
            {error && (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving || !clientSecret}>
              {saving ? 'Validating and storing…' : 'Validate and Store Securely'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
