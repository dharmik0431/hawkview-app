import { BadRequestException } from '@nestjs/common'

const MICROSOFT_APPLICATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const EXCHANGE_RBAC_SETUP = Object.freeze({
  permission: 'Exchange.ManageAsAppV2',
  access: 'READ_ONLY',
  scope: 'ALL_EXCHANGE_RECIPIENTS',
  parentRoleName: 'View-Only Recipients',
  managementRoleName: 'HawkView Get-Mailbox Read Only',
  roleGroupName: 'HawkView Exchange Read Only',
  allowedCmdlets: ['Get-Mailbox'] as const,
  docsUrl:
    'https://learn.microsoft.com/en-us/exchange/reference/admin-api-authentication',
})

export type ExchangeRbacSetupContract = {
  contractVersion: 1
  applicationId: string
  permission: typeof EXCHANGE_RBAC_SETUP.permission
  access: typeof EXCHANGE_RBAC_SETUP.access
  scope: typeof EXCHANGE_RBAC_SETUP.scope
  parentRoleName: typeof EXCHANGE_RBAC_SETUP.parentRoleName
  managementRoleName: typeof EXCHANGE_RBAC_SETUP.managementRoleName
  roleGroupName: typeof EXCHANGE_RBAC_SETUP.roleGroupName
  allowedCmdlets: ['Get-Mailbox']
  setupScript: string
  docsUrl: typeof EXCHANGE_RBAC_SETUP.docsUrl
}

function normalizeApplicationId(applicationId: string) {
  const normalized = applicationId.trim().toLowerCase()
  if (!MICROSOFT_APPLICATION_ID.test(normalized)) {
    throw new BadRequestException(
      'The Microsoft application ID for Exchange setup is invalid.',
    )
  }
  return normalized
}

export function buildExchangeRbacSetup(
  applicationId: string,
): ExchangeRbacSetupContract {
  const normalizedApplicationId = normalizeApplicationId(applicationId)
  const setupScript = String.raw`# HawkView least-privilege Exchange setup
# Run as a customer Exchange Administrator. This assigns the APP only Get-Mailbox.
$ErrorActionPreference = 'Stop'
$ApplicationId = '${normalizedApplicationId}'
$RoleName = '${EXCHANGE_RBAC_SETUP.managementRoleName}'
$RoleGroupName = '${EXCHANGE_RBAC_SETUP.roleGroupName}'
$ParentRoleName = '${EXCHANGE_RBAC_SETUP.parentRoleName}'
$AllowedCmdlet = 'Get-Mailbox'

Connect-MgGraph -Scopes 'Application.Read.All'
$matches = @(Get-MgServicePrincipal -Filter "appId eq '$ApplicationId'" -All)
if ($matches.Count -ne 1) { throw "Expected exactly one customer-tenant service principal for application $ApplicationId." }
$EntraServicePrincipal = $matches[0]

Connect-ExchangeOnline -ShowBanner:$false
$ExchangeServicePrincipal = @(Get-ServicePrincipal | Where-Object { $_.AppId -eq $ApplicationId })
if ($ExchangeServicePrincipal.Count -gt 1) { throw "More than one Exchange service-principal pointer exists for application $ApplicationId." }
if ($ExchangeServicePrincipal.Count -eq 0) {
  New-ServicePrincipal -AppId $ApplicationId -ObjectId $EntraServicePrincipal.Id -DisplayName 'HawkView Tenant Connector'
  $ExchangeServicePrincipal = @(Get-ServicePrincipal | Where-Object { $_.AppId -eq $ApplicationId })
}
if ($ExchangeServicePrincipal.Count -ne 1) { throw "HawkView Exchange service-principal registration could not be verified." }

$Role = Get-ManagementRole -Identity $RoleName -ErrorAction SilentlyContinue
if (-not $Role) {
  New-ManagementRole -Name $RoleName -Parent $ParentRoleName | Out-Null
  Get-ManagementRoleEntry "$RoleName\\*" |
    Where-Object { $_.Name -ne $AllowedCmdlet } |
    Remove-ManagementRoleEntry -Confirm:$false
}
$RoleEntries = @(Get-ManagementRoleEntry "$RoleName\\*")
if ($RoleEntries.Count -ne 1 -or $RoleEntries[0].Name -ne $AllowedCmdlet) {
  throw "Existing management role '$RoleName' is not the expected Get-Mailbox-only role. Review it manually; HawkView did not alter it."
}

$RoleGroup = Get-RoleGroup -Identity $RoleGroupName -ErrorAction SilentlyContinue
if (-not $RoleGroup) {
  New-RoleGroup -Name $RoleGroupName -Roles $RoleName | Out-Null
} else {
  $ExistingRoleAssignments = @(Get-ManagementRoleAssignment -RoleAssignee $RoleGroupName -Delegating:$false)
  $UnexpectedRoleAssignments = @($ExistingRoleAssignments | Where-Object { $_.Role -ne $RoleName })
  if ($UnexpectedRoleAssignments.Count -gt 0) {
    throw "Existing role group '$RoleGroupName' has additional Exchange roles. Review it manually; HawkView did not alter it."
  }
  if (@($ExistingRoleAssignments | Where-Object { $_.Role -eq $RoleName }).Count -eq 0) {
    New-ManagementRoleAssignment -Role $RoleName -SecurityGroup $RoleGroupName | Out-Null
  }
}

$ExistingMember = @(Get-RoleGroupMember -Identity $RoleGroupName -ResultSize Unlimited |
  Where-Object { $_.ExternalDirectoryObjectId -eq $EntraServicePrincipal.Id })
if ($ExistingMember.Count -eq 0) {
  Add-RoleGroupMember -Identity $RoleGroupName -Member $ExchangeServicePrincipal[0].Identity
}

$VerifiedEntries = @(Get-ManagementRoleEntry "$RoleName\\*")
$VerifiedRoleAssignments = @(Get-ManagementRoleAssignment -RoleAssignee $RoleGroupName -Delegating:$false)
$VerifiedMember = @(Get-RoleGroupMember -Identity $RoleGroupName -ResultSize Unlimited |
  Where-Object { $_.ExternalDirectoryObjectId -eq $EntraServicePrincipal.Id })
if ($VerifiedEntries.Count -ne 1 -or
    $VerifiedEntries[0].Name -ne $AllowedCmdlet -or
    $VerifiedRoleAssignments.Count -ne 1 -or
    $VerifiedRoleAssignments[0].Role -ne $RoleName -or
    $VerifiedMember.Count -ne 1) {
  throw 'HawkView least-privilege Exchange RBAC verification failed.'
}
[pscustomobject]@{
  ApplicationId = $ApplicationId
  RoleGroup = $RoleGroupName
  AllowedCmdlet = $AllowedCmdlet
  Access = 'Read-only recipient configuration'
  Status = 'Configured'
}`

  return {
    contractVersion: 1,
    applicationId: normalizedApplicationId,
    permission: EXCHANGE_RBAC_SETUP.permission,
    access: EXCHANGE_RBAC_SETUP.access,
    scope: EXCHANGE_RBAC_SETUP.scope,
    parentRoleName: EXCHANGE_RBAC_SETUP.parentRoleName,
    managementRoleName: EXCHANGE_RBAC_SETUP.managementRoleName,
    roleGroupName: EXCHANGE_RBAC_SETUP.roleGroupName,
    allowedCmdlets: [...EXCHANGE_RBAC_SETUP.allowedCmdlets],
    setupScript,
    docsUrl: EXCHANGE_RBAC_SETUP.docsUrl,
  }
}
