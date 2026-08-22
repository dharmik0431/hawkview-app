import { BadRequestException } from '@nestjs/common'

const MICROSOFT_APPLICATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const EXCHANGE_READ_ONLY_RBAC = Object.freeze({
  permission: 'Exchange.ManageAsAppV2',
  access: 'READ_ONLY',
  parentRoleName: 'View-Only Recipients',
  managementRoleName: 'HawkView Get-Mailbox Read Only',
  roleGroupName: 'HawkView Exchange Read Only',
  allowedCmdlets: ['Get-Mailbox'] as const,
  docsUrl: 'https://learn.microsoft.com/en-us/exchange/reference/admin-api-authentication',
})

function normalizeApplicationId(applicationId: string) {
  const normalized = applicationId.trim().toLowerCase()
  if (!MICROSOFT_APPLICATION_ID.test(normalized)) {
    throw new BadRequestException('The Microsoft application ID for Exchange setup is invalid.')
  }
  return normalized
}

/**
 * Setup itself must be performed by a human authorized to manage Exchange
 * RBAC because Microsoft admin consent cannot create Exchange RBAC objects.
 * The resulting application role is mechanically reduced to Get-Mailbox only
 * and verified before the script reports success.
 */
export function buildExchangeReadOnlyRbacSetup(applicationId: string) {
  const appId = normalizeApplicationId(applicationId)
  const script = String.raw`# HawkView optional Exchange read-only enrichment
# Run once by a human administrator authorized to manage Exchange roles.
# The APP receives Get-Mailbox only.
$ErrorActionPreference = 'Stop'
$ApplicationId = '${appId}'
$RoleName = '${EXCHANGE_READ_ONLY_RBAC.managementRoleName}'
$RoleGroupName = '${EXCHANGE_READ_ONLY_RBAC.roleGroupName}'
$ParentRoleName = '${EXCHANGE_READ_ONLY_RBAC.parentRoleName}'
$AllowedCmdlet = 'Get-Mailbox'

Connect-MgGraph -Scopes 'Application.Read.All'
$Matches = @(Get-MgServicePrincipal -Filter "appId eq '$ApplicationId'" -All)
if ($Matches.Count -ne 1) { throw "Expected exactly one service principal for application $ApplicationId." }
$EntraServicePrincipal = $Matches[0]

Connect-ExchangeOnline -ShowBanner:$false
$ExchangeServicePrincipal = @(Get-ServicePrincipal | Where-Object { $_.AppId -eq $ApplicationId })
if ($ExchangeServicePrincipal.Count -gt 1) { throw "More than one Exchange service-principal pointer exists for $ApplicationId." }
if ($ExchangeServicePrincipal.Count -eq 0) {
  New-ServicePrincipal -AppId $ApplicationId -ObjectId $EntraServicePrincipal.Id -DisplayName 'HawkView Tenant Connector'
  $ExchangeServicePrincipal = @(Get-ServicePrincipal | Where-Object { $_.AppId -eq $ApplicationId })
}
if ($ExchangeServicePrincipal.Count -ne 1) { throw 'The Exchange service-principal pointer could not be verified.' }

$Role = Get-ManagementRole -Identity $RoleName -ErrorAction SilentlyContinue
if (-not $Role) {
  New-ManagementRole -Name $RoleName -Parent $ParentRoleName | Out-Null
  Get-ManagementRoleEntry "$RoleName\*" |
    Where-Object { $_.Name -ne $AllowedCmdlet } |
    Remove-ManagementRoleEntry -Confirm:$false
}
$Entries = @(Get-ManagementRoleEntry "$RoleName\*")
if ($Entries.Count -ne 1 -or $Entries[0].Name -ne $AllowedCmdlet) {
  throw "Role '$RoleName' is not exactly Get-Mailbox only. HawkView stopped without broadening it."
}

$Group = Get-RoleGroup -Identity $RoleGroupName -ErrorAction SilentlyContinue
if (-not $Group) {
  New-RoleGroup -Name $RoleGroupName -Roles $RoleName | Out-Null
} else {
  $Assignments = @(Get-ManagementRoleAssignment -RoleAssignee $RoleGroupName -Delegating:$false)
  if (@($Assignments | Where-Object { $_.Role -ne $RoleName }).Count -gt 0) {
    throw "Role group '$RoleGroupName' contains an unexpected role. Review it manually."
  }
  if (@($Assignments | Where-Object { $_.Role -eq $RoleName }).Count -eq 0) {
    New-ManagementRoleAssignment -Role $RoleName -SecurityGroup $RoleGroupName | Out-Null
  }
}

$ExistingMember = @(Get-RoleGroupMember -Identity $RoleGroupName -ResultSize Unlimited |
  Where-Object { $_.ExternalDirectoryObjectId -eq $EntraServicePrincipal.Id })
if ($ExistingMember.Count -eq 0) {
  Add-RoleGroupMember -Identity $RoleGroupName -Member $ExchangeServicePrincipal[0].Identity
}

$UnexpectedRoleGroups = @(Get-RoleGroup -ResultSize Unlimited |
  Where-Object { $_.Name -ne $RoleGroupName } |
  Where-Object {
    @(Get-RoleGroupMember -Identity $_.Identity -ResultSize Unlimited -ErrorAction SilentlyContinue |
      Where-Object { $_.ExternalDirectoryObjectId -eq $EntraServicePrincipal.Id }).Count -gt 0
  })
if ($UnexpectedRoleGroups.Count -gt 0) {
  throw 'The HawkView service principal belongs to another Exchange role group. Remove the broader assignment before enabling read-only mode.'
}

$VerifiedEntries = @(Get-ManagementRoleEntry "$RoleName\*")
$VerifiedAssignments = @(Get-ManagementRoleAssignment -RoleAssignee $RoleGroupName -Delegating:$false)
$VerifiedMember = @(Get-RoleGroupMember -Identity $RoleGroupName -ResultSize Unlimited |
  Where-Object { $_.ExternalDirectoryObjectId -eq $EntraServicePrincipal.Id })
if ($VerifiedEntries.Count -ne 1 -or
    $VerifiedEntries[0].Name -ne $AllowedCmdlet -or
    $VerifiedAssignments.Count -ne 1 -or
    $VerifiedAssignments[0].Role -ne $RoleName -or
    $VerifiedMember.Count -ne 1) {
  throw 'HawkView Exchange read-only RBAC verification failed.'
}
[pscustomobject]@{
  ApplicationId = $ApplicationId
  RoleGroup = $RoleGroupName
  AllowedCmdlet = $AllowedCmdlet
  WriteCmdlets = 0
  Status = 'Configured'
}`

  return {
    contractVersion: 2 as const,
    applicationId: appId,
    permission: EXCHANGE_READ_ONLY_RBAC.permission,
    access: EXCHANGE_READ_ONLY_RBAC.access,
    roleGroupName: EXCHANGE_READ_ONLY_RBAC.roleGroupName,
    managementRoleName: EXCHANGE_READ_ONLY_RBAC.managementRoleName,
    parentRoleName: EXCHANGE_READ_ONLY_RBAC.parentRoleName,
    allowedCmdlets: [...EXCHANGE_READ_ONLY_RBAC.allowedCmdlets],
    collectedFields: ['Send on behalf delegates', 'Maximum send size'] as const,
    unavailableFields: [
      'Full Access delegates',
      'Send As delegates',
      'Mailbox retention-policy assignment',
      'Rule creator and timestamps',
    ] as const,
    setupScript: script,
    docsUrl: EXCHANGE_READ_ONLY_RBAC.docsUrl,
  }
}
