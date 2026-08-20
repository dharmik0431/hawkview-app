export interface HawkViewMembership {
  id: string
  role: 'MSP_OWNER' | 'MSP_ADMIN' | 'MSP_TECHNICIAN' | 'MSP_VIEWER'
  status: 'ACTIVE'
  organization: {
    id: string
    name: string
    slug: string
    status: string
    businessDomain?: string | null
    timeZone?: string | null
    onboardingCompletedAt?: string | null
  }
}

export interface HawkViewWorkspaceOnboarding {
  required: boolean
  organizationId: string | null
  organizationName: string | null
  businessDomain: string | null
  businessDomainVerification: 'UNVERIFIED_INFORMATIONAL'
  timeZone: string | null
}

export interface HawkViewSession {
  user: {
    id: string
    email: string
    displayName: string | null
    timeZone: string | null
    dateFormat: string
    timeFormat: '12h' | '24h'
    platformRole:
      | 'STANDARD_USER'
      | 'PLATFORM_SUPPORT'
      | 'PLATFORM_ADMIN'
    memberships: HawkViewMembership[]
  }
  signInProvider?: string
  /**
   * Present on onboarding-aware backends. Its absence is represented in the
   * type for defensive parsing, but the protected route fails closed until
   * the backend supplies it. Never infer it from a generated workspace name.
   */
  workspaceOnboarding?: HawkViewWorkspaceOnboarding
}
