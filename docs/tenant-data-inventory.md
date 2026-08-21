# HawkView tenant data inventory

This document maps the current tenant frontend to the backend data that must
support it. The frontend is a presentation layer only. Live tenant pages must
read saved data from the HawkView API and must never call Microsoft directly.

## Status key

- **Live** — synchronized to PostgreSQL and returned by the API.
- **In progress** — included in the current database slice.
- **Planned** — a known dataset with a supported source.
- **Separate connector** — cannot be completed by the base Microsoft Graph
  connector alone.
- **External service** — requires a non-Microsoft lookup.
- **Do not show yet** — the UI must show an honest not-synchronized state.

## Office 365

| Frontend data                        | Source                                 | Access                          | Status           |
| ------------------------------------ | -------------------------------------- | ------------------------------- | ---------------- |
| Organization name and primary domain | Microsoft Graph organization           | `Organization.Read.All`         | Live             |
| Verified domains                     | Microsoft Graph organization           | `Organization.Read.All`         | Live             |
| Purchased licenses and utilization   | Microsoft Graph subscribed SKUs        | `Organization.Read.All`         | Live             |
| User license assignments             | Microsoft Graph users delta            | `User.Read.All`                 | Live             |
| SPF record                           | Public DNS TXT lookup                  | No Microsoft permission         | Planned          |
| DMARC record                         | Public DNS TXT lookup                  | No Microsoft permission         | Planned          |
| DKIM record and enabled state        | DNS plus Exchange configuration        | Exchange access may be required | Planned          |
| Domain blacklist/reputation          | Reputable external reputation provider | External service                | External service |
| Microsoft Secure Score               | Microsoft Graph security score         | Additional security permission  | Planned          |

## Entra ID

| Frontend data                              | Source                                          | Access                                             | Status      |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------- | ----------- |
| Users, guests, enabled state, email        | Microsoft Graph users delta                     | `User.Read.All`                                    | Live        |
| Assigned user licenses                     | Microsoft Graph users delta                     | `User.Read.All`                                    | Live        |
| Groups and memberships                     | Microsoft Graph groups and membership endpoints | `GroupMember.Read.All`                             | In progress |
| Directory roles and administrators         | Microsoft Graph role management                 | `RoleManagement.Read.Directory`                    | Planned     |
| MFA registration coverage                  | Microsoft Graph authentication-method reports   | Additional authentication/report permission        | Planned     |
| Individual authentication methods          | Microsoft Graph authentication methods          | Additional authentication-method permission        | Planned     |
| Conditional Access policies                | Microsoft Graph Conditional Access              | `Policy.Read.All`                                  | Implemented |
| Conditional Access cloud-app display names | Microsoft Graph service principals              | `Application.Read.All`                             | Implemented |
| Named locations                            | Microsoft Graph Conditional Access              | `Policy.Read.All`                                  | Planned     |
| Full sign-in events and locations          | Microsoft Graph sign-in logs                    | `AuditLog.Read.All`; tenant licensing also applies | Implemented |
| Limited login activity fallback            | Microsoft 365 unified audit feed                | Office 365 Management APIs `ActivityFeed.Read`     | Implemented |
| Devices                                    | Microsoft Graph devices                         | `Device.Read.All`                                  | Planned     |
| Risky users and sign-ins                   | Microsoft Graph Identity Protection             | Additional identity-risk permission and licensing  | Planned     |

## Exchange Online

| Frontend data                                    | Source                                                                          | Access                                      | Status             |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------- | ------------------ |
| User/shared/room/equipment mailboxes             | Exchange Online Admin API `Get-Mailbox`                                         | `Exchange.ManageAsAppV2` + HawkView custom Get-Mailbox-only role | Implemented |
| Mailbox size, item count, archive and last logon | Exchange Online                                                                 | Exchange application access and scoped RBAC | Separate connector |
| Inbox and transport rules                        | Microsoft Graph for limited mailbox rules; Exchange Online for tenant mail flow | Additional mailbox or Exchange access       | Separate connector |
| Accepted domains                                 | Exchange Online                                                                 | Exchange application access and scoped RBAC | Separate connector |
| Distribution and dynamic groups                  | Exchange Online / Microsoft Graph groups                                        | Group and/or Exchange access                | Planned            |
| Delegation and forwarding                        | Exchange Online                                                                 | Current Graph evidence where supported; no broad Exchange write role | Partial |

## SharePoint and OneDrive

| Frontend data                                         | Source                                      | Access                                                        | Status             |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------ |
| Site inventory, URLs, and drive quota                 | Microsoft Graph sites and drives            | `Sites.Read.All`                                              | Implemented        |
| Site usage, owner, type, and last activity            | Microsoft 365 usage reports                 | `Reports.Read.All`                                            | Implemented        |
| Primary document-library storage used/quota           | Microsoft Graph drives                      | `Sites.Read.All`                                              | Implemented        |
| Owners, guests and external sharing                   | Graph sites/groups plus SharePoint settings | Additional site/group access                                  | Planned            |
| OneDrive inventory and usage                          | Microsoft 365 usage reports                 | `Reports.Read.All`                                            | Planned            |
| Exchange mailbox directory and domains                | Microsoft Graph                             | `User.Read.All`, `Domain.Read.All`                            | Implemented        |
| Exchange mailbox usage                                | Microsoft 365 usage reports                 | `Reports.Read.All`                                            | Implemented        |
| Exchange inbox rules                                  | Microsoft Graph                             | `MailboxSettings.Read`                                        | Implemented        |
| Exact recipient types and Exchange-only configuration | Exchange Online Admin API (optional)        | `Exchange.ManageAsAppV2` plus customer-approved Exchange RBAC | Deferred/optional  |
| Recently deleted sites                                | SharePoint admin APIs                       | SharePoint-specific application access                        | Separate connector |

## Teams

The Teams navigation is currently disabled for live Microsoft tenants because
the page still contains prototype-only data. It must remain unavailable until
its data is supplied by the API.

| Frontend data                                            | Source                                  | Access                            | Status             |
| -------------------------------------------------------- | --------------------------------------- | --------------------------------- | ------------------ |
| Teams and channel inventory                              | Microsoft Graph Teams                   | Additional Teams read permissions | Planned            |
| Guest/external exposure                                  | Teams, groups and cross-tenant settings | Multiple additional permissions   | Planned            |
| Messaging, meeting and calling policies                  | Teams administration APIs               | Teams-specific application access | Separate connector |
| Phone numbers, resource accounts and emergency locations | Teams administration APIs               | Teams-specific application access | Separate connector |
| App governance and policy assignments                    | Teams administration APIs               | Teams-specific application access | Separate connector |
| Activity and stale teams                                 | Microsoft 365 usage reports             | `Reports.Read.All`                | Planned            |

## Recommended implementation order

1. Complete user license assignments using the permissions already granted.
2. Add groups and group memberships.
3. Add directory roles and administrators.
4. Add Conditional Access policies and named locations.
5. Add MFA registration coverage.
6. Add sign-in events with bounded retention.
7. Add SharePoint site inventory and usage.
8. Add DNS SPF and DMARC checks.
9. Design the scoped Exchange Online connector.
10. Design the scoped Teams administration connector.

Each resource must have its own synchronization state. A failure in one module
must not erase or block the last successful data from another module.
