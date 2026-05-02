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
