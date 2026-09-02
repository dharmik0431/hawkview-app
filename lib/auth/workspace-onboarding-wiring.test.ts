import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const protectedRoute = readFileSync(
  new URL('../../components/auth/protected-route.tsx', import.meta.url),
  'utf8'
)
const setupScreen = readFileSync(
  new URL('../../components/auth/workspace-onboarding.tsx', import.meta.url),
  'utf8'
)
const profileEditor = readFileSync(
  new URL('../../components/admin/organization-profile-editor.tsx', import.meta.url),
  'utf8'
)
const workspacePage = readFileSync(
  new URL('../../app/(protected)/settings/team/page.tsx', import.meta.url),
  'utf8'
)
const authProvider = readFileSync(
  new URL('../../components/providers/auth-provider.tsx', import.meta.url),
  'utf8'
)

test('protected route blocks product children on required or unverifiable onboarding', () => {
  const gate = protectedRoute.indexOf('onboardingState.onboarding.required')
  const unavailable = protectedRoute.indexOf("onboardingState.state !== 'ready'")
  const children = protectedRoute.lastIndexOf('return children')
  assert.ok(gate > 0 && gate < children)
  assert.ok(unavailable > 0 && unavailable < children)
  assert.match(protectedRoute, /WorkspaceOnboardingGate/)
  assert.match(protectedRoute, /WorkspaceOnboardingUnavailable/)
})

test('setup completion is durable, identity-cache safe, and never accepts a slug', () => {
  assert.match(setupScreen, /apiClient\.post\('\/api\/workspace\/onboarding'/)
  assert.match(setupScreen, /clearIdentityBoundCaches\(\)/)
  assert.match(setupScreen, /await refreshSession\(\)/)
  assert.match(setupScreen, /workspaceOnboardingState\(refreshed\)/)
  assert.doesNotMatch(setupScreen, /name=["']slug["']/i)
  assert.doesNotMatch(setupScreen, /apiClient\.get\('\/api\/tenants/)
})

test('workspace edit uses the founder-scoped endpoint and internal slug stays hidden', () => {
  assert.match(profileEditor, /apiClient\.patch\('\/api\/workspace\/organization'/)
  assert.match(profileEditor, /organizationSettingsPayload/)
  assert.match(profileEditor, /clearIdentityBoundCaches\(\)/)
  assert.match(profileEditor, /await refreshSession\(\)/)
  assert.match(profileEditor, /await onSaved\?\.\(\)/)
  assert.match(profileEditor, /if \(editing\) return/)
  assert.match(profileEditor, /onboarding\.businessDomain/)
  assert.match(workspacePage, /OrganizationProfileEditor/)
  assert.doesNotMatch(workspacePage, /Organization Slug/)
  assert.doesNotMatch(profileEditor, /name=["']slug["']/i)
  assert.match(profileEditor, /does not verify domain ownership/i)
  assert.match(setupScreen, /does not verify domain ownership/i)
})

test('workspace changes propagate across tabs without bypassing identity generation guards', () => {
  assert.match(setupScreen, /publishWorkspaceChange\(identityUser\.id/)
  assert.match(profileEditor, /publishWorkspaceChange\(identityUser\.id/)
  assert.match(authProvider, /subscribeWorkspaceChanges/)
  assert.match(authProvider, /WorkspaceChangeSignalGuard/)
  assert.match(authProvider, /transitionGuard\.current\.current\(\)/)
  assert.match(authProvider, /bootstrapIdentity\(identityUser, ticket\)/)
  assert.match(authProvider, /WorkspaceBootstrapRefreshQueue/)
  assert.match(authProvider, /bootstrapInFlight\.current\?\.promise/)
  assert.match(authProvider, /visibilitychange/)
})

test('Admin workspace reads and mutations carry one URL-selected organization UUID', () => {
  assert.match(workspacePage, /workspaceOrganizationContext\(/)
  assert.match(workspacePage, /searchParams\.get\('organizationId'\)/)
  assert.match(workspacePage, /params: \{ organizationId: selectedOrganizationId \}/)
  assert.match(workspacePage, /organizationId: selectedOrganizationId, role:/)
  assert.match(workspacePage, /organizationId: selectedOrganizationId, status:/)
  assert.match(workspacePage, /organizationId: selectedOrganizationId,\s+email:/)
  assert.match(workspacePage, /password-reset`,\s+\{ organizationId: selectedOrganizationId \}/)
  assert.match(workspacePage, /resend-invite`,\s+\{ organizationId: selectedOrganizationId \}/)
  assert.match(workspacePage, /mfa-reset`,\s+\{ organizationId: selectedOrganizationId \}/)
  assert.match(workspacePage, /undefined,\s+\{ params: \{ organizationId: selectedOrganizationId \} \}/)
  assert.match(workspacePage, /workspaceResponse\?\.organization\.id === selectedOrganizationId/)
  assert.match(workspacePage, /tenantsResponse\?\.filter/)
  assert.match(workspacePage, /tenant\.organization\.id === selectedOrganizationId/)
  assert.match(workspacePage, /WorkspaceOrganizationLoadGuard/)
  assert.match(workspacePage, /adminLoadGuard\.current\.isCurrent/)
  assert.match(workspacePage, /subscribeWorkspaceChanges/)
  assert.match(workspacePage, /onSaved=\{\(\) => loadAllData\(true\)\}/)
  assert.match(workspacePage, /setAccountDrawerMember\(null\)/)
  assert.match(workspacePage, /setSelectedMembershipIds\(new Set\(\)\)/)
  assert.match(workspacePage, /organizationProfileFromWorkspace/)
  assert.match(
    workspacePage,
    /organizationProfile && workspace\?\.canEditOrganization === true/
  )
  assert.doesNotMatch(workspacePage, /find\(\(m\) => m\.role === 'MSP_OWNER'\) \|\|/)
})

test('pending invitations and accepted-account password resets remain separate actions', () => {
  assert.match(workspacePage, /member\.hasHawkViewAccount && \(/)
  assert.match(
    workspacePage,
    /action === 'RESEND_INVITE' && m\.hasHawkViewAccount !== false/
  )
  assert.match(
    workspacePage,
    /action === 'PASSWORD_RESET' && m\.hasHawkViewAccount !== true/
  )
  assert.match(workspacePage, /fresh HawkView invitation link/)
  assert.doesNotMatch(
    workspacePage,
    /RESEND_INVITE'[\s\S]{0,500}apiClient\.post\('\/api\/workspace\/members\/invite'/
  )
})

test('team invitation failures preserve the form and use only the safe error contract', () => {
  assert.match(workspacePage, /Invitation request accepted/)
  assert.match(workspacePage, /If eligible, the recipient will receive a HawkView invitation/)
  assert.doesNotMatch(workspacePage, /Invitation sent to/)
  assert.match(workspacePage, /workspaceAdminErrorMessage\(error, fallback\)/)
  assert.match(workspacePage, /const invitationSent = await runAction\(/)
  const failureGuard = workspacePage.indexOf('if (!invitationSent) return')
  const modalClose = workspacePage.indexOf('setInviteModalOpen(false)', failureGuard)
  assert.ok(failureGuard > 0)
  assert.ok(modalClose > failureGuard)
  assert.match(workspacePage, /setNotice\(successNotice\)[\s\S]*return true/)
  assert.match(workspacePage, /catch \(requestError\)[\s\S]*return false/)
})
