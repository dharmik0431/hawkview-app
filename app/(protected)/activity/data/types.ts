  export type ActivityTab = 'signins' | 'audit'

  export type SignInEvent = {
    id: string
    createdAt: string

    userDisplayName: string
    userPrincipalName: string

    appDisplayName: string
    status: 'Success' | 'Failure'

    conditionalAccess?: 'Applied' | 'Not Applied'

    ipAddress?: string
    location?: string

    // extra fields for drawer
    clientAppUsed?: string
    device?: string
    os?: string
    userAgent?: string
    tenantName?: string
  }

  export type AuditEvent = {
    id: string
    createdAt: string
    activity: string
    category?: string
    operationType?: string
    result?: string
    service?: string
    actor?: string
    target?: string
    resultReason?: string
    correlationId?: string
  }
