export interface HawkViewMembership {
  id: string
  role: 'MSP_OWNER' | 'MSP_ADMIN' | 'MSP_TECHNICIAN' | 'MSP_VIEWER'
  status: 'ACTIVE'
  organization: {
    id: string
    name: string
    slug: string
    status: string
  }
}

export interface HawkViewSession {
  user: {
    id: string
    email: string
    displayName: string | null
    platformRole:
      | 'STANDARD_USER'
      | 'PLATFORM_SUPPORT'
      | 'PLATFORM_ADMIN'
    memberships: HawkViewMembership[]
  }
  signInProvider?: string
}

