export type ActivityTab = 'signins' | 'audit'

export type SignInEvent = {
  id: string
  createdAt: string

  userDisplayName: string
  userPrincipalName: string
  userId?: string

  appDisplayName: string
  appId?: string
  status: 'Success' | 'Failure'
  failureReason?: string
  errorCode?: string
  additionalDetails?: string

  conditionalAccess?: 'Applied' | 'Not Applied'
  appliedCaPolicies?: string[]
  authMethod?: string

  ipAddress?: string
  location?: string
  country?: string
  city?: string

  // extra fields for drawer
  clientAppUsed?: string
  device?: string
  os?: string
  browser?: string
  managedState?: string
  userAgent?: string
  tenantName?: string
  tenantId?: string
  correlationId?: string
  requestId?: string
  riskLevel?: string
  raw?: any
}

export type AuditEvent = {
  id: string
  createdAt: string
  activity: string
  category?: string
  operationType?: string
  result?: string
  resultReason?: string
  correlationId?: string
  service?: string
  actor?: string
  actorPrincipalName?: string
  actorType?: string
  actorId?: string
  target?: string
  targetType?: string
  targetId?: string
  targetResources?: any[]
  modifiedProperties?: Array<{
    name: string
    oldValue?: string
    newValue?: string
  }>
  tenantName?: string
  tenantId?: string
  raw?: any
}
