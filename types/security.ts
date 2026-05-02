// types/security.ts

export type CaPolicyState = 'ON' | 'REPORT_ONLY' | 'OFF'

export type CaPolicyOrigin =
  | 'MICROSOFT_TEMPLATE'
  | 'CUSTOM'
  | 'MICROSOFT_ENFORCED'

export type CaPlatform = 'Windows' | 'macOS' | 'iOS' | 'Android' | 'Linux'

export type CaAssignmentBlock = {
  include: string[] // e.g. ['All Users'] or ['Group: IT']
  exclude?: string[] // e.g. ['Guest Users']
}

export type ConditionalAccessPolicy = {
  id: string
  name: string
  state: CaPolicyState
  origin: CaPolicyOrigin

  // quick summary shown in list
  targetSummary: string
  grantSummary: string

  // details shown in drawer (mock now, Graph later)
  assignments: {
    usersAndGroups: CaAssignmentBlock
    cloudApps: { include: string[] }
  }

  conditions?: {
    platforms?: CaPlatform[]
    locations?: string[]
    clientApps?: string[]
    signInRisk?: string[]
    userRisk?: string[]
  }

  accessControls: {
    grant: string[] // e.g. ['Require device to be marked as compliant']
    session?: string[]
  }

  // optional future fields
  lastModifiedAt?: string
}
