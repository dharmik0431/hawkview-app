import { z } from 'zod'

const MicrosoftAccessStepSchema = z.object({
  required: z.literal(true),
  status: z.enum(['VERIFIED', 'CONSENT_REQUIRED', 'ERROR']),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}).strict()

const ExchangeReadOnlyStepSchema = z.object({
  required: z.literal(false),
  status: z.enum(['VERIFIED', 'DEFERRED', 'RBAC_REQUIRED', 'CONSENT_REQUIRED']),
  enabledAt: z.string().datetime().nullable(),
  deferredAt: z.string().datetime().nullable(),
  permission: z.literal('Exchange.ManageAsAppV2'),
  capability: z.literal('Get-Mailbox only'),
  disclaimer: z.string().min(1).max(1000),
}).strict()

const ReportVisibilityStepSchema = z.object({
  required: z.literal(false),
  status: z.enum([
    'VERIFIED',
    'DEFERRED',
    'ACTION_REQUIRED',
    'CHECK_REQUIRED',
    'PERMISSION_REQUIRED',
  ]),
  identifiersVisible: z.boolean().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
  deferredAt: z.string().datetime().nullable(),
  permission: z.literal('ReportSettings.Read.All'),
  adminCenterUrl: z.literal('https://admin.microsoft.com/#/Settings/Services'),
  settingPath: z.tuple([
    z.literal('Settings'),
    z.literal('Org settings'),
    z.literal('Services'),
    z.literal('Reports'),
  ]),
  settingLabel: z.literal('Conceal user, group, and site names in all reports'),
  disclaimer: z.string().min(1).max(1000),
}).strict()

export const TenantOnboardingSchema = z.object({
  version: z.literal(1),
  tenant: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(253),
    primaryDomain: z.string().nullable(),
    microsoftTenantId: z.string().uuid(),
  }).strict(),
  completedAt: z.string().datetime().nullable(),
  canFinish: z.boolean(),
  steps: z.object({
    microsoftAccess: MicrosoftAccessStepSchema,
    exchangeReadOnly: ExchangeReadOnlyStepSchema,
    reportVisibility: ReportVisibilityStepSchema,
  }).strict(),
}).strict()

export const ReportVisibilityVerificationSchema = z.object({
  verification: z.object({
    status: z.enum([
      'READY',
      'IDENTIFIERS_CONCEALED',
      'MISSING_PERMISSION',
      'CONNECTION_INCOMPLETE',
      'TOKEN_UNAVAILABLE',
      'MICROSOFT_DENIED',
      'MICROSOFT_UNAVAILABLE',
      'INVALID_RESPONSE',
      'NETWORK_ERROR',
    ]),
    identifiersVisible: z.boolean().nullable(),
    retryable: z.boolean(),
    checkedAt: z.string().datetime(),
  }).strict(),
  onboarding: TenantOnboardingSchema,
}).strict()

export type TenantOnboarding = z.infer<typeof TenantOnboardingSchema>
export type ReportVisibilityVerification = z.infer<
  typeof ReportVisibilityVerificationSchema
>['verification']
export type ReportVisibilityVerificationResult = z.infer<
  typeof ReportVisibilityVerificationSchema
>

export function onboardingNextStep(state: TenantOnboarding) {
  if (state.steps.microsoftAccess.status !== 'VERIFIED') return 'microsoftAccess' as const
  if (!['VERIFIED', 'DEFERRED'].includes(state.steps.exchangeReadOnly.status)) {
    return 'exchangeReadOnly' as const
  }
  if (!['VERIFIED', 'DEFERRED'].includes(state.steps.reportVisibility.status)) {
    return 'reportVisibility' as const
  }
  return 'complete' as const
}
