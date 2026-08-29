# HawkView documentation roadmap

This directory supplements the engineer-facing [root README](../README.md). The table proposes documents; it does not claim they exist or that deferred behavior is implemented. `P0` means pilot safety/release blocking, `P1` pilot operations/onboarding, and `P2` later readiness.

| Proposed document | Audience | Priority | Owner role | Screenshots required? |
| --- | --- | --- | --- | --- |
| Internal architecture decision record index | Engineers and leads | P0 | Engineering lead | No |
| Internal authorization and cross-MSP isolation test guide | Engineers and security reviewers | P0 | Security engineering owner | No |
| Internal audit-event catalog and auditability runbook | Engineering, support, security, compliance | P0 after auditability reaches `main` | Backend/security owner | No |
| Internal secrets, key rotation, and connector recovery runbook | On-call/platform | P0 | Platform/security owner | No |
| Internal release and rollback runbook | Release/on-call | P0 | Platform/release owner | No |
| Internal database backup, restore, migration, and disaster-recovery runbook | Platform/database operators | P0 | Platform/database owner | No |
| Internal monitoring, alerting, correlation, and incident runbook | On-call/support | P1 | SRE/platform owner | No |
| Internal Microsoft collector catalog: cadence, retention, cost, failures | Engineering, support, product | P1 | Microsoft integration owner | No |
| Internal data classification, retention, deletion, and privacy procedure | Engineering, security, legal, support | P1 | Security/privacy owner | No |
| Internal Supabase Auth and account recovery runbook | Support/platform | P1 | Identity/platform owner | No |
| Internal frontend publication and revision-verification runbook | Release/frontend | P1 | Frontend/platform owner | Only provider controls not expressible as code |
| External MSP administrator onboarding guide | MSP owners/admins | P0 | Product documentation owner | Yes |
| External Microsoft permissions and consent guide | MSP/customer admins and security reviewers | P0 | Integration/security owners | Yes |
| External member and MFA setup guide | MSP owners/invitees | P1 | Product documentation owner | Yes |
| External health, freshness, and data-availability guide | MSP technicians/viewers | P1 | Product/integration owners | Yes |
| External troubleshooting and support-data checklist | MSP admins/support | P1 | Support documentation owner | Selective, fully redacted |
| External security, privacy, subprocessors, retention, and handling overview | Customer reviewers | P1 | Security/privacy/legal owners | No |
| External release notes and pilot limitations | Pilot customers/internal teams | P1 recurring | Product manager | No |
| External API documentation, when a supported external API exists | Future integrators | P2 | API product owner | No |

## Documentation rules

- Verify claims against current default-branch implementation and appropriate deployment evidence.
- Label pilot limitations, unknowns, prerequisites, and separately managed provider steps.
- Never publish secrets, tokens, customer content/identifiers, or unredacted screenshots.
- Do not describe roadmap or branch-only work as live.
- Use diagrams/screenshots only for real workflows or trust boundaries. Use synthetic fixtures and alt text.
- Give each new document an owner, review date, and update trigger.
