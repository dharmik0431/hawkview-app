# Service synchronization freshness

HawkView derives per-service freshness from persisted `SyncState` collector rows;
it does not use `CustomerTenant.updatedAt` or a generic tenant timestamp.

| Service | Owning collectors |
| --- | --- |
| Office 365 | licenses, domains, security defaults, DNS health |
| Entra ID | users, groups, authentication, Conditional Access, named locations, apps, service principals, devices, roles |
| Exchange | mailbox inventory/configuration/usage, accepted domains, rules |
| SharePoint / OneDrive | sites, settings, usage |
| Sign-in logs | sign-ins |
| Audit logs | audit logs / What Changed evidence |

The Render blueprint owns the normal schedule (`*/5 * * * *`). The API exposes it as the `scheduleSource` and derives the next boundary from that published schedule. `lastAttemptCompletedAt` is only populated when `SyncState.lastSuccessfulAt` proves a successful completion; failed attempts never replace prior success evidence.

`TenantHealthSnapshot.payload` keeps its existing health fields and adds the
evaluated `syncFreshness` contract alongside them. This preserves service-state
transition history without a database migration because collector attempts,
errors, and last successes already persist in `SyncState`.
