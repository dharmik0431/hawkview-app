# Pure authentication risk module

This module has no collectors, database, HTTP, environment, key management, or UI dependencies. Its fixtures are invented. Synthetic success does not demonstrate live Microsoft or non-P2 availability.

## Integration boundary

- Import internal types and functions from `../risky-users-auth/index.js` in sibling adapters. Do not treat these as public DTOs.
- Select exactly one source and an explicit organization/customer/Microsoft tenant scope. Never pool Graph and STS events.
- Directory human classification, unique identity resolution, application qualification, and client-source provenance are caller-owned attestations. A nonempty label or UUID-shaped value is not proof.
- STS `UserId` requires a tenant-scoped unique normalized-UPN directory match to an active human directory user, `matchedBy: EXACT_NORMALIZED_UPN`, and `uniqueMatch: true`. Supply the exact original source value for the final raw-field binding. Known identifier conflicts reject. `UserKey`/`ObjectId` are not admitted identity substitutes in this release. Graph uses the exact directory UUID binding.
- STS requires exact `OrganizationId`; `ApplicationId` is preferred. An exact application label is eligible only when independently proven unique, never for a generic default label.
- Unknown nonempty authentication diagnostics must survive collection as an unknown marker. Never drop them to manufacture success. Generic `ResultStatus` success is not login proof.
- UTC source clocks accept zero to three fractional digits, or further trailing zeroes. Nonzero sub-millisecond precision is rejected, not rounded across boundaries.
- Raw addresses and source event IDs remain ephemeral internal evidence. The integration layer must apply existing managed tenant-scoped pseudonymization before persistence/public projection.

## Evaluation and incidents

- A is `HV-ID-AUTH-010.v1`, LOW: ten distinct 50126 failures in an inclusive rolling 15-minute window for one user/application. IP is not required and no same-origin claim is made. The existing break-glass rule ID is unchanged.
- B is `HV-ID-AUTH-005.v2`, MEDIUM: five failures in the inclusive ten minutes strictly before verified success, latest failure at most two minutes before success, same qualified canonical client address/user/application.
- Evaluation is capped at 10,000 input events and a 24-hour authorized lookback. Late valid sequences retain original event clocks and expiry, including historical findings. `MATCHED` does not itself mean current.
- Rule statuses describe aggregate selected-source coverage, not a per-user clean assessment. An unrelated unqualified address can make aggregate B coverage incomplete while an intact qualified witness still matches. Never project aggregate incompleteness as a claim that a particular qualified user was not evaluated.
- Authorization and future-clock gates precede duplicate comparison. Conflicting immutable event versions are quarantined. Unknown outcomes, gaps, stale/partial sources, pagination and caps prevent clean negatives; intact positive evidence remains supported.
- Pass the evaluation's scoped `conflictingEventIds` to incident merge. Disputed prior references are preserved separately in `quarantinedEventIds`, excluded from evidence counts, and unsupported current incidents become UNKNOWN. Independent replacement evidence can restore support; replaying a quarantined ID cannot.
- Merge rejects cross-scope/future ledgers. It checks 2,000 total input incidents/findings and 100,000 aggregate input evidence references before unions. Each evidence/quarantine list is capped at 10,000. A cap or exception must become explicit evaluation uncertainty, never a database clear or a clean result.
- Existing derived-risk retention remains 90 days in the integration layer. This module adds no retention job and deletes no incident. Expiry becomes HISTORICAL, never remediated/resolved.
- `highestAuthenticationPriority` requires explicit subject/scope/source/asOf context. Historical or UNKNOWN incidents never raise current priority; A plus B remains MEDIUM, not HIGH.
- Event MFA facts require exact scoped event attestation. Current registration or policy settings are not event MFA proof. Confidence is supported pattern evidence, not a calibrated compromise probability.

## Source reference

Microsoft's [Management Activity API common and STS schema](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema#azure-active-directory-secure-token-service-sts-logon-schema) defines tenant identity, STS operation/error fields, optional application/address fields, and the distinction between audit processing status and actual authentication success.
