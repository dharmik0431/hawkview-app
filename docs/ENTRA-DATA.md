# Microsoft Entra data

HawkView reads Entra data from Microsoft Graph during an explicit tenant sync,
stores the latest successful snapshot in PostgreSQL, and serves the UI from the
database. Opening an Entra page does not call Microsoft Graph.

## Synchronized modules

- Users, assigned licenses, groups, and group memberships
- Per-user MFA registration and registered method names
- Authentication-method policy
- Conditional Access policies
- Named locations
- Interactive sign-ins from the last 30 days
- Registered devices and their registered owners
- Direct Microsoft Entra directory role assignments
- Enterprise applications/service principals used to resolve Conditional
  Access application IDs into readable names

Each module has an independent `SyncState`. A missing permission can therefore
fail one module without erasing or blocking data from the others. HawkView keeps
the last successful snapshot visible and exposes the module error in the API.

## Microsoft Graph application permissions

- `Organization.Read.All`
- `User.Read.All`
- `GroupMember.Read.All`
- `AuditLog.Read.All`
- `Policy.Read.All`
- `Policy.Read.AuthenticationMethod`
- `Device.Read.All`
- `RoleManagement.Read.Directory`
- `Application.Read.All`
- `Sites.Read.All` (used by the SharePoint site-inventory module)

All are read-only application permissions and require Microsoft administrator
consent. Customer-managed connectors need the same permissions as the shared
HawkView-managed connector.

## Intentional boundaries

Mailbox usage is an Exchange dataset and OneDrive usage is a SharePoint dataset.
Those fields remain **Not synchronized** until their respective modules are
implemented. HawkView must not invent a disabled MFA state or an empty security
finding when Microsoft did not grant access to a dataset.
