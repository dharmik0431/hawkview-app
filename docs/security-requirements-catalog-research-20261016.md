# Security Requirements catalog: evidence-backed expansion

Local product research, 2026-10-16. This is a menu of MSP-selectable minimum settings, **not** a universal score, Microsoft configuration writer, compliance certification, or production release. An MSP names a baseline and chooses only the checks it wants to require; HawkView's starter is optional. A tenant is assessed against its assigned baseline. Each selected check reports **Met**, **Needs action**, or **Unable to assess**, with its source, observed value, evidence time, and expected setting. A license or permission gap must be shown as unavailable evidence, never as a failing tenant setting. An unselected control does not lower a tenant's result.

The local catalog now offers fifteen exact predicates. Ten original fixed predicates read `SHAREPOINT_SETTINGS` or `SECURITY_DEFAULTS`; three additional checks use MSP-set partner-domain, sync-domain-GUID, or deleted-user-retention values from the same SharePoint/OneDrive settings; one narrow Entra FIDO2 method check reads `AUTH_METHOD_POLICIES`; and one MSP-selected verified-domain inventory check reads `DOMAINS`. **HawkView Essentials**, the built-in starter template, still deliberately selects only three broadly useful SharePoint tenant settings: no Anyone links, no SharePoint legacy authentication, and no guest resharing. It is a copyable template, never assigned automatically. Existing saved baselines and assignments were not changed. Three sharing levels remain mutually exclusive choices in one baseline; the server enforces that exclusion as well as the editor. Successful resource state, correlated attempt/observation/success clocks, supported record shape, and age at most 26 hours are required before any check can pass or fail. This is a freshness/shape guard, not proof that Microsoft enforced a policy or that every relevant object was collected.

The starter intentionally does **not** require Entra security defaults: a licensed MSP may use Conditional Access instead, and HawkView does not yet evaluate its effective coverage. It also does not default to internal-only sharing, domain-joined-device sync, or idle sign-out, because those can conflict with legitimate collaboration and device strategies. Exchange and broader Microsoft 365 governance checks are not included until their evidence contracts exist; the narrow verified-domain inventory check does not establish mail or DNS posture. This keeps the default small and honest; MSPs can choose stronger alternatives for customers that need them. Microsoft [contrasts security defaults with Conditional Access](https://learn.microsoft.com/en-us/entra/fundamentals/security-defaults) and documents the [SharePoint/OneDrive sharing levels](https://learn.microsoft.com/en-us/sharepoint/turn-external-sharing-on-or-off).

| Selectable now | Exact stored field / interpretation | Choice and limit |
| --- | --- | --- |
| SharePoint: no Anyone links | `sharingCapability` is `disabled`, `externalUserSharingOnly`, or `existingExternalUserSharingOnly` | HawkView starter. Tenant-level ceiling; sites can be stricter. |
| SharePoint: only existing guests or internal users | `sharingCapability` is `disabled` or `existingExternalUserSharingOnly` | Optional stricter alternative to the preceding check. New guests are not permitted by that organization setting. |
| SharePoint: internal users only | `sharingCapability` is `disabled` | Optional strictest sharing alternative. Select only where external collaboration is not needed. |
| SharePoint: external sharing off or domain-allowlisted | `sharingCapability=disabled`, or external sharing with `sharingDomainRestrictionMode=allowList` and a nonempty well-formed `sharingAllowedDomainList` | Optional. It checks that a list exists, not that listed domains match the MSP's approved partners. A missing or malformed list is unable to assess. |
| SharePoint: legacy authentication disabled | `isLegacyAuthProtocolsEnabled === false` | HawkView starter. SharePoint setting only; not an Entra-wide legacy-auth block. |
| SharePoint: guest resharing disabled | `isResharingByExternalUsersEnabled === false` | HawkView starter. |
| SharePoint: invited-account match flag enabled | `isRequireAcceptingUserToMatchInvitedUserEnabled === true` | Optional exact setting. Entra B2B integration can determine effective invitation behavior; this check alone does not prove it. |
| SharePoint: idle session sign-out flag enabled | `idleSessionSignOut.isEnabled === true` | Optional. Timeouts and actual session behavior require separate evidence. |
| OneDrive: domain-joined-PC sync restricted to approved domains | `isUnmanagedSyncAppForTenantRestricted === true` **and** a nonempty, well-formed `allowedDomainGuidsForSyncApp` list | Optional strict setting. The list's identity is not compared with an MSP-approved value; this is not a general unmanaged-device access control. A missing/malformed list is unable to assess. |
| Entra: security defaults enabled | `SECURITY_DEFAULTS.isEnabled === true` | Optional. Do not simultaneously require it when an MSP deliberately uses Conditional Access instead. It is not a proxy for MFA coverage. |
| Entra: FIDO2 passkey method enabled for all users | Exactly one `AUTH_METHOD_POLICIES` row with `id=Fido2`, `state=enabled`, an `all_users` group target, and an empty exclusion array | Optional. It establishes method availability in the stored policy, not required passkey use, registration, or Conditional Access enforcement. Missing or malformed targets are unable to assess. |
| SharePoint: only approved partner domains | Sharing disabled, or `sharingDomainRestrictionMode=allowList` with every stored allowed domain in the MSP's selected domain set | Optional parameterized control. A broader stored allow list needs action; missing/malformed values are unable to assess. Site and invitation access remain separate. |
| OneDrive: only approved sync domain identities | Sync restriction enabled and every configured GUID in the MSP's selected GUID set | Optional parameterized control. Does not prove device compliance or that users can sync successfully. |
| OneDrive: deleted-user retention minimum | `deletedUserPersonalSiteRetentionPeriodInDays` is at least the MSP's selected 30–3650 day threshold | Optional governance control. Purview retention policies can take precedence over standard OneDrive deletion. |
| Microsoft 365: MSP-required verified domains present | Every MSP-selected domain name appears in the current `DOMAINS` inventory from `organization.verifiedDomains` | Optional inventory control. It does not establish DNS records, mail authentication, Exchange accepted-domain type, or service health. |

The earlier local OneDrive flag-only check ID is retired. Its stricter replacement has a versioned ID (`onedrive-sync-approved-domains-configured-v1`); a saved baseline still referring to the old ID becomes **Unable to assess** until an MSP admin reviews and selects the replacement. This avoids silently changing what an existing selected requirement means.

Microsoft documents these [SharePoint/OneDrive tenant fields](https://learn.microsoft.com/en-us/graph/api/resources/sharepointsettings?view=graph-rest-1.0), the [organization/site sharing relationship and Entra B2B integration](https://learn.microsoft.com/en-us/sharepoint/turn-external-sharing-on-or-off), and [security defaults](https://learn.microsoft.com/en-us/entra/fundamentals/security-defaults). Those documents inform the options; the local assessments depend on HawkView's narrower stored evidence contract.

## Next controls to design, not yet selectable

The tables separate a useful MSP choice from its assessment contract. `Stored` means some related HawkView snapshot exists, **not** that the proposed predicate is implemented or complete. `New reader` means the current stored projection is insufficient. A candidate becomes selectable only after scope, license/permission behavior, exact expected values, multi-resource clock correlation, counterexamples and tests are agreed. The MSP may choose a more or less restrictive *setting*; HawkView must not silently convert these into a single strength score.

### Entra identity and access

| Candidate MSP requirement | Choices and evidence needed | Current gap |
| --- | --- | --- |
| MFA for users through Conditional Access **or** security defaults | Explicit alternative strategy. For CA, inspect **enabled** policy state, include/exclude users, resources, grant control, authentication strength, emergency exceptions and licensing; report-only is not enforcement. | `CONDITIONAL_ACCESS` and security-defaults snapshots exist, but no effective policy coverage evaluator. Policy presence alone is insufficient. |
| Phishing-resistant MFA for privileged roles | MSP selects role set and allowed emergency exceptions. Check enabled CA authentication strength, role/user targeting and actual assignment. | Multi-policy and role correlation, licensing and policy semantics needed. |
| Block legacy authentication across Entra | Enabled CA policy with client-app conditions, target coverage and exclusions, or documented security-defaults alternative. | SharePoint legacy-auth flag covers only SharePoint. CA effective scope is not evaluated. |
| Require stronger authentication for risky sign-ins/users | Distinguish Microsoft ID Protection risk policy, its targeted users/conditions and licenses from HawkView's separate native risk detector. | Risk data or a policy name does not prove an enabled coverage policy; licensed access may differ. |
| Restrict app consent and external collaboration | MSP chooses self-service consent policy, guest invitation authority and allowed/blocked partner domains. | Need exact tenant policy readers and effective B2B relationship; avoid interpreting one flag in isolation. |
| Protect privileged roles and emergency access | Choose maximum standing admins, PIM-eligible assignment expectations, alerting on permanent role grants, and a reviewed emergency-account exception. | Directory roles/assignments and PIM/license fidelity require a separate coverage model; never enable historical held role sync just to score this. |
| Authentication-method policy | MSP selects passkeys/FIDO2, SMS restrictions, registration campaign or passwordless targets. | A narrow all-user FIDO2 enabled/no-exclusions predicate is now offered locally. Enrollment, actual use, authentication strength, and other methods still need separate evidence and scope evaluators. |

Microsoft's [Conditional Access resource contract](https://learn.microsoft.com/en-us/graph/api/resources/conditionalaccesspolicy?view=graph-rest-1.0) distinguishes enabled, disabled and report-only; its [all-user MFA](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-all-users-mfa-strength) and [legacy authentication](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-legacy-authentication) guidance illustrate why targeting and exclusions matter. A check should say *which population and resource set* it covers, not “CA exists.”

### SharePoint collaboration

| Candidate MSP requirement | Choices and evidence needed | Current gap |
| --- | --- | --- |
| Exact approved external partner domains | Compare `sharingAllowedDomainList` with MSP-selected domains, considering the restriction mode and disabled-sharing case. | A tenant-level subset check is now offered locally; effective site and invitation scope remains unassessed. |
| Anonymous link default, expiration and passwords | MSP chooses link type and maximum lifetime; validate tenant defaults and site overrides. | Current SharePoint projection does not provide a complete link-policy contract. |
| Site-level exceptions | Require every relevant site to be at or below the chosen sharing ceiling, with a finite site inventory and exceptions. | `SHAREPOINT_SITES` exists, but inventory completeness, per-site fields and same-run correlation must be proven. Tenant ceiling alone cannot assess site-specific settings. |
| Unmanaged-device web access | Choose block or limited web-only access and inspect Conditional Access plus SharePoint access-control configuration. | Distinct from the available OneDrive sync flag; needs effective cross-service evidence. |
| Guest access expiration/review | MSP chooses expiry period and review cadence. | Requires configuration and guest/site coverage, not merely a tenant sharing capability. |

### OneDrive data and sync

| Candidate MSP requirement | Choices and evidence needed | Current gap |
| --- | --- | --- |
| OneDrive external sharing level | MSP chooses Anyone, new/existing guests, existing guests or internal only independently where Microsoft permits. | Graph `sharepointSettings.sharingCapability` does not by itself establish the **separate OneDrive level**; collect that setting before offering a OneDrive sharing verdict. |
| Approved sync domains match the MSP's list | Compare `allowedDomainGuidsForSyncApp` to MSP-approved GUIDs if the MSP wants exact device-domain governance. | A configured GUID subset check is now offered locally; device identity and effective access remain unassessed. |
| Unmanaged-device browser restrictions | Block or limited web-only access on unmanaged devices, with exceptions. | Requires Conditional Access and SharePoint/OneDrive access-control evidence; not equivalent to sync restriction. |
| Prevent prohibited file types from syncing | MSP selects extension list; compare `excludedFileExtensionsForSyncApp` after normalization. | Stored list exists, but policy parameters and coverage semantics are not implemented. |
| Deleted-user OneDrive retention | MSP chooses a minimum of 30–3650 days; compare `deletedUserPersonalSiteRetentionPeriodInDays`. | A minimum check is now offered locally. It is a data governance/availability choice, not a universal security requirement or Purview-retention verdict. |
| Per-user OneDrive sharing exceptions | Require personal sites to respect the selected ceiling. | Need complete personal-site inventory and exact per-site sharing fields. |

Microsoft explains [unmanaged-device controls](https://learn.microsoft.com/en-us/sharepoint/control-access-from-unmanaged-devices) separately from the Graph sync setting. Do not merge them into one green check.

### Exchange and mail protection

| Candidate MSP requirement | Choices and evidence needed | Current gap |
| --- | --- | --- |
| Anti-phishing, anti-spam and anti-malware policy | MSP chooses Microsoft Standard/Strict preset or explicit custom thresholds, with recipient scope and priority. | No complete Defender/EOP threat-policy reader. Existing mailbox configuration is not a threat-policy substitute; licensing varies. |
| Safe Links and Safe Attachments | Choose enabled scope and exceptions. | Defender for Office 365 licensing and policy/recipient assignment reader needed. |
| External automatic forwarding | Choose no external forwarding or an explicit allowlist; reconcile outbound spam policy, remote domains, mailbox forwarding and inbox rules. | Mailbox rules are related stored evidence, but one rule list cannot prove tenant-wide blocking; complete mailbox scope is needed. |
| Mailbox auditing and privileged delegation | Choose required audit coverage and monitored delegated permissions. | Need exact Exchange organization/mailbox policy fields and coverage; mailbox count alone is not proof. |
| SPF, DKIM and DMARC | MSP chooses sending domains and DMARC minimum (`none`/`quarantine`/`reject`) with DNS-authentication interpretation per domain. | `DOMAIN_DNS_HEALTH` is related data, but a tenant-wide pass needs selected domains, authoritative DNS completeness and coherent observation clocks. |
| Transport/mail-flow rule review | Select prohibited bypass patterns or review-age requirement. | Need bounded rule reader, rule order/conditions and explicit exceptions; a rule name is insufficient. |

Microsoft's [Defender/EOP Standard and Strict recommendations](https://learn.microsoft.com/en-us/defender-office-365/recommended-settings-for-eop-and-office365?view=o365-worldwide) and [mail authentication guidance](https://learn.microsoft.com/en-us/defender-office-365/email-authentication-about) are reference profiles, not evidence that a specific customer has those features or licenses.

### Microsoft 365 overall

| Candidate MSP requirement | Choices and evidence needed | Current gap |
| --- | --- | --- |
| Unified audit collection and retention | Choose required audit workloads and minimum available retention; separate audit *availability* from a guaranteed event volume. | M365 audit snapshots exist, but the setting, license-dependent retention and source coverage require their own evidence. |
| Multi-workload DLP/sensitivity labels | Choose workloads and required policy coverage, not merely “one DLP policy exists.” | New readers and scope/priority evaluators; licensing varies. |
| Domain ownership and accepted-domain health | Choose primary/secondary domains, required DNS records, mail authentication and Exchange accepted-domain state. | A narrow MSP-selected verified-domain presence check is now offered locally; DNS/mail/Exchange health and completeness remain separate. |
| Conditional Access, email, sharing and device posture together | Provide a baseline **overview** of separate selected outcomes; never substitute a composite Microsoft Secure Score for them. | Aggregation can use selected check results only after each evidence contract exists. |
| Permission/license/capability transparency | Show `Needs permission`, `Not licensed`, `Not collected`, `Stale`, `Malformed` separately from a configured-setting failure. | The assessment currently gives a generic `Unable to assess`; richer reasons require capability state joined to the same tenant and time window. |
| Secure Score improvement actions | Present as optional Microsoft suggestions with applicability and evidence timestamps. | A score or suggested action is advisory, not a pass/fail predicate or automatic security baseline. |

## Recommended implementation order

1. Review this local fifteen-check slice and its wording/choices with the owner. Check accessibility, 1,000-tenant pagination, baseline edit blast radius, workspace boundaries and stale/absent evidence. A live Microsoft setting must never be changed by baseline evaluation.
2. Extend the local parameterized-control foundation only when a new predicate has an exact stored field and testable scope. Approved domain/GUID sets and deleted-user retention now have persisted values, immutable definition revisions and stale-edit rejection. Review their tenant outcomes before adding more.
3. Design Entra identity **strategy alternatives** (security defaults or effective enabled Conditional Access) and evaluate policy targeting, exceptions and licensing before an “MFA coverage” check is offered.
4. Define a bounded Defender/EOP collection and scope contract for Exchange threat-policy checks. Do not infer a pass from the current optional mailbox configuration or a successful generic sync state.
5. Build domain-scoped SPF/DKIM/DMARC and cross-workload governance checks only after selected-domain and complete-inventory contracts are explicit.

For each future check record a stable ID and version, service, exact tenant/site/user/domain scope, chosen threshold, required Microsoft capability and permission, source field, evidence freshness, missing-data result, exception behavior, counterexample tests and remediation text. Shared baseline edits should create a reviewable version before they change the reported status of many tenants. Keep the product's “recommended” badge distinct from what the MSP actually selected.
