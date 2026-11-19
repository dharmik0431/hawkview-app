# HAW-75 bounded expired-content selection contract

Status: local design only, 19 November 2026. Reference source is public inactive component `57177ee486211dcb205c6db1cf43ec848fddadfa`, tree `f09f1f63e8cd128e2ed012dbbda96b954212a06a`, based on protected main `a15951997b6734b9fc612717cf965c9f9651176c`. This design adds no runtime implementation, database operation, schema, caller or test. Parent CI/Claude proof covers the existing components, not the proposed selector or full production integration.

## Concrete missing seam

The [gap-transfer helper](../src/tenants/m365-audit-gap-transfer.ts) accepts a complete `SelectedAuditGapClaim`; its four timestamp values must retain database microseconds. The [Prisma witness](../src/tenants/m365-audit-gap-transfer.database-integration.test.ts) builds that descriptor using test-local raw selection. The [schema](../prisma/schema.prisma), `M365ActivityContent`, stores these fields at six-decimal timestamp precision. Passing model Date values through ISO formatting would lose sub-millisecond revision information.

The [current service](../src/tenants/m365-management-activity.service.ts), `syncTenant` pending query, picks PENDING/due RETRY rows for downloading, ordered by content creation/discovery and bounded by the current blob limit. That is not the expired-unresolved transfer candidate set, which also includes PROCESSING, FAILED and INSUFFICIENT_CAPACITY. Reusing that query would miss allowed gap states; expanding it in place would also change download admission. Neither is part of this slice.

The next component is a read-only, scoped page selector for expired unresolved candidates before cleanup. It must return lossless descriptors for the existing transfer helper without changing the download query. It does not reserve quota, fetch provider data, mutate a claim or call transfer. No production caller is added until the separate integration gates pass.

## Bounded selection proposal

Inputs are explicit organization and tenant IDs, an optional continuation ID for that same scope and one positive, safe-integer read limit validated before SQL. Use fixed SQL and bound values, never caller-interpolated text. No default, numeric production ceiling, environment setting or extra deployment capacity is selected here; the effective limit must fit the already approved admission/time budget before integration.

The logical page contains at most that limit of unresolved rows, ordered by immutable ledger ID after the continuation ID. This bounds returned page material, not physical database scan cost; the query plan and cost still require measurement. It includes PENDING, PROCESSING, RETRY, FAILED and INSUFFICIENT_CAPACITY, independently of download retry eligibility. Advance through the examined rows, not just the expired matches. Otherwise an unexpired prefix could starve later expired rows. Return the last examined ID even when no examined row is currently expired. A short or empty examined page completes this scan pass; a full page may require another bounded read to establish its end.

Evaluate advisory expiry in the database against the existing earliest provider/ledger/720-hour-discovery deadline, using one observation for the page. Preserve the current null-provider and tie semantics; do not substitute JavaScript Date comparisons or declare a row definitively transferable. The authoritative helper still rechecks exact fields and evaluates expiry after every lock wait. The response must distinguish examined-row count, candidate descriptors and continuation; zero candidates is not proof that no expired row remains elsewhere or that coverage is complete.

A new pass starts from the beginning. Inserts or newly eligible rows behind the cursor are revisited on that later pass. Under a stable finite unresolved population, consecutive completed pages must visit each row; no bounded-latency or fairness guarantee follows under unbounded churn or without an integrated cursor writer. This row traversal cursor is not a tenant fairness turn, ownership lease or durable repair token.

Cursor persistence is explicitly unimplemented. Before integration, define scoped durable cursor/pass identity and fence its advancement with visit outcomes. It may advance past a page only after every candidate on that page has either committed its transfer or received a validated current-source no-op under the existing helper contract. If processing stops early, a candidate fails, ownership is lost or the commit result is unknown, do not record continuation past unresolved work. Re-read/replay must preserve gap identity and retention. A query result alone never advances durable state. No numeric budget or failure/retry policy is changed by these requirements.

## Lossless descriptor projection

Each descriptor contains the following values without trimming, normalization or Number/Date conversion. The existing transaction transport can host the read; a successful query or standalone read supplies no ownership proof.

| Output | Required value |
| --- | --- |
| `organizationId`, `customerTenantId`, `id` | Exact scoped row identity. Never accept a row found by ID alone. |
| `microsoftContentId`, `contentType` | Stored identity and type; transfer hashes the stored ID. |
| `status` | Stored status; the transfer helper remains the authority for accepted unresolved values. |
| `contentUri` | Stored exact URI, confined to the transient descriptor and bound transfer predicate. |
| `attemptCount` | Exact supported integer, validated before downstream use. |
| `updatedAt`, `discoveredAt`, `ledgerExpiresAt` | UTC strings retaining all six fractional digits from the database. |
| `contentExpiresAt` | The same lossless UTC representation, or null when the stored value is null. |

A missing or mismatched scope yields no candidates. A malformed result, duplicate ID, out-of-scope or out-of-order row, excessive row count, driver error or invalid required field must reject without echoing raw parameters, URI or driver text. It must not be converted into “complete coverage,” a successful transfer or a new retry/failure classification. No URI, raw result or source payload belongs in logs, issue updates, gap storage or response metadata.

The page read need not lock. Its expiry filter is advisory; it returns candidate descriptors, not durable claims. After any wait, the existing transfer body must still obtain tenant/state/gap/source serialization, compare all selected fields and decide expiry with its post-wait database observation. Do not replace that predicate or clock with JavaScript checks. Do not add `SKIP LOCKED`, change isolation or weaken locks in this slice. An empty page or stale-source result never clears a sticky marker or advances a durable fairness turn.

## Integration boundaries still separate

| Existing seam | Why the selector alone cannot fix it |
| --- | --- |
| `syncTenant` cooldown/work-due checks and final counts | They omit sticky coverage and cannot infer completeness from an empty candidate read. The coherent outcome/reader contract remains required. |
| `processContent` claim, completion and catch; abandoned PROCESSING reset | Real writers must agree on exact revision and owner checks. Selecting a descriptor does not make their mutations conditional or serialize them with transfer. |
| `discoverContent` insert/cursor writes | Retained gap identity must prevent resurrection under the shared contract, including empty-page cursor commits. |
| Final expired-ledger cleanup | Broad deletion must not bypass unresolved transfer. Completed checkpoint retention/deduplication is separately qualified. |
| Fair-turn helper | It only ranks supplied ready tenants. There is no durable turn storage or advancement policy, and no proven integration with deployment capacity. |
| HAW-21 lease/outcome boundary | Consume the separately qualified owner fence later; do not replace it with a callback, row read or this selector. |

The bounded page proposal still requires a real implementation and database/query-cost proof. Deployment capacity, cross-tenant selection, durable turn storage and admission-time versus completed-turn advancement remain separate and unresolved. The download ordering, blob/byte ceilings, polling/cooldown, retention and failure policy stay unchanged. No three-tenant fairness bound is promised.

## Cleanup must not bypass unvisited candidates

The current final transaction deletes all scoped ledger-expired content rows, including unresolved statuses that the download query never picked. Integrating a bounded selector while retaining that broad delete would still discard unvisited rows. Restrict or replace cleanup before activation so no unresolved row disappears without its conditional gap/marker transfer and coherent visit outcome. A page or time limit cannot justify deleting the remaining tail. Completed checkpoint deletion remains subject to its separately proved deduplication/retention contract.

The negative witness must run the actual current service path on synthetic expired FAILED and PROCESSING rows outside the download selection. Seed the PROCESSING revision recent enough to avoid the abandoned-lease reset, use no due PENDING/RETRY rows, prevent the first cooldown return, and supply complete synthetic subscriptions plus empty discovery so unrelated backlog cannot explain the result. It should demonstrate deletion without sticky gap evidence, then a later zero-backlog path lacking that block. The future corrected path must leave an unprocessed tail intact, transfer only processed exact candidates, and keep the next empty/cooldown outcome incomplete. The current service observation is source-level only; this negative witness has not been executed. Use registered hosted disposable CI, synthetic provider responses and the real later owner/outcome integration, without contacting Microsoft.

## Acceptance before any selector integration

Synthetic checks may cover exact scope/limit binding, page bookkeeping, field mapping, empty pages, malformed results and refusal to expose URI/driver details. They do not prove SQL semantics, adapter decoding, database clocks, commits or ownership.

A registered hosted disposable-PostgreSQL case must call the actual new selector through the production Prisma adapter and then the existing transfer body, with synthetic fixtures only. Required controls:

1. Non-zero microseconds survive all four timestamp fields, including values distinct within one millisecond; null provider expiry stays null. Check a non-default session timezone/date format so explicit UTC projection is exercised. Keep this distinct from proving the adapter hook caused the initial timezone.
2. Same-organization sibling and different-organization rows cannot be returned under wrong scope. Populate sibling coverage state with distinctive generation and sticky fields before checking subsequent transfer isolation; an absent sibling state is not enough.
3. Every accepted unresolved status is traversed without turning it into download eligibility. An unexpired low-ID page must not hide an expired later page; all retained rows appear exactly once in a completed stable-population pass. COMPLETED and unknown statuses do not become candidates. Changed or invalid input must still be refused by the helper.
4. Change one selected revision field after selection, and require the actual helper's exact-claim check to refuse stale mutation. A fresh positive control is necessary; malformed input alone cannot prove stale-source protection.
5. Actual selector-plus-transfer rollback leaves the full committed source/gap/state snapshot unchanged; committed visibility through an independent reader matches only the scoped transfer. Preserve original gap retention and native large-integer generation checks.
6. An empty candidate page with examined rows can continue scanning but cannot imply complete coverage. Transport failure or invalid rows cannot invoke transfer. Partial page processing, rejected staging and unknown commit results cannot advance a durable cursor past unprocessed work; future owner-fenced cursor/outcome tests must prove this, not a fake callback.

Keep all new physical cases behind the registered hosted boundary before client creation. Do not execute a local or live physical database. Tests must be registered and tied to an owner-authorized exact head before claiming they pass. Full selection/fairness, owner takeover, unknown-result recovery, discovery/completion/accounting and coherent service/readers still need their separate witnesses.

## Delivery sequence and fallback

Implement the isolated read-only page selector and synthetic contract checks first, with no runtime caller. Prepare a registered real-adapter witness next; do not accumulate larger production integrations on unexecuted physical assumptions. Then obtain applicable exact-source sharing permission and independent review/CI. Keep the already reviewed public candidate frozen so its evidence remains attributable.

Protected main remains operational and the candidate stays unmerged and undeployed. This design does not authorize publication, provider work, a migration, manual sync/recovery or release. Complete source review, exact-head CI, protected merge, configured automatic release, actual health and authenticated canary remain required. HAW-75, Baseline and full SYNC are incomplete.
