'use client'

import * as React from 'react'
import {
  X,
  Building2,
  AlertTriangle,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  AppWindow,
  User,
  Shield,
  Layers,
  FileText,
  Key,
  Info,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ChangeEvent, isAppRelatedEvent } from '../data/change-types'

function pretty(obj: any) {
  return JSON.stringify(obj ?? {}, null, 2)
}

function fmt(ts: string) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  return (
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'UTC',
    }).format(d) + ' (UTC)'
  )
}

function fmtLocation(event: ChangeEvent) {
  const parts = [
    event.location?.city,
    event.location?.region,
    event.location?.country,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : '—'
}

function fmtClient(event: ChangeEvent) {
  const app = event.client?.app
  const device = event.client?.device
  if (!app && !device) return '—'
  if (app && device) return `${app} · ${device}`
  return app ?? device ?? '—'
}

function formatVal(v: any): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

interface WhatChangedDrawerProps {
  open: boolean
  event: ChangeEvent | null
  onClose: () => void
}

export function WhatChangedDrawer({
  open,
  event,
  onClose,
}: WhatChangedDrawerProps) {
  const [copiedSection, setCopiedSection] = React.useState<string | null>(null)
  const [showRawJson, setShowRawJson] = React.useState(false)

  // Handle escape key to close drawer
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopiedSection(label)
    setTimeout(() => setCopiedSection(null), 2000)
  }

  const isApp = event ? isAppRelatedEvent(event) : false

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-xs transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full sm:w-[600px] bg-background border-l border-border shadow-2xl',
          'transition-transform duration-200 ease-out flex flex-col',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Event details"
      >
        {/* Drawer Header */}
        <div className="p-4 sm:p-5 border-b border-border flex items-start justify-between gap-3 bg-muted/20 shrink-0">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs font-normal gap-1 bg-background">
                <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[180px]">{event?.tenantName ?? 'Tenant'}</span>
              </Badge>

              {event?.severity && (
                <Badge
                  variant={event.severity === 'High' ? 'destructive' : 'secondary'}
                  className="text-[10px] tracking-wider uppercase font-semibold shrink-0"
                >
                  {event.severity}
                </Badge>
              )}

              {isApp && (
                <Badge variant="secondary" className="text-[10px] uppercase font-medium bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20 shrink-0">
                  Application Event
                </Badge>
              )}
            </div>

            <h2 className="text-lg font-bold text-foreground leading-snug break-words">
              {event?.title ?? 'Event Details'}
            </h2>

            {event?.summary && (
              <p className="text-xs text-muted-foreground leading-normal break-words">
                {event.summary}
              </p>
            )}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close details drawer"
            className="h-8 w-8 rounded-md shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-6">
          {!event ? (
            <div className="text-xs text-muted-foreground">Select an event to view full details.</div>
          ) : isApp ? (
            <AppEventDetails
              event={event}
              copiedSection={copiedSection}
              copyToClipboard={copyToClipboard}
              showRawJson={showRawJson}
              setShowRawJson={setShowRawJson}
            />
          ) : (
            <NonAppEventDetails
              event={event}
              copiedSection={copiedSection}
              copyToClipboard={copyToClipboard}
            />
          )}
        </div>
      </aside>
    </>
  )
}

/* =========================================================================
   APP-SPECIFIC EVENT DETAILS COMPONENT
   ========================================================================= */

function AppEventDetails({
  event,
  copiedSection,
  copyToClipboard,
  showRawJson,
  setShowRawJson,
}: {
  event: ChangeEvent
  copiedSection: string | null
  copyToClipboard: (text: string, label: string) => void
  showRawJson: boolean
  setShowRawJson: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const b = event.before ?? {}
  const a = event.after ?? {}
  const evidence = event.evidence
  const application = evidence?.application
  const actorEvidence = evidence?.actor
  const permissionEvidence = evidence?.permissions

  // 1. Change summary fields
  const activityName = event.title
  const result = evidence?.result ?? a.result ?? a.Result ?? a.status ?? 'Not provided by Microsoft'
  const dateTime = fmt(event.ts)
  const serviceSource = evidence?.loggedByService ?? event.source ?? event.provider ?? 'Entra'
  const category = event.category
  const eventId = event.id
  const correlationId = event.correlationId

  // 2. Application fields
  const appDisplayName =
    application?.displayName ?? a.displayName ?? a.AppDisplayName ?? a.appDisplayName ?? a.applicationDisplayName ??
    b.displayName ?? b.AppDisplayName ??
    (event.target && !event.target.includes('@') ? event.target : undefined) ??
    event.client?.app

  const appId = application?.appId ?? a.appId ?? a.AppId ?? a.clientId ?? a.ClientId ?? b.appId ?? b.AppId
  const objectId = application?.objectId ?? a.objectId ?? a.ObjectId ?? a.id ?? b.objectId ?? b.id
  const servicePrincipalId = application?.servicePrincipalId ?? a.servicePrincipalId ?? a.ServicePrincipalId ?? b.servicePrincipalId
  const publisher = application?.publisher ?? a.publisher ?? a.Publisher ?? a.publisherName ?? b.publisher
  const appType = application?.appType ?? a.appType ?? a.ApplicationType ?? a.servicePrincipalType ?? b.appType
  const signInAudience = application?.signInAudience ?? a.signInAudience ?? a.SignInAudience ?? b.signInAudience
  const description = application?.description ?? a.description ?? a.Description ?? a.notes ?? b.description
  const homepage = application?.homepage ?? a.homepage ?? a.identifierUris ?? a.IdentifierUris ?? b.homepage

  // 3. Changed by fields
  const actorName = actorEvidence?.principalName ?? actorEvidence?.displayName ?? event.actor ?? a.actorName ?? a.actor ?? 'Not provided by Microsoft'
  const isUpn = actorName.includes('@')
  const actorPrincipalName = actorEvidence?.principalName ?? a.actorPrincipalName ?? b.actorPrincipalName ?? (isUpn ? actorName : undefined)
  const actorDisplayName = actorEvidence?.displayName ?? a.actorDisplayName ?? b.actorDisplayName ?? (!isUpn ? actorName : undefined)
  const actorType = actorEvidence?.type ?? a.actorType ?? b.actorType ?? (isUpn ? 'User' : 'Service Principal / App')
  const actorObjectId = actorEvidence?.objectId ?? a.actorObjectId ?? a.initiatedBy?.id ?? b.actorObjectId
  const automatedByApp = actorEvidence?.automatedBy ?? a.automatedBy ?? a.initiatedBy?.app ?? b.automatedBy
  const actorIp = actorEvidence?.ipAddress ?? event.ip ?? 'Not provided by Microsoft'
  const actorLocation = fmtLocation(event)
  const actorClient = fmtClient(event)

  // 4. Changes made fields
  const ignoreKeys = new Set(['result', 'Result', 'status', 'riskLevel', 'mfa', 'roles'])
  const modifiedKeys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
    .filter((k) => !ignoreKeys.has(k))

  const modifiedProperties = modifiedKeys.map((k) => ({
    property: k,
    beforeVal: b[k],
    afterVal: a[k],
  }))

  // 5. Access and permissions fields
  const apiPermission = permissionEvidence?.permissionName ?? a.permissionName ?? a.permission ?? a.OAuth2PermissionGrant ?? b.permissionName
  const permissionType = permissionEvidence?.permissionType ?? a.permissionType ?? a.grantType ?? b.permissionType
  const consentType = permissionEvidence?.consentType ?? a.consentType ?? b.consentType
  const grantedScope = permissionEvidence?.scope ?? a.scope ?? a.grantedScope ?? b.scope
  const resourceApi = permissionEvidence?.resourceApi ?? a.resourceApi ?? a.resource ?? b.resourceApi
  const appRole = permissionEvidence?.appRole ?? a.appRole ?? b.appRole
  const assignedTo = permissionEvidence?.assignedTo ?? a.assignedTo ?? a.targetIdentity ?? (event.target && event.target.includes('@') ? event.target : undefined)
  const grantingAdmin = permissionEvidence?.grantingAdmin ?? a.grantingAdmin ?? b.grantingAdmin ?? (event.actor && event.actor.includes('@') ? event.actor : undefined)
  const consentStatus = permissionEvidence?.consentStatus ?? a.consentStatus ?? a.status ?? b.consentStatus

  const hasAccessInfo = Boolean(
    apiPermission || permissionType || consentType || grantedScope ||
    resourceApi || appRole || assignedTo || grantingAdmin || consentStatus
  )

  const isOnlyChangedIdentity = Boolean(assignedTo && !apiPermission && !grantedScope && !appRole)

  // 6. Target resources fields
  const targets: { displayName: string; targetType?: string; objectId?: string; upn?: string }[] = [...(evidence?.targets ?? [])]
  if (targets.length === 0 && event.target && event.target !== '—') {
    targets.push({
      displayName: event.target,
      targetType: event.target.includes('@') ? 'User' : 'Application / Resource',
      objectId: a.targetObjectId ?? a.objectId,
      upn: event.target.includes('@') ? event.target : undefined,
    })
  }

  return (
    <div className="space-y-6 text-xs text-foreground">
      {/* SECTION 1: CHANGE SUMMARY */}
      <div className="space-y-2 border-b border-border/60 pb-4">
        <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
          <FileText className="h-4 w-4 text-primary shrink-0" />
          <span>1. Change summary</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 pl-6">
          <div>
            <span className="text-muted-foreground block text-[11px]">Activity performed</span>
            <span className="font-medium text-foreground break-words">{activityName}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Result</span>
            <span className="font-medium text-foreground break-words">{String(result)}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Date and time</span>
            <span className="font-medium text-foreground">{dateTime}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Service / Source</span>
            <span className="font-medium text-foreground">{serviceSource}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Event category</span>
            <span className="font-medium text-foreground">{category}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Event ID</span>
            <span className="font-mono text-[11px] text-foreground break-all">{eventId}</span>
          </div>

          {correlationId && (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground block text-[11px]">Correlation ID</span>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-foreground break-all">{correlationId}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] gap-1 text-muted-foreground shrink-0"
                  onClick={() => copyToClipboard(correlationId, 'correlationId')}
                >
                  {copiedSection === 'correlationId' ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* SECTION 2: APPLICATION */}
      <div className="space-y-2 border-b border-border/60 pb-4">
        <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
          <AppWindow className="h-4 w-4 text-primary shrink-0" />
          <span>2. Application</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 pl-6">
          <div className="sm:col-span-2">
            <span className="text-muted-foreground block text-[11px]">Application display name</span>
            <span className="font-medium text-foreground break-words">{appDisplayName ?? '—'}</span>
          </div>

          {appId && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Application / Client ID</span>
              <span className="font-mono text-[11px] text-foreground break-all">{appId}</span>
            </div>
          )}

          {objectId && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Object ID</span>
              <span className="font-mono text-[11px] text-foreground break-all">{objectId}</span>
            </div>
          )}

          {servicePrincipalId && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Service-principal ID</span>
              <span className="font-mono text-[11px] text-foreground break-all">{servicePrincipalId}</span>
            </div>
          )}

          {publisher && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Publisher / Verified publisher</span>
              <span className="font-medium text-foreground break-words">{publisher}</span>
            </div>
          )}

          {appType && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Application type</span>
              <span className="font-medium text-foreground">{appType}</span>
            </div>
          )}

          {signInAudience && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Sign-in audience</span>
              <span className="font-medium text-foreground">{signInAudience}</span>
            </div>
          )}

          {homepage && (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground block text-[11px]">Homepage / Identifier URI</span>
              <span className="font-mono text-[11px] text-foreground break-all">{formatVal(homepage)}</span>
            </div>
          )}

          <div className="sm:col-span-2 pt-1">
            <span className="text-muted-foreground block text-[11px] font-semibold">What does this app do?</span>
            <p className="text-xs text-muted-foreground leading-relaxed pt-0.5 break-words">
              {description ? description : 'No application description is available.'}
            </p>
          </div>
        </div>
      </div>

      {/* SECTION 3: CHANGED BY */}
      <div className="space-y-2 border-b border-border/60 pb-4">
        <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
          <User className="h-4 w-4 text-primary shrink-0" />
          <span>3. Changed by</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 pl-6">
          <div>
            <span className="text-muted-foreground block text-[11px]">Actor display name</span>
            <span className="font-medium text-foreground break-words">{actorDisplayName ?? actorName}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Actor principal name</span>
            <span className="font-medium text-foreground break-all">{actorPrincipalName ?? actorName}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Actor type</span>
            <span className="font-medium text-foreground">{actorType}</span>
          </div>

          {actorObjectId && (
            <div>
              <span className="text-muted-foreground block text-[11px]">Actor object ID</span>
              <span className="font-mono text-[11px] text-foreground break-all">{actorObjectId}</span>
            </div>
          )}

          {automatedByApp && (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground block text-[11px]">Automated application / Service principal</span>
              <span className="font-medium text-foreground break-all">{automatedByApp}</span>
            </div>
          )}

          <div>
            <span className="text-muted-foreground block text-[11px]">IP address</span>
            <span className="font-mono text-foreground font-medium">{actorIp}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Location</span>
            <span className="font-medium text-foreground">{actorLocation}</span>
          </div>

          <div className="sm:col-span-2">
            <span className="text-muted-foreground block text-[11px]">User agent / Client & Device</span>
            <span className="font-medium text-foreground break-words">{actorClient}</span>
          </div>
        </div>
      </div>

      {/* SECTION 4: CHANGES MADE */}
      <div className="space-y-2 border-b border-border/60 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
            <Layers className="h-4 w-4 text-primary shrink-0" />
            <span>4. Changes made</span>
          </div>
        </div>

        <div className="pt-1 pl-6 space-y-3">
          {modifiedProperties.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              Microsoft did not include property-level changes for this event.
            </p>
          ) : (
            modifiedProperties.map((item, idx) => (
              <div key={idx} className="rounded-lg border border-border bg-card p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-1.5">
                  <span className="font-semibold text-foreground break-all">{item.property}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] gap-1 text-muted-foreground shrink-0"
                    onClick={() =>
                      copyToClipboard(
                        `Property: ${item.property}\nBefore: ${formatVal(item.beforeVal)}\nAfter: ${formatVal(item.afterVal)}`,
                        `prop-${idx}`
                      )
                    }
                  >
                    {copiedSection === `prop-${idx}` ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                  <div className="bg-muted/30 rounded p-2 border border-border/30">
                    <span className="text-muted-foreground block font-medium uppercase text-[10px] tracking-wider mb-1">
                      Before
                    </span>
                    <pre className="font-mono whitespace-pre-wrap break-all text-foreground leading-relaxed">
                      {formatVal(item.beforeVal)}
                    </pre>
                  </div>

                  <div className="bg-muted/30 rounded p-2 border border-border/30">
                    <span className="text-primary block font-medium uppercase text-[10px] tracking-wider mb-1">
                      After
                    </span>
                    <pre className="font-mono whitespace-pre-wrap break-all text-foreground leading-relaxed">
                      {formatVal(item.afterVal)}
                    </pre>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* SECTION 5: ACCESS AND PERMISSIONS */}
      <div className="space-y-2 border-b border-border/60 pb-4">
        <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
          <Shield className="h-4 w-4 text-primary shrink-0" />
          <span>5. {isOnlyChangedIdentity ? 'Access affected by this change' : 'Access and permissions'}</span>
        </div>

        <div className="pt-1 pl-6">
          {!hasAccessInfo ? (
            <p className="text-xs text-muted-foreground italic">
              Access assignments are not included in this event.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {apiPermission && (
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground block text-[11px]">API permission name</span>
                  <span className="font-medium text-foreground break-all">{formatVal(apiPermission)}</span>
                </div>
              )}

              {permissionType && (
                <div>
                  <span className="text-muted-foreground block text-[11px]">Permission type</span>
                  <span className="font-medium text-foreground">{permissionType}</span>
                </div>
              )}

              {consentType && (
                <div>
                  <span className="text-muted-foreground block text-[11px]">Consent type</span>
                  <span className="font-medium text-foreground">{consentType}</span>
                </div>
              )}

              {grantedScope && (
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground block text-[11px]">Granted scope</span>
                  <span className="font-mono text-[11px] text-foreground break-all">{formatVal(grantedScope)}</span>
                </div>
              )}

              {resourceApi && (
                <div>
                  <span className="text-muted-foreground block text-[11px]">Resource API</span>
                  <span className="font-medium text-foreground break-all">{resourceApi}</span>
                </div>
              )}

              {appRole && (
                <div>
                  <span className="text-muted-foreground block text-[11px]">App role</span>
                  <span className="font-medium text-foreground break-all">{appRole}</span>
                </div>
              )}

              {assignedTo && (
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground block text-[11px]">Assigned identity / Target</span>
                  <span className="font-medium text-foreground break-all">{assignedTo}</span>
                </div>
              )}

              {grantingAdmin && (
                <div>
                  <span className="text-muted-foreground block text-[11px]">Granting administrator</span>
                  <span className="font-medium text-foreground break-all">{grantingAdmin}</span>
                </div>
              )}

              {consentStatus && (
                <div>
                  <span className="text-muted-foreground block text-[11px]">Status</span>
                  <span className="font-medium text-foreground">{consentStatus}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SECTION 6: TARGET RESOURCES */}
      <div className="space-y-2 border-b border-border/60 pb-4">
        <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
          <Key className="h-4 w-4 text-primary shrink-0" />
          <span>6. Target resources</span>
        </div>

        <div className="pt-1 pl-6">
          {targets.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No target resources listed.
            </p>
          ) : (
            <div className="space-y-2">
              {targets.map((t, idx) => (
                <div key={idx} className="rounded-lg border border-border bg-card p-2.5 text-xs space-y-1">
                  <div className="font-medium text-foreground break-words">{t.displayName}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    {t.targetType && <span>Type: {t.targetType}</span>}
                    {t.objectId && <span className="font-mono break-all">Object ID: {t.objectId}</span>}
                    {t.upn && <span className="break-all">UPN: {t.upn}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SECTION 7: TECHNICAL DETAILS */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
          <Info className="h-4 w-4 text-primary shrink-0" />
          <span>7. Technical details</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 pl-6">
          <div>
            <span className="text-muted-foreground block text-[11px]">Tenant</span>
            <span className="font-medium text-foreground break-words">{event.tenantName} ({event.tenantId})</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Logged-by service</span>
            <span className="font-medium text-foreground">{event.source} ({event.provider})</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Operation type</span>
            <span className="font-medium text-foreground break-words">{event.title}</span>
          </div>

          <div>
            <span className="text-muted-foreground block text-[11px]">Original UTC timestamp</span>
            <span className="font-mono text-[11px] text-foreground">{event.ts}</span>
          </div>
        </div>

        <div className="pt-2 pl-6">
          <button
            type="button"
            onClick={() => setShowRawJson(!showRawJson)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
          >
            {showRawJson ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>Raw Event JSON</span>
          </button>

          {showRawJson && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground font-mono">Full JSON Payload</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] gap-1 text-muted-foreground"
                  onClick={() => copyToClipboard(pretty(event), 'rawJson')}
                >
                  {copiedSection === 'rawJson' ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedSection === 'rawJson' ? 'Copied' : 'Copy JSON'}</span>
                </Button>
              </div>
              <pre className="text-xs font-mono rounded-lg border border-border bg-muted/40 p-3 overflow-x-auto whitespace-pre-wrap break-all text-foreground max-h-60 leading-relaxed">
                {pretty(event)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   NON-APP EVENT DETAILS COMPONENT (PRESERVED)
   ========================================================================= */

function NonAppEventDetails({
  event,
  copiedSection,
  copyToClipboard,
}: {
  event: ChangeEvent
  copiedSection: string | null
  copyToClipboard: (text: string, label: string) => void
}) {
  return (
    <>
      {/* Event Metadata Grid */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3 shadow-xs">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Event Context & Principal
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {/* Timestamp */}
          <div>
            <span className="text-muted-foreground block text-[11px]">Timestamp</span>
            <span className="font-medium text-foreground">{fmt(event.ts)}</span>
          </div>

          {/* Category */}
          <div>
            <span className="text-muted-foreground block text-[11px]">Category</span>
            <span className="font-medium text-foreground">{event.category}</span>
          </div>

          {/* Actor */}
          <div className="sm:col-span-2">
            <span className="text-muted-foreground block text-[11px]">Actor (User / App)</span>
            <span className="font-medium text-foreground break-all">{event.actor ?? '—'}</span>
          </div>

          {/* Affected Target */}
          <div className="sm:col-span-2">
            <span className="text-muted-foreground block text-[11px]">Affected Target / Resource</span>
            <span className="font-medium text-foreground break-all">{event.target ?? '—'}</span>
          </div>

          {/* Event Source */}
          <div>
            <span className="text-muted-foreground block text-[11px]">Source</span>
            <span className="font-medium text-foreground">{event.source}</span>
          </div>

          {/* Provider */}
          <div>
            <span className="text-muted-foreground block text-[11px]">Provider</span>
            <span className="font-medium text-foreground">{event.provider}</span>
          </div>

          {/* Location */}
          <div>
            <span className="text-muted-foreground block text-[11px]">Location</span>
            <span className="font-medium text-foreground">{fmtLocation(event)}</span>
          </div>

          {/* IP Address */}
          <div>
            <span className="text-muted-foreground block text-[11px]">IP Address</span>
            <span className="font-mono text-foreground font-medium">{event.ip ?? '—'}</span>
          </div>

          {/* Client App / Device */}
          <div className="sm:col-span-2">
            <span className="text-muted-foreground block text-[11px]">Client & Device</span>
            <span className="font-medium text-foreground break-words">{fmtClient(event)}</span>
          </div>

          {/* Correlation ID if present */}
          {event.correlationId && (
            <div className="sm:col-span-2">
              <span className="text-muted-foreground block text-[11px]">Correlation ID</span>
              <span className="font-mono text-[11px] text-foreground break-all">{event.correlationId}</span>
            </div>
          )}
        </div>
      </div>

      {/* Before State */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            State Before Change
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1 text-muted-foreground"
            onClick={() => copyToClipboard(pretty(event.before), 'before')}
          >
            {copiedSection === 'before' ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
            <span>{copiedSection === 'before' ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
        <pre className="text-xs font-mono rounded-lg border border-border bg-muted/40 p-3 overflow-x-auto whitespace-pre-wrap break-all text-foreground max-h-60 leading-relaxed">
          {pretty(event.before)}
        </pre>
      </div>

      {/* After State */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            State After Change
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1 text-muted-foreground"
            onClick={() => copyToClipboard(pretty(event.after), 'after')}
          >
            {copiedSection === 'after' ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
            <span>{copiedSection === 'after' ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
        <pre className="text-xs font-mono rounded-lg border border-border bg-muted/40 p-3 overflow-x-auto whitespace-pre-wrap break-all text-foreground max-h-60 leading-relaxed">
          {pretty(event.after)}
        </pre>
      </div>

      {/* Recovery Guidance if available */}
      {event.recoveryGuidance?.length ? (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-foreground">
          <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Recommended Recovery Steps</span>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
            {event.recoveryGuidance.map((step, idx) => (
              <li key={idx} className="leading-relaxed break-words">
                {step}
              </li>
            ))}
          </ol>
          <div className="pt-2 text-[11px] text-muted-foreground italic border-t border-amber-500/20">
            HawkView does not automatically revert security policies. Review evidence before approving actions.
          </div>
        </div>
      ) : null}
    </>
  )
}
