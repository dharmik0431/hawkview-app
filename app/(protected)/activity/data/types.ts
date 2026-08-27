export type ActivityTab = 'signins' | 'audit'

export type SignInEvent = {
  /** Internal rendering identity. Never present as Microsoft evidence. */
  rowKey: string
  /** Microsoft-supplied event identifier, when reported. */
  eventId?: string
  createdAt: string

  userDisplayName: string
  userPrincipalName: string
  userId?: string

  appDisplayName: string
  appId?: string
  status: 'Success' | 'Failure' | 'Not reported'
  failureReason?: string
  errorCode?: string
  additionalDetails?: string

  conditionalAccess?: 'Applied' | 'Not Applied' | 'Not reported'
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
}

export type AuditTargetResource = {
  displayName?: string
  userPrincipalName?: string
  id?: string
  type?: string
}

export type AuditModifiedProperty = {
  name: string
}

export type AuditEvent = {
  /** Internal rendering identity. Never present as Microsoft evidence. */
  rowKey: string
  /** Microsoft-supplied event identifier, when reported. */
  eventId?: string
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
  targetResources?: AuditTargetResource[]
  modifiedProperties?: AuditModifiedProperty[]
  tenantName?: string
  tenantId?: string
}
