'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'

import { TENANTS } from './mock/tenants'
import { getMockTenant } from './mock/getMockTenant'

//Importing different sections
import DnsSection from './components/sections/dns-section'
import LicensesSection from './components/sections/licenses-section'
import EntraSection from './components/sections/entra-section'
import ExchangePage from './components/sections/exchange-section'
import SharePointPage from './components/sections/sharepoint-section'

import type { TenantMockBundle } from './mock/types'

import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  ZoomableGroup,
} from 'react-simple-maps'

import { geoCentroid } from 'd3-geo'

import {
  ChevronLeft,
  RefreshCw,
  Settings2,
  Copy,
  ShieldCheck,
  Mail,
  Users,
  HardDrive,
  ChevronDown,
  X,
  Ban,
  Search,
  User,
  Layers,
  Shield,
  Activity,
  ChevronRight,
  Laptop,
  Plus,
  Minus,
  RotateCcw,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type Provider = 'microsoft' | 'google'
type TenantStatus = 'healthy' | 'warning' | 'critical'

type Tenant = {
  id: string
  name: string
  domain: string
  provider: Provider
  status: TenantStatus
  secureScore: number
  licenseCount: number
  lastSync: string
  domains?: string[]
}

type TenantSection =
  | 'home'
  | 'entra'
  | 'exchange'
  | 'teams'
  | 'sharepoint'
  | 'workspace'
  | 'directory'
  | 'gmail'
  | 'drive'
  | 'security'

type EntraTab = 'overview' | 'identity' | 'security' | 'licenses'

type TenantUser = {
  id: string
  name: string
  email: string
  type: 'Member' | 'Guest'
  role: 'Global Administrator' | 'User' | 'External Auditor' | 'Service Account'
  status: 'Enabled' | 'Disabled'
  mfa: 'Enforced' | 'Enabled' | 'Disabled'
  lastLogin: string
  driveUsage: string
  mailUsage: string
  authMethods: string[]
  licenses: string[]
  groups: string[]
  devices: { name: string; os: string; lastSync: string; status: string }[]
}

// =====================
// Sign-in log data types
// =====================

type SignInResult = 'Success' | 'Failure'

type SignInEvent = {
  id: string
  userId: string
  userDisplayName: string
  userPrincipalName: string
  createdAt: string
  ipAddress: string
  result: SignInResult
  appDisplayName: string
  clientAppUsed: string
  country: string
  city?: string
  latitude: number
  longitude: number
  riskLevel?: 'low' | 'medium' | 'high'
}

type TimeWindow = '24h' | '7d' | '30d'

const US_STATES_TOPOJSON_URL =
  'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json'

const WORLD_TOPOJSON_URL =
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'

/* ================================
   ✅ Teams (scalable mock data)
   ================================ */

type TeamsPolicySummary = {
  messagingPolicies: number
  meetingPolicies: number
  callingPolicies: number
  appPermissionPolicies: number
  appSetupPolicies: number
}

type TeamsExternalAccess = {
  enabled: boolean
  allowTeamsConsumer: boolean
  allowedTenants: {
    tenantName: string
    tenantId: string
    status: 'Allowed' | 'Blocked'
  }[]
  allowedDomains: { domain: string; status: 'Allowed' | 'Blocked' }[]
}

type TeamsMeetingSettings = {
  anonymousJoin: 'Allowed' | 'Blocked'
  cloudRecording: 'Allowed' | 'Blocked'
  transcription: 'Allowed' | 'Blocked'
  lobbyBypass: 'Everyone' | 'People in my org' | 'Invited users'
}

type TeamsPhoneOverview = {
  totalNumbers: number
  assignedToUsers: number
  resourceAccounts: number
  autoAttendants: number
  callQueues: number
}

type TeamsAppGovernance = {
  allowedAppsCount: number
  blockedAppsCount: number
  customAppsCount: number
  highRiskApps: {
    name: string
    reason: string
    status: 'Allowed' | 'Blocked'
  }[]
}

type TeamsLifecycle = {
  activeTeams: number
  inactiveTeams90d: number
  inactiveTeams180d: number
  staleTeams: {
    name: string
    owners: number
    members: number
    lastActivity: string
  }[]
}

type TeamsStats = {
  teamsCount: number
  channelsCount: number
  privateChannels: number
  sharedChannels: number
  guestUsers: number
  externalUsers: number
}

/* ================================
   ✅ SharePoint (scalable mock data)
   ================================ */

type SharingLevel =
  | 'ANYONE'
  | 'NEW_AND_EXISTING_GUESTS'
  | 'EXISTING_GUESTS'
  | 'ONLY_PEOPLE_IN_ORG'

type SharePointSiteType = 'Team site' | 'Communication site' | 'OneDrive'

type SharePointSite = {
  id: string
  name: string
  url: string
  type: SharePointSiteType
  owners: number
  externalSharing: boolean
  guestsCount: number
  storageUsedGB: number
  storageQuotaGB: number
  lastActivity: string
  sensitivityLabel?: string
}

type DeletedSite = {
  id: string
  name: string
  url: string
  deletedOn: string
  daysRemaining: number
  sizeGB: number
}

type SharePointOverview = {
  totalSites: number
  totalStorageQuotaGB: number
  oneDriveStorageLimitGB: number
  siteStorageLimitsMode: 'Automatic' | 'Manual'
  sharingSharePoint: SharingLevel
  sharingOneDrive: SharingLevel
}

function sharingLabel(level: SharingLevel) {
  if (level === 'ANYONE') return 'Anyone'
  if (level === 'NEW_AND_EXISTING_GUESTS') return 'New and existing guests'
  if (level === 'EXISTING_GUESTS') return 'Existing guests'
  return 'Only people in your organization'
}

function sharingRank(level: SharingLevel) {
  // higher = more permissive
  if (level === 'ANYONE') return 4
  if (level === 'NEW_AND_EXISTING_GUESTS') return 3
  if (level === 'EXISTING_GUESTS') return 2
  return 1
}

/* ================================
   ✅ Exchange (scalable mock data)
   (FIXED: moved OUTSIDE of SIGNINS)
   ================================ */

type MailboxType = 'User' | 'Shared' | 'Room' | 'Equipment'

type Mailbox = {
  id: string
  displayName: string
  userPrincipalName: string
  aliases: string[]
  mailboxType: MailboxType
  sizeGB: number
  itemCount: number
  archiveEnabled: boolean
  retentionLabel?: string
  delegation?: {
    fullAccess?: string[]
    sendAs?: string[]
    sendOnBehalf?: string[]
  }
  lastLogon?: string
}

type MailRule = {
  id: string
  name: string
  mailboxUpn: string
  enabled: boolean
  priority: number
  description: string
  actions: string[]
  conditions: string[]
}

type AcceptedDomain = {
  id: string
  domain: string
  type: 'Authoritative' | 'InternalRelay' | 'ExternalRelay'
  isDefault?: boolean
}

type MailGroupType =
  | 'Microsoft365'
  | 'DistributionList'
  | 'DynamicDL'
  | 'MailEnabledSecurity'

type MailGroup = {
  id: string
  name: string
  type: MailGroupType
  email: string
  membersCount: number
  owners?: string[]
  description?: string
}

/** Mock Exchange data */

function withinTimeWindow(createdAtIso: string, window: TimeWindow) {
  const ts = new Date(createdAtIso).getTime()
  const now = Date.now()
  const day = 1000 * 60 * 60 * 24
  const delta = now - ts

  if (window === '24h') return delta <= day
  if (window === '7d') return delta <= 7 * day
  return delta <= 30 * day
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString()
}

function statusBadge(status: TenantStatus) {
  switch (status) {
    case 'healthy':
      return 'bg-green-50 text-green-700 border border-green-200'
    case 'warning':
      return 'bg-orange-50 text-orange-700 border border-orange-200'
    case 'critical':
      return 'bg-red-50 text-red-700 border border-red-200'
  }
}

function ProviderIcon({ provider }: { provider: Provider }) {
  return provider === 'microsoft' ? <MicrosoftMark /> : <GoogleMark />
}

function MicrosoftMark() {
  return (
    <div className="h-10 w-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
      <div className="grid grid-cols-2 gap-0.5">
        <span className="h-2.5 w-2.5 bg-[#F25022] rounded-[2px]" />
        <span className="h-2.5 w-2.5 bg-[#7FBA00] rounded-[2px]" />
        <span className="h-2.5 w-2.5 bg-[#00A4EF] rounded-[2px]" />
        <span className="h-2.5 w-2.5 bg-[#FFB900] rounded-[2px]" />
      </div>
    </div>
  )
}

function GoogleMark() {
  return (
    <div className="h-10 w-10 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center">
      <span className="font-bold text-lg" style={{ color: '#4285F4' }}>
        G
      </span>
    </div>
  )
}

function SectionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition ${
        active
          ? 'bg-blue-50 text-blue-700 border border-blue-100'
          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
      }`}
    >
      <span className="h-5 w-5">{icon}</span>
      {label}
    </button>
  )
}

function UtilBar({ value }: { value: number }) {
  const color =
    value >= 90
      ? 'bg-red-500'
      : value >= 75
        ? 'bg-orange-500'
        : value >= 50
          ? 'bg-yellow-500'
          : 'bg-green-500'
  return (
    <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden">
      <div
        className={`h-full ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

function CopyPill({ value }: { value: string }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2">
      <code className="text-xs text-muted-foreground truncate">{value}</code>
      <button
        className="inline-flex items-center justify-center rounded-lg border bg-background px-2 py-1 hover:bg-muted"
        onClick={() => navigator.clipboard?.writeText(value)}
        title="Copy"
      >
        <Copy className="h-4 w-4" />
      </button>
    </div>
  )
}

function PillTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold transition ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="h-4 w-4">{icon}</span>
      {label}
    </button>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] font-semibold text-slate-600 tracking-wide">
      {children}
    </div>
  )
}

/** ✅ Calmer right drawer (GAS-ish typography + softer chips) */
function RightDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/10" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-[440px] bg-white shadow-2xl border-l rounded-l-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-white">
          <div className="font-semibold text-[15px] text-slate-900">
            {title}
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 rounded-lg border bg-white hover:bg-slate-50 flex items-center justify-center"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto h-[calc(100%-64px)]">
          {children}
        </div>
      </div>
    </div>
  )
}

/* =====================================================================================
   ✅ ONLY ADDITION: Entra > Security content + policy drawer (does not touch other views)
   ===================================================================================== */

type CaPolicyState = 'ON' | 'REPORT_ONLY' | 'OFF'
type CaPolicyOrigin = 'MICROSOFT_TEMPLATE' | 'CUSTOM' | 'MICROSOFT_ENFORCED'
type CaPlatform = 'Windows' | 'macOS' | 'iOS' | 'Android' | 'Linux'

type CaAssignmentBlock = {
  include: string[]
  exclude?: string[]
}

type ConditionalAccessPolicy = {
  id: string
  name: string
  state: CaPolicyState
  origin: CaPolicyOrigin
  targetSummary: string
  grantSummary: string
  assignments: {
    usersAndGroups: CaAssignmentBlock
    cloudApps: { include: string[] }
  }
  conditions?: {
    platforms?: CaPlatform[]
  }
  accessControls: {
    grant: string[]
  }
}

const ORIGIN_LABEL: Record<CaPolicyOrigin, string> = {
  MICROSOFT_TEMPLATE: 'Microsoft template',
  CUSTOM: 'Custom',
  MICROSOFT_ENFORCED: 'Microsoft enforced',
}

function StatePill({ state }: { state: CaPolicyState }) {
  if (state === 'ON') {
    return (
      <Badge className="bg-green-50 text-green-700 border border-green-200 uppercase">
        ON
      </Badge>
    )
  }
  if (state === 'REPORT_ONLY') {
    return (
      <Badge className="bg-blue-50 text-blue-700 border border-blue-200 uppercase">
        Report-Only
      </Badge>
    )
  }
  return (
    <Badge className="bg-slate-50 text-slate-600 border border-slate-200 uppercase">
      Off
    </Badge>
  )
}

function OriginPill({ origin }: { origin: CaPolicyOrigin }) {
  if (origin === 'MICROSOFT_ENFORCED') {
    return (
      <Badge className="bg-purple-50 text-purple-700 border border-purple-200">
        {ORIGIN_LABEL[origin]}
      </Badge>
    )
  }
  if (origin === 'MICROSOFT_TEMPLATE') {
    return (
      <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
        {ORIGIN_LABEL[origin]}
      </Badge>
    )
  }
  return (
    <Badge className="bg-white text-slate-700 border border-slate-200">
      {ORIGIN_LABEL[origin]}
    </Badge>
  )
}

function accentBar(p: ConditionalAccessPolicy) {
  if (p.state === 'OFF') return 'bg-slate-200'
  if (p.state === 'REPORT_ONLY') return 'bg-blue-500'
  if (p.grantSummary.toLowerCase().includes('block')) return 'bg-red-500'
  return 'bg-green-500'
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-lg border bg-white px-3 py-1 text-sm text-slate-800">
      {children}
    </span>
  )
}

function DetailCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="w-[110px] text-muted-foreground font-semibold">
        {label}:
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function GrantItem({ text }: { text: string }) {
  const isBlock = text.toLowerCase().includes('block')
  return (
    <div className="rounded-xl border bg-slate-50 px-4 py-3 flex items-center gap-3">
      {isBlock ? (
        <X className="h-5 w-5 text-red-600" />
      ) : (
        <ShieldCheck className="h-5 w-5 text-green-600" />
      )}
      <div
        className={`text-sm font-semibold ${
          isBlock ? 'text-red-700' : 'text-green-700'
        }`}
      >
        {text}
      </div>
    </div>
  )
}

function PolicyDetailsView({ policy }: { policy: ConditionalAccessPolicy }) {
  return (
    <div className="space-y-8">
      <div>
        <div className="text-2xl font-bold tracking-tight">{policy.name}</div>
        <div className="mt-2 flex items-center gap-2">
          <Badge className="bg-blue-50 text-blue-700 border border-blue-200">
            State:{' '}
            {policy.state === 'REPORT_ONLY'
              ? 'Report-Only'
              : policy.state === 'ON'
                ? 'On'
                : 'Off'}
          </Badge>
          <OriginPill origin={policy.origin} />
        </div>
      </div>

      <div>
        <div className="text-[12px] font-semibold text-slate-500 tracking-[0.20em]">
          ASSIGNMENTS
        </div>
        <div className="mt-4 space-y-4">
          <DetailCard title="Users and Groups">
            <div className="space-y-2 text-sm">
              <Row label="Include">
                {policy.assignments.usersAndGroups.include.map((x) => (
                  <Chip key={x}>{x}</Chip>
                ))}
              </Row>

              {policy.assignments.usersAndGroups.exclude?.length ? (
                <Row label="Exclude">
                  {policy.assignments.usersAndGroups.exclude!.map((x) => (
                    <Chip key={x}>{x}</Chip>
                  ))}
                </Row>
              ) : null}
            </div>
          </DetailCard>

          <DetailCard title="Cloud Apps or Actions">
            <Row label="Include">
              {policy.assignments.cloudApps.include.map((x) => (
                <Chip key={x}>{x}</Chip>
              ))}
            </Row>
          </DetailCard>

          <DetailCard title="Conditions">
            <div className="space-y-3 text-sm">
              {policy.conditions?.platforms?.length ? (
                <Row label="Platforms">
                  <span className="text-slate-800">
                    {policy.conditions.platforms.join(' ')}
                  </span>
                </Row>
              ) : (
                <Row label="Platforms">
                  <span className="text-muted-foreground">Not configured</span>
                </Row>
              )}
            </div>
          </DetailCard>
        </div>
      </div>

      <div>
        <div className="text-[12px] font-semibold text-slate-500 tracking-[0.20em]">
          ACCESS CONTROLS
        </div>

        <div className="mt-4 space-y-4">
          <DetailCard title="Grant">
            <div className="space-y-2">
              {policy.accessControls.grant.map((g) => (
                <GrantItem key={g} text={g} />
              ))}
            </div>
          </DetailCard>
        </div>
      </div>
    </div>
  )
}

/* ================================
   ✅ Named Locations (scalable)
   ================================ */

type NamedLocationType = 'TRUSTED' | 'BLOCKED'

type NamedLocation = {
  id: string
  name: string
  type: NamedLocationType
  addresses: string[]
}

const NAMED_LOCATIONS: NamedLocation[] = [
  {
    id: 'nl-1',
    name: 'Corporate HQ',
    type: 'TRUSTED',
    addresses: ['203.0.113.0/24'],
  },
  {
    id: 'nl-2',
    name: 'Branch Office - NY',
    type: 'TRUSTED',
    addresses: ['198.51.100.0/24'],
  },
  {
    id: 'nl-3',
    name: 'VPN Exit Nodes',
    type: 'TRUSTED',
    addresses: ['192.0.2.0/24', '192.0.2.128/25'],
  },
  {
    id: 'nl-4',
    name: 'Blocked Countries',
    type: 'BLOCKED',
    addresses: ['North Korea', 'Iran', 'Russia', 'Syria'],
  },
]

function NamedLocationsCard({ locations }: { locations: NamedLocation[] }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'ALL' | NamedLocationType>('ALL')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return locations.filter((l) => {
      if (filter !== 'ALL' && l.type !== filter) return false
      if (!q) return true
      const hay = `${l.name} ${l.addresses.join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [locations, query, filter])

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="font-semibold">Named Locations</div>

          <div className="flex gap-2">
            <Button
              variant={filter === 'ALL' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('ALL')}
            >
              All
            </Button>
            <Button
              variant={filter === 'TRUSTED' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('TRUSTED')}
            >
              Trusted
            </Button>
            <Button
              variant={filter === 'BLOCKED' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('BLOCKED')}
            >
              Blocked
            </Button>
          </div>
        </div>

        <div className="mt-4 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, IP, CIDR, country…"
            className="pl-10"
          />
        </div>

        <div className="mt-4 max-h-[420px] overflow-y-auto space-y-3">
          {filtered.map((l) => (
            <div key={l.id} className="rounded-xl border bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm">{l.name}</div>
                <Badge
                  className={
                    l.type === 'TRUSTED'
                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }
                >
                  {l.type === 'TRUSTED' ? 'Trusted' : 'Blocked'}
                </Badge>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {l.addresses.map((a: any) => (
                  <code
                    key={a}
                    className="rounded-lg border bg-white px-2 py-1 text-xs text-muted-foreground"
                  >
                    {a}
                  </code>
                ))}
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-6">
              No named locations found.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/* ================================
   ✅ Authentication Methods (UI)
   ================================ */

type AuthMethodRow = {
  id: string
  name: string
  target: string
  status: 'ENABLED' | 'DISABLED'
}

function AuthMethodsCard({ rows }: { rows: AuthMethodRow[] }) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-6">
        <div className="font-semibold">Authentication Methods</div>

        <div className="mt-4 space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between"
            >
              <div>
                <div className="text-sm font-semibold">{r.name}</div>
                <div className="text-xs text-muted-foreground">
                  Target: {r.target}
                </div>
              </div>

              <Badge
                className={
                  r.status === 'ENABLED'
                    ? 'bg-green-50 text-green-700 border border-green-200 uppercase'
                    : 'bg-slate-50 text-slate-600 border border-slate-200 uppercase'
                }
              >
                {r.status}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/* ===================================================================================== */

export default function TenantDetailsPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const tenantId = params?.id

  const bundle = useMemo<TenantMockBundle | null>(() => {
    if (!tenantId) return null
    return getMockTenant(tenantId)
  }, [tenantId])

  const tenant = useMemo(
    () => bundle?.tenant ?? TENANTS.find((t: any) => t.id === tenantId),
    [bundle, tenantId]
  )

  // ✅ JSON/TS-backed datasets (per-tenant)
  const USERS = (bundle?.users ?? []) as TenantUser[]
  const SIGNINS = (bundle?.signIns ?? []) as SignInEvent[]

  const EXCHANGE_MAILBOXES = (bundle?.exchange?.mailboxes ?? []) as Mailbox[]
  const EXCHANGE_RULES = (bundle?.exchange?.rules ?? []) as MailRule[]
  const EXCHANGE_DOMAINS = (bundle?.exchange?.acceptedDomains ??
    []) as AcceptedDomain[]
  const EXCHANGE_GROUPS = (bundle?.exchange?.groups ?? []) as MailGroup[]

  // SharePoint (safe default so UI never crashes)
  const SP_OVERVIEW = (bundle?.sharepoint?.overview ?? {
    totalSites: 0,
    totalStorageQuotaGB: 0,
    oneDriveStorageLimitGB: 0,
    siteStorageLimitsMode: 'Automatic',
    sharingSharePoint: 'ONLY_PEOPLE_IN_ORG',
    sharingOneDrive: 'ONLY_PEOPLE_IN_ORG',
  }) as any

  const SP_SITES = (bundle?.sharepoint?.sites ?? []) as any[]
  const SP_DELETED_SITES = (bundle?.sharepoint?.deletedSites ?? []) as any[]

  const TEAMS = (bundle?.teams ?? {}) as any

  const [section, setSection] = useState<TenantSection>('home')

  // Entra UI state
  const [entraTab, setEntraTab] = useState<EntraTab>('overview')
  const [userSearch, setUserSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState<TenantUser | null>(null)

  // ✅ Exchange drawer state
  const [selectedMailbox, setSelectedMailbox] = useState<Mailbox | null>(null)
  const [selectedRule, setSelectedRule] = useState<MailRule | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<MailGroup | null>(null)

  // ✅ policy drawer state (only used in Entra > Security)
  const [selectedPolicy, setSelectedPolicy] =
    useState<ConditionalAccessPolicy | null>(null)

  // Tenant dropdown
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false)
  const [tenantSearch, setTenantSearch] = useState('')

  // Refresh button state (fake)
  const [syncState, setSyncState] = useState<
    'idle' | 'syncing' | 'success' | 'fail'
  >('idle')

  // Domain selector (per tenant)
  const domains = tenant?.domains?.length
    ? tenant.domains
    : tenant?.domain
      ? [tenant.domain]
      : []
  const [domainSelected, setDomainSelected] = useState(domains[0] || '')
  const [domainOpen, setDomainOpen] = useState(false)

  // ✅ fix: when tenant changes, reset domain + close dropdowns/drawer
  useEffect(() => {
    const next =
      (tenant?.domains?.length
        ? tenant.domains
        : tenant?.domain
          ? [tenant.domain]
          : [])[0] || ''
    setDomainSelected(next)
    setDomainOpen(false)
    setTenantSearch('')
    setTenantPickerOpen(false)
    setSelectedUser(null)
    setSelectedPolicy(null)
    setUserSearch('')
    setEntraTab('overview')
    setSection('home')
    setSelectedMailbox(null)
    setSelectedRule(null)
    setSelectedGroup(null)
  }, [tenant?.id])

  if (!tenantId) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-8">
          <div className="text-lg font-semibold">Missing tenant id</div>
          <div className="mt-1 text-sm text-muted-foreground">
            No tenant id was provided in the URL.
          </div>
          <div className="mt-4">
            <Button asChild>
              <Link href="/tenants">Return to Tenant Directory</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!tenant) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-8">
          <div className="text-lg font-semibold">Tenant not found</div>
          <div className="mt-1 text-sm text-muted-foreground">
            The tenant id “{tenantId}” does not exist in mock data.
          </div>
          <div className="mt-4">
            <Button asChild>
              <Link href="/tenants">Return to Tenant Directory</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const isMicrosoft = tenant.provider === 'microsoft'
  const heading =
    isMicrosoft && section === 'entra'
      ? 'Entra ID'
      : isMicrosoft && section === 'exchange'
        ? 'Exchange'
        : isMicrosoft && section === 'teams'
          ? 'Teams'
          : isMicrosoft && section === 'sharepoint'
            ? 'SharePoint'
            : isMicrosoft
              ? 'Office 365'
              : section === 'directory'
                ? 'Directory'
                : section === 'gmail'
                  ? 'Gmail'
                  : section === 'drive'
                    ? 'Drive'
                    : section === 'security'
                      ? 'Security'
                      : 'Workspace'

  const subheading = 'Manage configuration and view reports.'

  const navItems = isMicrosoft
    ? [
        {
          key: 'home' as const,
          label: 'Office 365',
          icon: <ShieldCheck className="h-5 w-5" />,
        },
        {
          key: 'entra' as const,
          label: 'Entra ID',
          icon: <Users className="h-5 w-5" />,
        },
        {
          key: 'exchange' as const,
          label: 'Exchange',
          icon: <Mail className="h-5 w-5" />,
        },
        {
          key: 'sharepoint' as const,
          label: 'SharePoint/OneDrive',
          icon: <HardDrive className="h-5 w-5" />,
        },
        {
          key: 'teams' as const,
          label: 'Teams',
          icon: <Users className="h-5 w-5" />,
          disabled: true,
        },
      ]
    : [
        {
          key: 'workspace' as const,
          label: 'Workspace',
          icon: <ShieldCheck className="h-5 w-5" />,
        },
        {
          key: 'directory' as const,
          label: 'Directory',
          icon: <Users className="h-5 w-5" />,
        },
        {
          key: 'gmail' as const,
          label: 'Gmail',
          icon: <Mail className="h-5 w-5" />,
        },
        {
          key: 'drive' as const,
          label: 'Drive',
          icon: <HardDrive className="h-5 w-5" />,
        },
        {
          key: 'security' as const,
          label: 'Security',
          icon: <ShieldCheck className="h-5 w-5" />,
        },
      ]

  const licenseRows = isMicrosoft
    ? [
        { name: 'Microsoft 365 Business Premium', used: 124, total: 150 },
        { name: 'Microsoft 365 E5 Security', used: 10, total: 20 },
        { name: 'Microsoft Teams Phone Standard', used: 45, total: 50 },
        { name: 'Power BI Pro', used: 5, total: 5 },
      ]
    : [
        { name: 'Google Workspace Business Standard', used: 45, total: 50 },
        { name: 'Google Workspace Enterprise Plus', used: 5, total: 10 },
        { name: 'Cloud Identity Premium', used: 10, total: 100 },
      ]

  const spf = bundle?.dns?.spf ?? '—'
  const dkim = bundle?.dns?.dkim ?? '—'
  const dmarc = bundle?.dns?.dmarc ?? '—'

  function runSync() {
    if (syncState === 'syncing') return
    setSyncState('syncing')
    window.setTimeout(() => {
      const ok = Math.random() > 0.15
      setSyncState(ok ? 'success' : 'fail')
      window.setTimeout(() => setSyncState('idle'), 1400)
    }, 900)
  }

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase()
    if (!q) return USERS
    return USERS.filter(
      (u) =>
        u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    )
  }, [userSearch])

  const filteredTenants = useMemo(() => {
    const q = tenantSearch.trim().toLowerCase()
    if (!q) return TENANTS
    return TENANTS.filter(
      (t: any) =>
        t.name.toLowerCase().includes(q) ||
        t.domain.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
    )
  }, [tenantSearch])

  // ✅ Entra > Security mock policies
  const caPolicies: ConditionalAccessPolicy[] = useMemo(
    () => [
      {
        id: 'ca-1',
        name: 'Require MFA for Administrators',
        state: 'ON',
        origin: 'MICROSOFT_TEMPLATE',
        targetSummary: 'Multiple Users',
        grantSummary: 'Require multifactor authentication',
        assignments: {
          usersAndGroups: {
            include: ['Directory roles: Global Administrator'],
          },
          cloudApps: { include: ['All Cloud Apps'] },
        },
        conditions: { platforms: ['Windows', 'macOS', 'iOS', 'Android'] },
        accessControls: { grant: ['Require multifactor authentication'] },
      },
      {
        id: 'ca-2',
        name: 'Block Legacy Authentication',
        state: 'ON',
        origin: 'MICROSOFT_ENFORCED',
        targetSummary: 'All Users',
        grantSummary: 'Block access',
        assignments: {
          usersAndGroups: { include: ['All Users'] },
          cloudApps: { include: ['All Cloud Apps'] },
        },
        accessControls: { grant: ['Block access'] },
      },
      {
        id: 'ca-3',
        name: 'Require Compliant Devices for All Users',
        state: 'REPORT_ONLY',
        origin: 'CUSTOM',
        targetSummary: 'All Users',
        grantSummary: 'Require device to be marked as compliant',
        assignments: {
          usersAndGroups: { include: ['All Users'], exclude: ['Guest Users'] },
          cloudApps: { include: ['All Cloud Apps'] },
        },
        conditions: { platforms: ['Windows', 'macOS', 'iOS', 'Android'] },
        accessControls: { grant: ['Require device to be marked as compliant'] },
      },
      {
        id: 'ca-4',
        name: 'Block Access from High Risk Countries',
        state: 'ON',
        origin: 'CUSTOM',
        targetSummary: 'All Users',
        grantSummary: 'Block access',
        assignments: {
          usersAndGroups: { include: ['All Users'] },
          cloudApps: { include: ['All Cloud Apps'] },
        },
        accessControls: { grant: ['Block access'] },
      },
    ],
    []
  )

  const authMethods: AuthMethodRow[] = useMemo(
    () => [
      {
        id: 'am-1',
        name: 'Microsoft Authenticator',
        target: 'All Users',
        status: 'ENABLED',
      },
      {
        id: 'am-2',
        name: 'FIDO2 Security Key',
        target: 'Select Groups (IT, Execs)',
        status: 'ENABLED',
      },
      { id: 'am-3', name: 'SMS', target: 'None', status: 'DISABLED' },
      { id: 'am-4', name: 'Voice Call', target: 'None', status: 'DISABLED' },
      {
        id: 'am-5',
        name: 'Temporary Access Pass',
        target: 'All Users',
        status: 'ENABLED',
      },
      {
        id: 'am-6',
        name: 'Passkeys (Preview)',
        target: 'Pilot Group',
        status: 'DISABLED',
      },
      { id: 'am-7', name: 'Email OTP', target: 'Guests', status: 'ENABLED' },
      {
        id: 'am-8',
        name: 'Hardware OATH Tokens',
        target: 'None',
        status: 'DISABLED',
      },
    ],
    []
  )

  function PlaceholderPage({ title }: { title: string }) {
    return (
      <Card className="rounded-2xl mt-6 shadow-sm">
        <CardContent className="p-6">
          <div className="font-semibold">{title}</div>
          <div className="mt-2 text-sm text-muted-foreground">
            Mock page. We can build this next (tables, charts, drawers, etc).
          </div>
        </CardContent>
      </Card>
    )
  }

  //Exchange shit that you jsut delete was here

  //SharePoint shit that you just deleted was here

  function TeamsPage() {
    // Core daily checks
    const [userQ, setUserQ] = useState('')
    const [userFilter, setUserFilter] = useState<
      'ALL' | 'VOICE_ON' | 'VOICE_OFF' | 'LICENSE_MISSING'
    >('ALL')

    const [policyQ, setPolicyQ] = useState('')
    const [policyType, setPolicyType] = useState<
      'ALL' | 'Messaging' | 'Meeting' | 'Calling'
    >('ALL')

    const [extTenantQ, setExtTenantQ] = useState('')
    const [extTenantFilter, setExtTenantFilter] = useState<
      'ALL' | 'Allowed' | 'Blocked'
    >('ALL')

    const [domainQ, setDomainQ] = useState('')
    const [domainFilter, setDomainFilter] = useState<
      'ALL' | 'Allowed' | 'Blocked'
    >('ALL')

    const [appQ, setAppQ] = useState('')
    const [appFilter, setAppFilter] = useState<'ALL' | 'Allowed' | 'Blocked'>(
      'ALL'
    )

    // Voice
    const [phoneQ, setPhoneQ] = useState('')
    const [phoneFilter, setPhoneFilter] = useState<
      'ALL' | 'Assigned' | 'Unassigned' | 'Resource'
    >('ALL')

    // Governance
    const [teamQ, setTeamQ] = useState('')
    const [teamFilter, setTeamFilter] = useState<
      'ALL' | 'INACTIVE' | 'OWNERS_LT_2' | 'PRIVATE_SPRAWL'
    >('ALL')

    // ---------- Mock “Teams Admin” shaped data (additive, does not affect other tabs) ----------
    type TeamsUserRow = {
      id: string
      name: string
      upn: string
      license: 'OK' | 'Missing'
      voice: 'Enabled' | 'Disabled'
      messagingPolicy: string
      meetingPolicy: string
      callingPolicy: string
    }

    const TEAMS_USERS: TeamsUserRow[] = useMemo(
      () => [
        {
          id: 'tu-1',
          name: 'Alex Greene',
          upn: 'alex.g@client.com',
          license: 'OK',
          voice: 'Enabled',
          messagingPolicy: 'Global',
          meetingPolicy: 'Secure Meetings',
          callingPolicy: 'Calling - Standard',
        },
        {
          id: 'tu-2',
          name: 'Sarah Parker',
          upn: 'sarah.p@client.com',
          license: 'OK',
          voice: 'Disabled',
          messagingPolicy: 'Global',
          meetingPolicy: 'Secure Meetings',
          callingPolicy: 'Calling - Standard',
        },
        {
          id: 'tu-3',
          name: 'External Auditor',
          upn: 'audit@firm.com',
          license: 'Missing',
          voice: 'Disabled',
          messagingPolicy: 'External - Restricted',
          meetingPolicy: 'Guest Meetings - Limited',
          callingPolicy: 'N/A',
        },
        {
          id: 'tu-4',
          name: 'Service Account',
          upn: 'svc-backup@client.com',
          license: 'Missing',
          voice: 'Disabled',
          messagingPolicy: 'N/A',
          meetingPolicy: 'N/A',
          callingPolicy: 'N/A',
        },
      ],
      []
    )

    type TeamsPolicyRow = {
      id: string
      type: 'Messaging' | 'Meeting' | 'Calling'
      name: string
      risk: 'Low' | 'Medium' | 'High'
      highlights: string[]
    }

    const TEAMS_POLICIES: TeamsPolicyRow[] = useMemo(
      () => [
        {
          id: 'tp-1',
          type: 'Messaging',
          name: 'Global',
          risk: 'Medium',
          highlights: [
            'Allow Giphy: On',
            'Chat with external: On',
            'Delete messages: Allowed',
          ],
        },
        {
          id: 'tp-2',
          type: 'Messaging',
          name: 'External - Restricted',
          risk: 'Low',
          highlights: [
            'External chat: Blocked',
            'Giphy: Off',
            'Edit/Delete: Blocked',
          ],
        },
        {
          id: 'tp-3',
          type: 'Meeting',
          name: 'Secure Meetings',
          risk: 'Low',
          highlights: [
            'Anonymous join: Blocked',
            'Recording: Allowed',
            'Lobby: Org only',
          ],
        },
        {
          id: 'tp-4',
          type: 'Meeting',
          name: 'Guest Meetings - Limited',
          risk: 'Medium',
          highlights: [
            'Anonymous join: Allowed',
            'Recording: Blocked',
            'Lobby: Everyone',
          ],
        },
        {
          id: 'tp-5',
          type: 'Calling',
          name: 'Calling - Standard',
          risk: 'Medium',
          highlights: [
            'International: Allowed',
            'Voicemail transcription: On',
            'Call forwarding: Allowed',
          ],
        },
        {
          id: 'tp-6',
          type: 'Calling',
          name: 'Calling - Restricted',
          risk: 'Low',
          highlights: [
            'International: Blocked',
            'Forwarding: Blocked',
            'Delegation: Restricted',
          ],
        },
      ],
      []
    )

    type PhoneNumberRow = {
      id: string
      number: string
      type: 'User' | 'Resource'
      assignedTo?: string
      location: string
      status: 'Assigned' | 'Unassigned'
    }

    const PHONE_NUMBERS: PhoneNumberRow[] = useMemo(
      () => [
        {
          id: 'pn-1',
          number: '+1 (416) 555-0101',
          type: 'User',
          assignedTo: 'Alex Greene',
          location: 'Toronto HQ',
          status: 'Assigned',
        },
        {
          id: 'pn-2',
          number: '+1 (416) 555-0102',
          type: 'User',
          assignedTo: 'Sarah Parker',
          location: 'Toronto HQ',
          status: 'Assigned',
        },
        {
          id: 'pn-3',
          number: '+1 (416) 555-0199',
          type: 'Resource',
          assignedTo: 'Main Auto Attendant',
          location: 'Toronto HQ',
          status: 'Assigned',
        },
        {
          id: 'pn-4',
          number: '+1 (416) 555-0120',
          type: 'User',
          location: 'Toronto HQ',
          status: 'Unassigned',
        },
        {
          id: 'pn-5',
          number: '+1 (212) 555-0133',
          type: 'Resource',
          assignedTo: 'Support Call Queue',
          location: 'NY Branch',
          status: 'Assigned',
        },
      ],
      []
    )

    type EmergencyLocationRow = {
      id: string
      name: string
      address: string
      status: 'Configured' | 'Missing'
    }

    const EMERGENCY_LOCATIONS: EmergencyLocationRow[] = useMemo(
      () => [
        {
          id: 'el-1',
          name: 'Toronto HQ',
          address: '100 King St W, Toronto, ON',
          status: 'Configured',
        },
        {
          id: 'el-2',
          name: 'NY Branch',
          address: '5th Ave, New York, NY',
          status: 'Configured',
        },
        {
          id: 'el-3',
          name: 'Remote Workers',
          address: 'Dynamic / Not set',
          status: 'Missing',
        },
      ],
      []
    )

    type TeamRow = {
      id: string
      name: string
      visibility: 'Public' | 'Private'
      owners: number
      members: number
      channels: { standard: number; private: number; shared: number }
      lastActivity: string
      sharePointGB: number
    }

    const TEAMS_LIST: TeamRow[] = useMemo(
      () => [
        {
          id: 't-1',
          name: 'All Employees',
          visibility: 'Public',
          owners: 3,
          members: 240,
          channels: { standard: 12, private: 1, shared: 0 },
          lastActivity: 'Today',
          sharePointGB: 420,
        },
        {
          id: 't-2',
          name: 'IT Operations',
          visibility: 'Private',
          owners: 1,
          members: 18,
          channels: { standard: 8, private: 6, shared: 2 },
          lastActivity: '3 days ago',
          sharePointGB: 95,
        },
        {
          id: 't-3',
          name: 'Old Project Phoenix',
          visibility: 'Private',
          owners: 1,
          members: 14,
          channels: { standard: 3, private: 7, shared: 0 },
          lastActivity: '92 days ago',
          sharePointGB: 160,
        },
        {
          id: 't-4',
          name: 'Marketing Archive',
          visibility: 'Public',
          owners: 0,
          members: 8,
          channels: { standard: 2, private: 0, shared: 0 },
          lastActivity: '188 days ago',
          sharePointGB: 38,
        },
      ],
      []
    )

    // Use your existing Exchange mock if present; otherwise we keep it local & safe:
    const extTenants = useMemo(() => {
      const q = extTenantQ.trim().toLowerCase()
      const base = TEAMS?.externalAccess?.allowedTenants ?? []
      return base
        .filter((t: any) =>
          extTenantFilter === 'ALL' ? true : t.status === extTenantFilter
        )
        .filter((t: any) => {
          if (!q) return true
          return `${t.tenantName} ${t.tenantId}`.toLowerCase().includes(q)
        })
    }, [extTenantQ, extTenantFilter])

    const extDomains = useMemo(() => {
      const q = domainQ.trim().toLowerCase()
      const base = TEAMS?.externalAccess?.allowedDomains ?? []
      return base
        .filter((d: any) =>
          domainFilter === 'ALL' ? true : d.status === domainFilter
        )
        .filter((d: any) =>
          !q ? true : `${d.domain}`.toLowerCase().includes(q)
        )
    }, [domainQ, domainFilter])

    const usersFiltered = useMemo(() => {
      const q = userQ.trim().toLowerCase()
      return TEAMS_USERS.filter((u) => {
        if (userFilter === 'VOICE_ON' && u.voice !== 'Enabled') return false
        if (userFilter === 'VOICE_OFF' && u.voice !== 'Disabled') return false
        if (userFilter === 'LICENSE_MISSING' && u.license !== 'Missing')
          return false
        if (!q) return true
        return `${u.name} ${u.upn} ${u.messagingPolicy} ${u.meetingPolicy} ${u.callingPolicy}`
          .toLowerCase()
          .includes(q)
      })
    }, [TEAMS_USERS, userQ, userFilter])

    const policiesFiltered = useMemo(() => {
      const q = policyQ.trim().toLowerCase()
      return TEAMS_POLICIES.filter((p) =>
        policyType === 'ALL' ? true : p.type === policyType
      ).filter((p) => {
        if (!q) return true
        return `${p.name} ${p.type} ${p.highlights.join(' ')}`
          .toLowerCase()
          .includes(q)
      })
    }, [TEAMS_POLICIES, policyQ, policyType])

    const appsFiltered = useMemo(() => {
      const base = TEAMS?.apps?.highRiskApps ?? []
      const q = appQ.trim().toLowerCase()
      return base
        .filter((a: any) =>
          appFilter === 'ALL' ? true : a.status === appFilter
        )
        .filter((a: any) =>
          !q ? true : `${a.name} ${a.reason}`.toLowerCase().includes(q)
        )
    }, [appQ, appFilter])

    const phonesFiltered = useMemo(() => {
      const q = phoneQ.trim().toLowerCase()
      return PHONE_NUMBERS.filter((p) => {
        if (phoneFilter === 'Assigned' && p.status !== 'Assigned') return false
        if (phoneFilter === 'Unassigned' && p.status !== 'Unassigned')
          return false
        if (phoneFilter === 'Resource' && p.type !== 'Resource') return false
        if (!q) return true
        return `${p.number} ${p.assignedTo ?? ''} ${p.location} ${p.type}`
          .toLowerCase()
          .includes(q)
      })
    }, [PHONE_NUMBERS, phoneQ, phoneFilter])

    const teamsFiltered = useMemo(() => {
      const q = teamQ.trim().toLowerCase()
      return TEAMS_LIST.filter((t: any) => {
        if (teamFilter === 'INACTIVE') {
          const days = t.lastActivity.includes('days')
            ? Number(t.lastActivity.split(' ')[0])
            : 0
          if (!(days >= 90)) return false
        }
        if (teamFilter === 'OWNERS_LT_2' && !(t.owners < 2)) return false
        if (teamFilter === 'PRIVATE_SPRAWL' && !(t.channels.private >= 5))
          return false
        if (!q) return true
        return `${t.name} ${t.visibility} ${t.lastActivity}`
          .toLowerCase()
          .includes(q)
      })
    }, [TEAMS_LIST, teamQ, teamFilter])

    const riskPill = (risk: 'Low' | 'Medium' | 'High') =>
      risk === 'Low'
        ? 'bg-green-50 text-green-700 border border-green-200'
        : risk === 'Medium'
          ? 'bg-orange-50 text-orange-700 border border-orange-200'
          : 'bg-red-50 text-red-700 border border-red-200'

    const allowPill = (status: 'Allowed' | 'Blocked') =>
      status === 'Allowed'
        ? 'bg-green-50 text-green-700 border border-green-200'
        : 'bg-red-50 text-red-700 border border-red-200'

    return (
      <div className="mt-6 space-y-6">
        {/* Compact summary row (not crowded) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Daily security gaps
                  </div>
                  <div className="mt-1 text-2xl font-bold">
                    {usersFiltered.filter((u) => u.license === 'Missing')
                      .length +
                      TEAMS_POLICIES.filter((p) => p.risk === 'High').length}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Missing license + high-risk policies
                  </div>
                </div>
                <div className="h-10 w-10 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center">
                  <Shield className="h-5 w-5 text-amber-700" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    License waste
                  </div>
                  <div className="mt-1 text-2xl font-bold">
                    {
                      usersFiltered.filter((u) => u.license === 'Missing')
                        .length
                    }
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Accounts without Teams-ready license
                  </div>
                </div>
                <div className="h-10 w-10 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center">
                  <Activity className="h-5 w-5 text-blue-700" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Guest/external exposure
                  </div>
                  <div className="mt-1 text-2xl font-bold">
                    {(TEAMS?.stats?.guestUsers ?? 0) +
                      (TEAMS?.stats?.externalUsers ?? 0)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Guests + external participants
                  </div>
                </div>
                <div className="h-10 w-10 rounded-2xl bg-purple-50 border border-purple-100 flex items-center justify-center">
                  <Users className="h-5 w-5 text-purple-700" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Teams sprawl risk
                  </div>
                  <div className="mt-1 text-2xl font-bold">
                    {
                      teamsFiltered.filter(
                        (t: any) =>
                          t.owners < 2 || t.lastActivity.includes('days')
                      ).length
                    }
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Owners & inactivity flags
                  </div>
                </div>
                <div className="h-10 w-10 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                  <Layers className="h-5 w-5 text-emerald-700" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Core daily checks */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* Users */}
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold">Users (daily checks)</div>
                  <div className="text-sm text-muted-foreground">
                    License, policies, and voice status (Teams-facing view).
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={userFilter}
                    onChange={(e) => setUserFilter(e.target.value as any)}
                    className="rounded-xl border px-3 py-2 text-sm bg-white"
                  >
                    <option value="ALL">All</option>
                    <option value="VOICE_ON">Voice enabled</option>
                    <option value="VOICE_OFF">Voice disabled</option>
                    <option value="LICENSE_MISSING">License missing</option>
                  </select>

                  <div className="relative w-[240px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={userQ}
                      onChange={(e) => setUserQ(e.target.value)}
                      placeholder="Search users..."
                      className="pl-10"
                    />
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-muted-foreground bg-muted/30">
                    <tr>
                      <th className="px-4 py-3 text-left">User</th>
                      <th className="px-4 py-3 text-left">License</th>
                      <th className="px-4 py-3 text-left">Voice</th>
                      <th className="px-4 py-3 text-left">Policies</th>
                    </tr>
                  </thead>
                </table>
                <div className="max-h-[320px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {usersFiltered.map((u) => (
                        <tr key={u.id} className="border-b hover:bg-muted/20">
                          <td className="px-4 py-3">
                            <div className="font-semibold">{u.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {u.upn}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge
                              className={
                                u.license === 'OK'
                                  ? 'bg-green-50 text-green-700 border border-green-200'
                                  : 'bg-red-50 text-red-700 border border-red-200'
                              }
                            >
                              {u.license}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <Badge
                              className={
                                u.voice === 'Enabled'
                                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                  : 'bg-slate-50 text-slate-600 border border-slate-200'
                              }
                            >
                              {u.voice}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            <div>
                              Msg:{' '}
                              <span className="text-slate-700 font-semibold">
                                {u.messagingPolicy}
                              </span>
                            </div>
                            <div>
                              Mtg:{' '}
                              <span className="text-slate-700 font-semibold">
                                {u.meetingPolicy}
                              </span>
                            </div>
                            <div>
                              Call:{' '}
                              <span className="text-slate-700 font-semibold">
                                {u.callingPolicy}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {usersFiltered.length === 0 && (
                        <tr>
                          <td
                            colSpan={4}
                            className="px-4 py-6 text-center text-muted-foreground"
                          >
                            No users match filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Policies */}
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold">Teams policies</div>
                  <div className="text-sm text-muted-foreground">
                    Messaging, meeting, and calling restrictions.
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={policyType}
                    onChange={(e) => setPolicyType(e.target.value as any)}
                    className="rounded-xl border px-3 py-2 text-sm bg-white"
                  >
                    <option value="ALL">All</option>
                    <option value="Messaging">Messaging</option>
                    <option value="Meeting">Meeting</option>
                    <option value="Calling">Calling</option>
                  </select>

                  <div className="relative w-[240px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={policyQ}
                      onChange={(e) => setPolicyQ(e.target.value)}
                      placeholder="Search policies..."
                      className="pl-10"
                    />
                  </div>
                </div>
              </div>

              <div className="mt-4 max-h-[360px] overflow-y-auto space-y-3">
                {policiesFiltered.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-xl border bg-muted/20 px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {p.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {p.type} policy
                        </div>
                      </div>
                      <Badge className={riskPill(p.risk)}>{p.risk}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {p.highlights.slice(0, 3).map((h) => (
                        <Badge
                          key={h}
                          className="bg-white text-slate-700 border border-slate-200"
                        >
                          {h}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
                {policiesFiltered.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    No policies found.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* External / Apps / Voice / Governance */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* External & Guest Access */}
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="font-semibold">
                External access / Guest access
              </div>
              <div className="text-sm text-muted-foreground">
                Whitelists/blocks are controls — still review exposure.
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4">
                <div className="rounded-2xl border bg-white p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-sm font-semibold">
                      Tenant allow/block list
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={extTenantFilter}
                        onChange={(e) =>
                          setExtTenantFilter(e.target.value as any)
                        }
                        className="rounded-xl border px-3 py-2 text-sm bg-white"
                      >
                        <option value="ALL">All</option>
                        <option value="Allowed">Allowed</option>
                        <option value="Blocked">Blocked</option>
                      </select>
                      <div className="relative w-[220px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          value={extTenantQ}
                          onChange={(e) => setExtTenantQ(e.target.value)}
                          placeholder="Search tenants..."
                          className="pl-10"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 max-h-[220px] overflow-y-auto space-y-2">
                    {extTenants.map((t: any) => (
                      <div
                        key={t.tenantId}
                        className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {t.tenantName}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {t.tenantId}
                          </div>
                        </div>
                        <Badge className={allowPill(t.status)}>
                          {t.status}
                        </Badge>
                      </div>
                    ))}
                    {extTenants.length === 0 && (
                      <div className="text-sm text-muted-foreground text-center py-6">
                        No tenants found.
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border bg-white p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-sm font-semibold">
                      Allowed/blocked domains
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={domainFilter}
                        onChange={(e) => setDomainFilter(e.target.value as any)}
                        className="rounded-xl border px-3 py-2 text-sm bg-white"
                      >
                        <option value="ALL">All</option>
                        <option value="Allowed">Allowed</option>
                        <option value="Blocked">Blocked</option>
                      </select>
                      <div className="relative w-[220px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          value={domainQ}
                          onChange={(e) => setDomainQ(e.target.value)}
                          placeholder="Search domains..."
                          className="pl-10"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 max-h-[200px] overflow-y-auto space-y-2">
                    {extDomains.map((d: any) => (
                      <div
                        key={d.domain}
                        className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between"
                      >
                        <div className="text-sm font-semibold">{d.domain}</div>
                        <Badge className={allowPill(d.status)}>
                          {d.status}
                        </Badge>
                      </div>
                    ))}
                    {extDomains.length === 0 && (
                      <div className="text-sm text-muted-foreground text-center py-6">
                        No domains found.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Apps governance + meeting highlights */}
          <div className="space-y-6">
            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-semibold">Teams apps</div>
                    <div className="text-sm text-muted-foreground">
                      Allowed/blocked apps + high-risk third-party apps.
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={appFilter}
                      onChange={(e) => setAppFilter(e.target.value as any)}
                      className="rounded-xl border px-3 py-2 text-sm bg-white"
                    >
                      <option value="ALL">All</option>
                      <option value="Allowed">Allowed</option>
                      <option value="Blocked">Blocked</option>
                    </select>

                    <div className="relative w-[220px]">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        value={appQ}
                        onChange={(e) => setAppQ(e.target.value)}
                        placeholder="Search apps..."
                        className="pl-10"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge className="bg-blue-50 text-blue-700 border border-blue-200">
                    Allowed {TEAMS?.apps?.allowedAppsCount ?? 0}
                  </Badge>
                  <Badge className="bg-red-50 text-red-700 border border-red-200">
                    Blocked {TEAMS?.apps?.blockedAppsCount ?? 0}
                  </Badge>
                  <Badge className="bg-purple-50 text-purple-700 border border-purple-200">
                    Custom {TEAMS?.apps?.customAppsCount ?? 0}
                  </Badge>
                </div>

                <div className="mt-4 max-h-[280px] overflow-y-auto space-y-3">
                  {appsFiltered.map((a: any) => (
                    <div
                      key={a.name}
                      className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {a.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {a.reason}
                        </div>
                      </div>
                      <Badge className={allowPill(a.status)}>{a.status}</Badge>
                    </div>
                  ))}
                  {appsFiltered.length === 0 && (
                    <div className="text-sm text-muted-foreground text-center py-6">
                      No apps found.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Meeting policy highlights (compact) */}
            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-6">
                <div className="font-semibold">Meeting policies (headline)</div>
                <div className="text-sm text-muted-foreground">
                  Recording, lobby, and guest/anonymous controls.
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge
                    className={
                      (TEAMS?.meetingSettings?.anonymousJoin ?? 'Blocked') ===
                      'Blocked'
                        ? 'bg-green-50 text-green-700 border border-green-200'
                        : 'bg-orange-50 text-orange-700 border border-orange-200'
                    }
                  >
                    Anonymous join:{' '}
                    {TEAMS?.meetingSettings?.anonymousJoin ?? '—'}
                  </Badge>

                  <Badge
                    className={
                      (TEAMS?.meetingSettings?.cloudRecording ?? 'Blocked') ===
                      'Allowed'
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : 'bg-slate-50 text-slate-600 border border-slate-200'
                    }
                  >
                    Recording: {TEAMS?.meetingSettings?.cloudRecording ?? '—'}
                  </Badge>

                  <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
                    Lobby: {TEAMS?.meetingSettings?.lobbyBypass ?? '—'}
                  </Badge>

                  <Badge
                    className={
                      (TEAMS?.meetingSettings?.transcription ?? 'Blocked') ===
                      'Allowed'
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : 'bg-slate-50 text-slate-600 border border-slate-200'
                    }
                  >
                    Transcription:{' '}
                    {TEAMS?.meetingSettings?.transcription ?? '—'}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Voice + Governance/Health */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* Voice */}
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold">Voice (Teams Phone)</div>
                  <div className="text-sm text-muted-foreground">
                    Numbers, calling policies, routing, and emergency locations.
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Total numbers {TEAMS?.phone?.totalNumbers ?? 0}
                  </Badge>
                  <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
                    Auto attendants {TEAMS?.phone?.autoAttendants ?? 0}
                  </Badge>
                  <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
                    Call queues {TEAMS?.phone?.callQueues ?? 0}
                  </Badge>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border bg-white p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm font-semibold">Phone numbers</div>

                  <div className="flex items-center gap-2">
                    <select
                      value={phoneFilter}
                      onChange={(e) => setPhoneFilter(e.target.value as any)}
                      className="rounded-xl border px-3 py-2 text-sm bg-white"
                    >
                      <option value="ALL">All</option>
                      <option value="Assigned">Assigned</option>
                      <option value="Unassigned">Unassigned</option>
                      <option value="Resource">Resource</option>
                    </select>

                    <div className="relative w-[220px]">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        value={phoneQ}
                        onChange={(e) => setPhoneQ(e.target.value)}
                        placeholder="Search numbers..."
                        className="pl-10"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 max-h-[240px] overflow-y-auto space-y-2">
                  {phonesFiltered.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{p.number}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {p.location} • {p.type}
                          {p.assignedTo ? ` • ${p.assignedTo}` : ''}
                        </div>
                      </div>
                      <Badge
                        className={
                          p.status === 'Assigned'
                            ? 'bg-green-50 text-green-700 border border-green-200'
                            : 'bg-orange-50 text-orange-700 border border-orange-200'
                        }
                      >
                        {p.status}
                      </Badge>
                    </div>
                  ))}

                  {phonesFiltered.length === 0 && (
                    <div className="text-sm text-muted-foreground text-center py-6">
                      No numbers found.
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold">Emergency locations</div>
                <div className="mt-3 space-y-2">
                  {EMERGENCY_LOCATIONS.map((l) => (
                    <div
                      key={l.id}
                      className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {l.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {l.address}
                        </div>
                      </div>
                      <Badge
                        className={
                          l.status === 'Configured'
                            ? 'bg-green-50 text-green-700 border border-green-200'
                            : 'bg-red-50 text-red-700 border border-red-200'
                        }
                      >
                        {l.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Governance & health */}
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold">Governance & health</div>
                  <div className="text-sm text-muted-foreground">
                    Sprawl, ownership rules, inactive Teams, and storage impact.
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={teamFilter}
                    onChange={(e) => setTeamFilter(e.target.value as any)}
                    className="rounded-xl border px-3 py-2 text-sm bg-white"
                  >
                    <option value="ALL">All</option>
                    <option value="INACTIVE">Inactive (90d+)</option>
                    <option value="OWNERS_LT_2">Owners &lt; 2</option>
                    <option value="PRIVATE_SPRAWL">
                      Private channel sprawl
                    </option>
                  </select>

                  <div className="relative w-[240px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={teamQ}
                      onChange={(e) => setTeamQ(e.target.value)}
                      placeholder="Search teams..."
                      className="pl-10"
                    />
                  </div>
                </div>
              </div>

              <div className="mt-4 max-h-[520px] overflow-y-auto space-y-3">
                {teamsFiltered.map((t: any) => {
                  const inactivityDays = t.lastActivity.includes('days')
                    ? Number(t.lastActivity.split(' ')[0])
                    : 0
                  const inactiveRisk = inactivityDays >= 90
                  const ownersRisk = t.owners < 2
                  const privateSprawl = t.channels.private >= 5

                  return (
                    <div
                      key={t.id}
                      className="rounded-xl border bg-muted/20 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {t.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t.visibility} • Owners {t.owners} • Members{' '}
                            {t.members} • Last activity {t.lastActivity}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 justify-end">
                          {inactiveRisk && (
                            <Badge className="bg-orange-50 text-orange-700 border border-orange-200">
                              Inactive
                            </Badge>
                          )}
                          {ownersRisk && (
                            <Badge className="bg-red-50 text-red-700 border border-red-200">
                              Owners &lt; 2
                            </Badge>
                          )}
                          {privateSprawl && (
                            <Badge className="bg-purple-50 text-purple-700 border border-purple-200">
                              Private sprawl
                            </Badge>
                          )}
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-3">
                        <div className="rounded-xl border bg-white p-3">
                          <div className="text-xs text-muted-foreground">
                            Channels
                          </div>
                          <div className="text-sm font-semibold">
                            {t.channels.standard +
                              t.channels.private +
                              t.channels.shared}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Std {t.channels.standard} • Pvt {t.channels.private}{' '}
                            • Sh {t.channels.shared}
                          </div>
                        </div>

                        <div className="rounded-xl border bg-white p-3">
                          <div className="text-xs text-muted-foreground">
                            Storage
                          </div>
                          <div className="text-sm font-semibold">
                            {t.sharePointGB} GB
                          </div>
                          <div className="text-xs text-muted-foreground">
                            SharePoint site
                          </div>
                        </div>

                        <div className="rounded-xl border bg-white p-3">
                          <div className="text-xs text-muted-foreground">
                            Compliance
                          </div>
                          <div className="text-sm font-semibold">
                            Retention: —
                          </div>
                          <div className="text-xs text-muted-foreground">
                            eDiscovery: —
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}

                {teamsFiltered.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    No teams found.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  /** tiny helper icon using your existing lucide set */
  function PhoneIcon() {
    return <Mail className="h-5 w-5 text-emerald-700" />
  }

  function RecentSignInsPanel({
    users,
    events,
  }: {
    users: TenantUser[]
    events: SignInEvent[]
  }) {
    const [selectedUserId, setSelectedUserId] = useState<string>('all')
    const [timeWindow, setTimeWindow] = useState<TimeWindow>('24h')

    const [zoom, setZoom] = useState(1.15)
    const showStates = zoom >= 6

    // Keeps markers a sane size at extreme zoom levels
    const markerScale = Math.max(0.25, Math.min(1, 1 / zoom))
    const [center, setCenter] = useState<[number, number]>([0, 20])

    const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
    const [hovered, setHovered] = useState<SignInEvent | null>(null)

    const filteredEvents = useMemo(() => {
      return events.filter((e) => {
        if (selectedUserId !== 'all' && e.userId !== selectedUserId)
          return false
        if (!withinTimeWindow(e.createdAt, timeWindow)) return false
        return true
      })
    }, [events, selectedUserId, timeWindow])

    useEffect(() => {
      let map: any = null
      let markers: any[] = []

      const el = document.getElementById('signins-map')
      if (!el) return

      // Prevent double-init on hot reload / strict mode
      if ((el as any).__inited) return
      ;(el as any).__inited = true
      ;(async () => {
        const maplibregl = (await import('maplibre-gl')).default

        map = new maplibregl.Map({
          container: el,
          style: {
            version: 8,
            sources: {
              osm: {
                type: 'raster',
                tiles: [
                  'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
                  'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
                  'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
                ],
                tileSize: 256,
                attribution: '© OpenStreetMap contributors',
              },
            },
            layers: [
              {
                id: 'osm',
                type: 'raster',
                source: 'osm',
              },
            ],
          },
          center: [-79.3832, 43.6532], // default center (Toronto)
          zoom: 2.5,
          minZoom: 1,
          maxZoom: 18,
          attributionControl: false,
        })

        map.addControl(
          new maplibregl.NavigationControl({ showCompass: true }),
          'top-right'
        )

        const renderMarkers = () => {
          // Clear existing markers
          for (const m of markers) m.remove()
          markers = []

          const evts = Array.isArray(filteredEvents) ? filteredEvents : []
          for (const e of evts) {
            if (
              typeof e?.longitude !== 'number' ||
              typeof e?.latitude !== 'number'
            )
              continue
            if (e.longitude === 0 && e.latitude === 0) continue

            const dot = document.createElement('div')
            dot.style.width = '10px'
            dot.style.height = '10px'
            dot.style.borderRadius = '999px'
            dot.style.border = '2px solid #fff'
            dot.style.boxShadow = '0 8px 18px rgba(0,0,0,0.18)'
            dot.style.background =
              e.result === 'Failure' ? '#EF4444' : '#22C55E'
            dot.style.cursor = 'pointer'
            dot.style.transform =
              selectedEventId === e.id ? 'scale(1.25)' : 'scale(1)'

            dot.onclick = (evt) => {
              evt.preventDefault()
              evt.stopPropagation()
              setHovered(e)
              setSelectedEventId((cur) => (cur === e.id ? null : e.id))
            }

            const marker = new maplibregl.Marker({ element: dot })
              .setLngLat([e.longitude, e.latitude])
              .addTo(map)

            markers.push(marker)
          }

          // Fit bounds if multiple points
          const coords = evts
            .filter(
              (x: any) =>
                typeof x?.longitude === 'number' &&
                typeof x?.latitude === 'number' &&
                !(x.longitude === 0 && x.latitude === 0)
            )
            .map((x: any) => [x.longitude, x.latitude])

          if (coords.length >= 2) {
            const bounds = coords.reduce(
              (b: any, c: any) => b.extend(c),
              new maplibregl.LngLatBounds(coords[0], coords[0])
            )
            map.fitBounds(bounds, { padding: 60, duration: 450 })
          } else if (coords.length === 1) {
            map.setCenter(coords[0])
            map.setZoom(7)
          }
        }

        map.on('load', () => {
          renderMarkers()
          ;(el as any).__renderMarkers = renderMarkers
        })
      })()

      return () => {
        try {
          for (const m of markers) m.remove()
          markers = []
          if (map) map.remove()
        } catch {}
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      const el = document.getElementById('signins-map')
      const fn = el ? (el as any).__renderMarkers : null
      if (typeof fn === 'function') fn()
    }, [filteredEvents, selectedEventId])

    const tableEvents = useMemo(() => {
      if (!selectedEventId) return filteredEvents
      return filteredEvents.filter((e) => e.id === selectedEventId)
    }, [filteredEvents, selectedEventId])

    function zoomIn() {
      setZoom((z) => Math.min(6, Number((z * 1.25).toFixed(2))))
    }
    function zoomOut() {
      setZoom((z) => Math.max(1, Number((z / 1.25).toFixed(2))))
    }
    function resetView() {
      setZoom(1.15)
      setCenter([0, 20])
    }

    return (
      <Card className="rounded-2xl lg:col-span-4 shadow-sm">
        <CardContent className="p-6 space-y-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="font-semibold">Recent Sign-ins</div>
              <div className="text-sm text-muted-foreground">
                Interactive sign-in activity by location
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={selectedUserId}
                onChange={(e) => {
                  setSelectedUserId(e.target.value)
                  setSelectedEventId(null)
                }}
                className="rounded-xl border px-3 py-2 text-sm bg-white"
              >
                <option value="all">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>

              <select
                value={timeWindow}
                onChange={(e) => {
                  setTimeWindow(e.target.value as TimeWindow)
                  setSelectedEventId(null)
                }}
                className="rounded-xl border px-3 py-2 text-sm bg-white"
              >
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>

              {selectedEventId && (
                <button
                  onClick={() => setSelectedEventId(null)}
                  className="rounded-xl border px-3 py-2 text-sm font-semibold bg-white hover:bg-muted/30"
                  title="Clear selected sign-in"
                >
                  Clear selection
                </button>
              )}
            </div>
          </div>

          <div className="rounded-2xl border bg-white overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
              <div className="text-sm font-semibold text-slate-800">
                Sign-in map
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  {filteredEvents.length} events • zoom {Math.round(zoom * 100)}
                  %
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={zoomOut}
                  className="h-9 w-9 rounded-xl border bg-white hover:bg-muted/30 flex items-center justify-center"
                  title="Zoom out"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  className="h-9 w-9 rounded-xl border bg-white hover:bg-muted/30 flex items-center justify-center"
                  title="Zoom in"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={resetView}
                  className="h-9 px-3 rounded-xl border bg-white hover:bg-muted/30 text-sm font-semibold flex items-center gap-2"
                  title="Reset view"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
              </div>
            </div>

            <div className="relative bg-muted/10">
              {hovered && (
                <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-2xl border bg-white shadow-lg px-4 py-3 w-[320px]">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm text-slate-900 truncate">
                      {hovered.userDisplayName}
                    </div>
                    <Badge
                      className={
                        hovered.result === 'Success'
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-red-50 text-red-700 border border-red-200'
                      }
                    >
                      {hovered.result}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {hovered.city ? `${hovered.city}, ` : ''}
                    {hovered.country} • {hovered.ipAddress}
                  </div>
                  <div className="mt-2 text-xs text-slate-700">
                    <span className="font-semibold">App:</span>{' '}
                    {hovered.appDisplayName} ({hovered.clientAppUsed})
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatWhen(hovered.createdAt)}
                  </div>
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    Click the dot to filter table
                  </div>
                </div>
              )}

              <div className="h-[260px]">
                <div className="relative h-[420px] w-full overflow-hidden rounded-xl border bg-muted/20">
                  <div id="signins-map" className="h-full w-full" />
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-left">Location</th>
                  <th className="px-4 py-3 text-left">IP</th>
                  <th className="px-4 py-3 text-left">App</th>
                  <th className="px-4 py-3 text-left">Result</th>
                  <th className="px-4 py-3 text-left">Time</th>
                </tr>
              </thead>
              <tbody>
                {tableEvents.map((e) => (
                  <tr
                    key={e.id}
                    className={`border-b hover:bg-muted/20 ${
                      selectedEventId === e.id ? 'bg-blue-50/40' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-medium">
                      {e.userDisplayName}
                    </td>
                    <td className="px-4 py-3">
                      {e.city ? `${e.city}, ` : ''}
                      {e.country}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {e.ipAddress}
                    </td>
                    <td className="px-4 py-3">{e.appDisplayName}</td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          e.result === 'Success'
                            ? 'bg-green-50 text-green-700 border border-green-200'
                            : 'bg-red-50 text-red-700 border border-red-200'
                        }
                      >
                        {e.result}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatWhen(e.createdAt)}
                    </td>
                  </tr>
                ))}

                {tableEvents.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-center text-muted-foreground"
                    >
                      No sign-in activity for selected filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    )
  }

  function EntraPage({ bundle }: { bundle: any }) {
    function HomePage() {
      return (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <LicensesSection
            isMicrosoft={isMicrosoft}
            licenseRows={licenseRows}
            UtilBar={UtilBar}
          />

          <DnsSection
            tenant={tenant}
            domains={domains}
            isMicrosoft={isMicrosoft}
            dns={bundle?.dns}
          />
        </div>
      )
    }

    function renderMainContent(bundle: any) {
      if (
        section === 'sharepoint' //||
        //section === 'sharepoint-onedrive' ||
        //section === 'onedrive'
      ) {
        return <SharePointPage bundle={bundle} />
      }

      if (isMicrosoft) {
        if (section === 'exchange')
          return (
            <ExchangePage
              bundle={bundle}
              setSelectedMailbox={setSelectedMailbox}
              setSelectedRule={setSelectedRule}
              setSelectedGroup={setSelectedGroup}
            />
          )

        if (section === 'entra')
          return (
            <div className="mt-8">
              <div className="flex flex-wrap items-center gap-2">
                <PillTab
                  active={entraTab === 'overview'}
                  icon={<Layers className="h-4 w-4" />}
                  label="Overview"
                  onClick={() => setEntraTab('overview')}
                />
                <PillTab
                  active={entraTab === 'identity'}
                  icon={<User className="h-4 w-4" />}
                  label="Identity"
                  onClick={() => setEntraTab('identity')}
                />
                <PillTab
                  active={entraTab === 'security'}
                  icon={<Shield className="h-4 w-4" />}
                  label="Security"
                  onClick={() => setEntraTab('security')}
                />
                <PillTab
                  active={entraTab === 'licenses'}
                  icon={<Activity className="h-4 w-4" />}
                  label="License Activity"
                  onClick={() => setEntraTab('licenses')}
                />
              </div>

              {entraTab === 'overview' && (
                <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-4">
                  <Card className="rounded-2xl shadow-sm">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-blue-50 border flex items-center justify-center">
                          <Users className="h-5 w-5 text-blue-700" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Users
                          </div>
                          <div className="text-2xl font-bold">
                            {USERS.length}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Directory users
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="rounded-2xl shadow-sm">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-purple-50 border flex items-center justify-center">
                          <Layers className="h-5 w-5 text-purple-700" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Policies
                          </div>
                          <div className="text-2xl font-bold">
                            {caPolicies.length}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Conditional Access
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="rounded-2xl shadow-sm">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-slate-50 border flex items-center justify-center">
                          <Shield className="h-5 w-5 text-slate-700" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            MFA Methods
                          </div>
                          <div className="text-2xl font-bold">
                            {authMethods.length}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Auth methods tracked
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="rounded-2xl shadow-sm">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-emerald-50 border flex items-center justify-center">
                          <ShieldCheck className="h-5 w-5 text-emerald-700" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Sign-ins
                          </div>
                          <div className="text-2xl font-bold">
                            {SIGNINS.length}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Activity events
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <RecentSignInsPanel users={USERS} events={SIGNINS} />
                </div>
              )}

              {entraTab === 'identity' && (
                <Card className="rounded-2xl mt-5 shadow-sm">
                  <CardContent className="p-0">
                    <div className="flex items-center justify-between px-6 py-5 border-b">
                      <div className="text-lg font-semibold">Users</div>

                      <div className="relative w-full max-w-[280px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          value={userSearch}
                          onChange={(e) => setUserSearch(e.target.value)}
                          placeholder="Search users..."
                          className="pl-10"
                        />
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-muted/30">
                          <tr>
                            <th className="text-left px-6 py-3">Name</th>
                            <th className="text-left px-6 py-3">Type</th>
                            <th className="text-left px-6 py-3">Role</th>
                            <th className="text-left px-6 py-3">Status</th>
                            <th className="text-left px-6 py-3">MFA</th>
                            <th className="px-6 py-3" />
                          </tr>
                        </thead>
                        <tbody>
                          {filteredUsers.map((u) => (
                            <tr
                              key={u.id}
                              className="border-b cursor-pointer hover:bg-white hover:shadow-sm transition"
                              onClick={() => setSelectedUser(u)}
                            >
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-xs font-bold">
                                    {u.name
                                      .split(' ')
                                      .map((p) => p[0])
                                      .slice(0, 2)
                                      .join('')}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="font-semibold truncate">
                                      {u.name}
                                    </div>
                                    <div className="text-xs text-muted-foreground truncate">
                                      {u.email}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 text-muted-foreground">
                                {u.type}
                              </td>
                              <td className="px-6 py-4 text-muted-foreground">
                                {u.role}
                              </td>
                              <td className="px-6 py-4">
                                <Badge
                                  className={`${
                                    u.status === 'Enabled'
                                      ? 'bg-green-50 text-green-700 border border-green-200'
                                      : 'bg-slate-50 text-slate-600 border border-slate-200'
                                  }`}
                                >
                                  {u.status}
                                </Badge>
                              </td>
                              <td className="px-6 py-4 text-muted-foreground">
                                {u.mfa}
                              </td>
                              <td className="px-6 py-4 text-right">
                                <ChevronRight className="h-4 w-4 inline-block text-muted-foreground" />
                              </td>
                            </tr>
                          ))}

                          {filteredUsers.length === 0 && (
                            <tr>
                              <td
                                colSpan={6}
                                className="px-6 py-8 text-center text-muted-foreground"
                              >
                                No users found.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {entraTab === 'security' && (
                <div className="mt-5">
                  <EntraSection
                    policies={caPolicies as any}
                    onPolicyClick={(p) => setSelectedPolicy(p as any)}
                  />

                  <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
                    <AuthMethodsCard rows={authMethods} />
                    <NamedLocationsCard locations={NAMED_LOCATIONS} />
                  </div>
                </div>
              )}

              {entraTab === 'licenses' && (
                <Card className="rounded-2xl mt-5 shadow-sm">
                  <CardContent className="p-6">
                    <div className="font-semibold">License Activity</div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      Mock: recent assignments, SKU usage trend, dormant
                      accounts.
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )
      }

      if (section === 'directory') return <PlaceholderPage title="Directory" />
      if (section === 'gmail') return <PlaceholderPage title="Gmail" />
      if (section === 'drive') return <PlaceholderPage title="Drive" />
      if (section === 'security') return <PlaceholderPage title="Security" />

      if (section === 'exchange') return <ExchangePage />
      if (section === 'sharepoint') return <SharePointPage />

      return <HomePage />
    }

    return (
      <div className="space-y-6">
        <Link
          href="/tenants"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Tenants
        </Link>

        <div className="rounded-[28px] border bg-white overflow-hidden shadow-sm">
          <div className="flex h-[calc(100vh-180px)]">
            <aside className="hidden lg:flex w-[300px] flex-col border-r bg-white/80 sticky top-0 h-full">
              <div className="p-4 border-b">
                <div className="relative">
                  <button
                    onClick={() => setTenantPickerOpen((v) => !v)}
                    className="w-full flex items-center justify-between gap-3 rounded-2xl border bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
                    title="Switch tenant"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ProviderIcon provider={tenant.provider} />
                      <div className="min-w-0 text-left">
                        <div className="font-semibold truncate">
                          {tenant.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {tenant.domain}
                        </div>
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>

                  {tenantPickerOpen && (
                    <div className="absolute z-20 mt-2 w-full rounded-2xl border bg-white shadow-lg overflow-hidden">
                      <div className="p-3 border-b">
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            placeholder="Search tenants..."
                            value={tenantSearch}
                            onChange={(e) => setTenantSearch(e.target.value)}
                            className="pl-10"
                          />
                        </div>
                      </div>

                      <div className="max-h-[260px] overflow-y-auto">
                        {filteredTenants.map((t: any) => (
                          <button
                            key={t.id}
                            onClick={() => {
                              setTenantPickerOpen(false)
                              router.push(`/tenants/${t.id}`)
                            }}
                            className={`w-full text-left px-4 py-3 text-sm hover:bg-muted/30 ${
                              t.id === tenant.id
                                ? 'bg-blue-50 text-blue-700'
                                : ''
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  t.id === tenant.id
                                    ? 'bg-blue-600'
                                    : 'bg-muted'
                                }`}
                              />
                              <div className="min-w-0">
                                <div className="font-semibold truncate">
                                  {t.name}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {t.domain}
                                </div>
                              </div>
                            </div>
                          </button>
                        ))}

                        {filteredTenants.length === 0 && (
                          <div className="px-4 py-6 text-sm text-muted-foreground">
                            No tenants found.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-3 space-y-2 flex-1 overflow-y-auto">
                {navItems.map((i) =>
                  (i as any).disabled ? (
                    <span
                      key={i.key}
                      title="Coming soon"
                      className="relative block opacity-50 cursor-not-allowed group"
                    >
                      <SectionButton
                        active={section === i.key}
                        icon={i.icon}
                        label={i.label}
                        onClick={() => {
                          // disabled: do nothing
                        }}
                      />

                      {/* Hover stop icon */}
                      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center justify-center">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-100 border border-red-300">
                          <Ban className="h-4 w-4 text-red-600" />
                        </span>
                      </span>
                      {/* Instant tooltip (no overflow) */}
                      <span className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 hidden group-hover:block whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg">
                        Coming Soon
                      </span>
                    </span>
                  ) : (
                    <SectionButton
                      key={i.key}
                      active={section === i.key}
                      icon={i.icon}
                      label={i.label}
                      onClick={() => {
                        setSection(i.key)
                        if (i.key === 'entra') setEntraTab('overview')
                      }}
                    />
                  )
                )}
              </div>

              <div className="mt-auto">
                <div className="p-4 border-t flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">Health</div>
                  <Badge className={`${statusBadge(tenant.status)} uppercase`}>
                    {tenant.status}
                  </Badge>
                </div>
                <div className="px-4 pb-4 text-xs text-muted-foreground">
                  Synced {tenant.lastSync}
                </div>
              </div>
            </aside>

            <section className="flex-1 bg-gray-50/60 overflow-y-auto">
              <div className="p-8">
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-1xl font-bold tracking-tight">
                      {heading}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {subheading}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={runSync}
                      className="h-10 w-10 rounded-xl border bg-white shadow-sm hover:shadow-md hover:bg-white transition flex items-center justify-center"
                      title={
                        syncState === 'syncing'
                          ? 'Syncing...'
                          : syncState === 'success'
                            ? 'Sync complete'
                            : syncState === 'fail'
                              ? 'Sync failed'
                              : 'Refresh'
                      }
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${syncState === 'syncing' ? 'animate-spin' : ''}`}
                      />
                    </button>

                    <button
                      className="h-10 w-10 rounded-xl border bg-white shadow-sm hover:shadow-md hover:bg-white transition flex items-center justify-center"
                      title="Settings"
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {syncState === 'fail' && (
                  <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    Sync failed. Try again.
                  </div>
                )}
                {syncState === 'success' && (
                  <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                    Sync completed.
                  </div>
                )}

                {bundle && renderMainContent(bundle)}
              </div>
            </section>
          </div>
        </div>

        <RightDrawer
          open={!!selectedUser}
          title={selectedUser ? `User: ${selectedUser.name}` : 'User details'}
          onClose={() => setSelectedUser(null)}
        >
          {selectedUser && (
            <div className="space-y-6">
              {/* Identity header */}
              <div className="rounded-2xl border bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-lg font-bold text-slate-900 truncate">
                      {selectedUser.name}
                    </div>
                    <div className="text-sm text-muted-foreground break-words">
                      {selectedUser.email}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge className="bg-blue-50 text-blue-700 border border-blue-200">
                        {selectedUser.type}
                      </Badge>
                      <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
                        {selectedUser.role}
                      </Badge>
                      <Badge
                        className={
                          selectedUser.status === 'Enabled'
                            ? 'bg-green-50 text-green-700 border border-green-200'
                            : 'bg-slate-50 text-slate-600 border border-slate-200'
                        }
                      >
                        {selectedUser.status}
                      </Badge>
                      <Badge
                        className={
                          selectedUser.mfa === 'Enforced'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : selectedUser.mfa === 'Enabled'
                              ? 'bg-blue-50 text-blue-700 border border-blue-200'
                              : 'bg-red-50 text-red-700 border border-red-200'
                        }
                      >
                        MFA: {selectedUser.mfa}
                      </Badge>
                    </div>
                  </div>

                  <div className="h-10 w-10 rounded-2xl bg-muted/20 border flex items-center justify-center">
                    <User className="h-5 w-5 text-slate-700" />
                  </div>
                </div>
              </div>

              {/* Quick stats */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-xl border bg-slate-50 p-4">
                  <div className="text-xs text-muted-foreground">
                    Last login
                  </div>
                  <div className="text-sm font-semibold">
                    {selectedUser.lastLogin}
                  </div>
                </div>
                <div className="rounded-xl border bg-slate-50 p-4">
                  <div className="text-xs text-muted-foreground">
                    Auth methods
                  </div>
                  <div className="text-sm font-semibold">
                    {selectedUser?.authMethods?.length ?? 0}
                  </div>
                </div>
              </div>

              {/* Usage */}
              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">
                  Usage
                </div>
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-muted-foreground">Drive</div>
                    <div className="font-semibold text-slate-900">
                      {selectedUser.driveUsage}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-muted-foreground">Mailbox</div>
                    <div className="font-semibold text-slate-900">
                      {selectedUser.mailUsage}
                    </div>
                  </div>
                </div>
              </div>

              {/* Groups */}
              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">
                  Groups
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(selectedUser.groups?.length
                    ? selectedUser.groups
                    : ['—']
                  ).map((g) => (
                    <Badge
                      key={g}
                      className="bg-slate-100 text-slate-700 border border-slate-200"
                    >
                      {g}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Licenses */}
              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">
                  Licenses
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(selectedUser.licenses?.length
                    ? selectedUser.licenses
                    : ['—']
                  ).map((l) => (
                    <Badge
                      key={l}
                      className="bg-blue-50 text-blue-700 border border-blue-200"
                    >
                      {l}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Devices */}
              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">
                  Devices
                </div>
                <div className="mt-3 space-y-2">
                  {selectedUser.devices?.length ? (
                    selectedUser.devices.map((d: any) => (
                      <div
                        key={d.name}
                        className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {d.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {d.os} • Last sync {d.lastSync}
                          </div>
                        </div>
                        <Badge
                          className={
                            d.status.toLowerCase().includes('compliant')
                              ? 'bg-green-50 text-green-700 border border-green-200'
                              : 'bg-orange-50 text-orange-700 border border-orange-200'
                          }
                        >
                          {d.status}
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No devices.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </RightDrawer>

        <RightDrawer
          open={!!selectedPolicy}
          title={selectedPolicy?.name || 'Policy details'}
          onClose={() => setSelectedPolicy(null)}
        >
          {selectedPolicy && <PolicyDetailsView policy={selectedPolicy} />}
        </RightDrawer>
        <RightDrawer
          open={!!selectedMailbox}
          title={
            selectedMailbox
              ? `Mailbox: ${selectedMailbox.displayName}`
              : 'Mailbox details'
          }
          onClose={() => setSelectedMailbox(null)}
        >
          {selectedMailbox && (
            <div className="space-y-8 divide-y divide-slate-200/60">
              {/* HERO / IDENTITY */}
              <div className="pt-2">
                <div className="rounded-2xl border bg-gradient-to-r from-blue-50 to-white p-4">
                  <div className="text-xs uppercase tracking-wide text-blue-600 font-semibold">
                    Mailbox
                  </div>

                  <div className="mt-1 text-lg font-bold text-slate-900">
                    {selectedMailbox.displayName}
                  </div>

                  <div className="text-sm text-muted-foreground break-words">
                    {selectedMailbox.userPrincipalName}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge className="bg-blue-50 text-blue-700 border border-blue-200">
                      {selectedMailbox.mailboxType}
                    </Badge>

                    <Badge
                      className={
                        selectedMailbox.archiveEnabled
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-orange-50 text-orange-700 border border-orange-200'
                      }
                    >
                      {selectedMailbox.archiveEnabled
                        ? 'Archive enabled'
                        : 'No archive'}
                    </Badge>

                    <Badge
                      className={
                        selectedMailbox.retentionLabel
                          ? 'bg-blue-50 text-blue-700 border border-blue-200'
                          : 'bg-red-50 text-red-700 border border-red-200'
                      }
                    >
                      {selectedMailbox.retentionLabel
                        ? 'Retention applied'
                        : 'No retention'}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* ALIASES */}
              <div className="pt-6">
                <div className="text-sm font-semibold text-slate-900 mb-2">
                  Aliases
                </div>
                <div className="flex flex-wrap gap-2">
                  {(selectedMailbox.aliases.length
                    ? selectedMailbox.aliases
                    : ['—']
                  ).map((a: any) => (
                    <Badge
                      key={a}
                      className="bg-slate-100 text-slate-700 border border-slate-200"
                    >
                      {a}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* SIZE / ITEMS */}
              <div className="pt-6 grid grid-cols-2 gap-4">
                <div className="rounded-xl border bg-slate-50 p-4">
                  <div className="text-xs text-muted-foreground">
                    Mailbox size
                  </div>
                  <div className="text-sm font-semibold">
                    {selectedMailbox.sizeGB.toFixed(1)} GB
                  </div>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4">
                  <div className="text-xs text-muted-foreground">
                    Item count
                  </div>
                  <div className="text-sm font-semibold">
                    {selectedMailbox.itemCount.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* DELEGATION */}
              <div className="pt-6 space-y-4">
                <div className="text-sm font-semibold text-slate-900">
                  Delegation
                </div>

                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    Full access
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(selectedMailbox.delegation?.fullAccess?.length
                      ? selectedMailbox.delegation.fullAccess
                      : ['—']
                    ).map((x) => (
                      <Badge
                        key={x}
                        className="bg-sky-50 text-sky-700 border border-sky-200"
                      >
                        {x}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    Send as
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(selectedMailbox.delegation?.sendAs?.length
                      ? selectedMailbox.delegation.sendAs
                      : ['—']
                    ).map((x) => (
                      <Badge
                        key={x}
                        className="bg-emerald-50 text-emerald-700 border border-emerald-200"
                      >
                        {x}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    Send on behalf
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(selectedMailbox.delegation?.sendOnBehalf?.length
                      ? selectedMailbox.delegation.sendOnBehalf
                      : ['—']
                    ).map((x) => (
                      <Badge
                        key={x}
                        className="bg-purple-50 text-purple-700 border border-purple-200"
                      >
                        {x}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </RightDrawer>

        <RightDrawer
          open={!!selectedRule}
          title={selectedRule?.name || 'Rule details'}
          onClose={() => setSelectedRule(null)}
        >
          {selectedRule && (
            <div className="space-y-4">
              <div
                className={`h-1 rounded-full ${
                  selectedRule.enabled ? 'bg-green-500' : 'bg-slate-300'
                }`}
              />

              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold">Status</div>
                <Badge
                  className={
                    selectedRule.enabled
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-slate-50 text-slate-600 border border-slate-200'
                  }
                >
                  {selectedRule.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>

              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold">Mailbox</div>
                <div className="text-sm text-muted-foreground">
                  {selectedRule.mailboxUpn}
                </div>
              </div>
            </div>
          )}
        </RightDrawer>

        <RightDrawer
          open={!!selectedGroup}
          title={selectedGroup?.name || 'Group details'}
          onClose={() => setSelectedGroup(null)}
        >
          {selectedGroup && (
            <div className="space-y-4">
              <div className="h-1 rounded-full bg-purple-500" />

              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold">Email</div>
                <div className="text-sm text-muted-foreground">
                  {selectedGroup.email}
                </div>
              </div>

              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold">Members</div>
                <Badge className="bg-purple-50 text-purple-700 border border-purple-200">
                  {selectedGroup.membersCount} members
                </Badge>
              </div>

              <div className="rounded-2xl border bg-white p-4">
                <div className="text-sm font-semibold">Type</div>
                <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
                  {selectedGroup.type}
                </Badge>
              </div>
            </div>
          )}
        </RightDrawer>
      </div>
    )
  }
  return <EntraPage bundle={bundle} />
}
