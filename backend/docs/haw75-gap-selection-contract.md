# HAW-75 bounded expired-content selection contract

Status: inactive local component and integration contract, 19 November 2026. Reference source is public inactive component `57177ee486211dcb205c6db1cf43ec848fddadfa`, tree `f09f1f63e8cd128e2ed012dbbda96b954212a06a`, based on protected main `a15951997b6734b9fc612717cf965c9f9651176c`. The read-only selector now exists locally with scripted-transport tests, following the four synthetic decoding/serialization qualification cases. It has no production caller; no physical database operation, schema or active policy change occurred. Parent CI/Claude proof covers the earlier components, not the new selector/tests or full production integration.

## Concrete missing seam

The [gap-transfer helper](../src/tenants/m365-audit-gap-transfer.ts) accepts a complete `SelectedAuditGapClaim`; its four timestamp values must retain database microseconds. The [Prisma witness](../src/tenants/m365-audit-gap-transfer.database-integration.test.ts) builds that descriptor using test-local raw selection. The [schema](../prisma/schema.prisma), `M365ActivityContent`, stores these fields at six-decimal timestamp precision. Passing model Date values through ISO formatting would lose sub-millisecond revision information.

The [current service](../src/tenants/m365-management-activity.service.ts), `syncTenant` pending query, picks PENDING/due RETRY rows for downloading, ordered by content creation/discovery and bounded by the current blob limit. That is not the expired-unresolved transfer candidate set, which also includes PROCESSING, FAILED and INSUFFICIENT_CAPACITY. Reusing that query would miss allowed gap states; expanding it in place would also change download admission. Neither is part of this slice.

The local component is a read-only, scoped page selector for expired unresolved candidates before cleanup. It must return lossless descriptors for the existing transfer helper without changing the download query. It does not reserve quota, fetch provider data, mutate a claim or call transfer. No production caller is added until the separate integration gates pass.

## Bounded selection proposal

Inputs are explicit organization and tenant IDs, an optional continuation ID for that same scope and one positive, safe-integer read limit validated before SQL. Use fixed SQL and bound values, never caller-interpolated text. The initial inactive qualification envelope below fixes the page ceiling at one examined row. Reject larger limits; safe-integer validation alone is not a bound. These internal component constants are not production quota, cadence, retry or tenant-turn decisions, and must be measured in registered CI before integration. No new environment setting or extra deployment capacity is selected.

The logical page contains at most that limit of unresolved rows, ordered by immutable ledger ID after the continuation ID. This bounds row count only. It does not bound response bytes or physical scan cost; both need explicit qualification. It includes PENDING, PROCESSING, RETRY, FAILED and INSUFFICIENT_CAPACITY, independently of download retry eligibility. Advance through the examined rows, not just the expired matches. Otherwise an unexpired prefix could starve later expired rows. Return the last examined ID even when no examined row is currently expired. A short or empty examined page completes this scan pass; a full page may require another bounded read to establish its end.

Evaluate advisory expiry in the database against the existing earliest provider/ledger/720-hour-discovery deadline, using one observation for the page. Preserve the current null-provider and tie semantics; do not substitute JavaScript Date comparisons or declare a row definitively transferable. The authoritative helper still rechecks exact fields and evaluates expiry after every lock wait. The response must distinguish examined-row count, candidate descriptors and continuation; zero candidates is not proof that no expired row remains elsewhere or that coverage is complete.

A new pass starts from the beginning. Inserts or newly eligible rows behind the cursor are revisited on that later pass. Under a stable finite unresolved population, consecutive completed pages must visit each row; no bounded-latency or fairness guarantee follows under unbounded churn or without an integrated cursor writer. This row traversal cursor is not a tenant fairness turn, ownership lease or durable repair token.

Cursor persistence is explicitly unimplemented. Before integration, define scoped durable cursor/pass identity and fence its advancement with visit outcomes. It may advance past a page only after every candidate on that page has either committed its transfer or has a separately verified safe current-source disposition. A fresh exact live row observed as not expired may be revisited on the next pass. `SOURCE_CHANGED_OR_ABSENT` alone is not safe completion: reselect a changed row, or verify the exact completed checkpoint/retained gap and sticky state if the source is gone. If that evidence is missing, preserve incomplete status and do not advance past it. `TENANT_ABSENT` ends the removed scope; it is not a successful live-tenant outcome. If processing stops early, a candidate fails, ownership is lost or the commit result is unknown, do not record continuation past unresolved work. Re-read/replay must preserve gap identity and retention. A query result alone never advances durable state. No numeric budget or failure/retry policy is changed by these requirements.

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

The schema permits unbounded `contentUri` text. Before returning URI content, the database projection must enforce the URI-byte bound and serialized-page-text ceiling defined below. Oversized data must reject safely without transporting the oversized URI, truncating it, skipping the row or advancing the cursor. A check only after decoding the full result is insufficient to claim bounded transport/memory. The same complete serialized page value must pass the second gate; summed value lengths are not enough. Driver/protocol framing, JavaScript copies and query-cost measurement remain separate. These are inactive qualification choices, not deployed policy.

A missing or mismatched scope yields no candidates. A malformed result, duplicate ID, out-of-scope or out-of-order row, excessive row count, driver error or invalid required field must reject without echoing raw parameters, URI or driver text. It must not be converted into “complete coverage,” a successful transfer or a new retry/failure classification. No URI, raw result or source payload belongs in logs, issue updates, gap storage or response metadata.

The page read need not lock. Its expiry filter is advisory; it returns candidate descriptors, not durable claims. After any wait, the existing transfer body must still obtain tenant/state/gap/source serialization, compare all selected fields and decide expiry with its post-wait database observation. Do not replace that predicate or clock with JavaScript checks. Do not add `SKIP LOCKED`, change isolation or weaken locks in this slice. An empty page or stale-source result never clears a sticky marker or advances a durable fairness turn.

## Initial inactive qualification envelope

| Limit | Initial value | Rationale and limitation |
| --- | --- | --- |
| Examined rows per query | 1 | Smallest useful cursor/projection seam. It prevents combining many individually large URIs before transport. It does not reuse the download `maxBlobs` allowance or claim adequate production throughput. |
| Stored URI UTF-8 bytes | 6 MiB (6,291,456 bytes) | Three times the current 2 MiB raw discovery response ceiling, accounting for the observed malformed-UTF-8 replacement expansion described below. This is a conservative design envelope to qualify, not a measured maximum from live data or proof every legacy/direct-written row fits. |
| Exact complete serialized page text | 8 MiB (8,388,608 bytes) | Leaves room above one 6 MiB URI for fixed descriptor/page metadata while bounding the actual serialized field. Escaping can still exceed this limit; it must cause safe refusal. This is not a bound on total wire bytes or heap. |

The [four synthetic qualification cases](../src/tenants/m365-audit-selection-bounds.test.ts) call the real `readBoundedJson` and `validateManagementUrl` exports with in-memory responses. At the current 2 MiB raw ceiling, an ASCII URI passes; a response containing malformed UTF-8 bytes inside a syntactically valid JSON URI decodes to replacement characters, producing a stored-string representation larger than 2 MiB and close to 6 MiB while still passing the URL host/path check. The original decoded string is what discovery stores; the parsed URL object is not substituted at that boundary. Raw overflow is still rejected. No network, database or full discovery invocation is exercised.

The four cases passed locally under Node 24 with socket connections prohibited. This does not establish hosted Node 22 behavior, any physical database boundary or a selector implementation.

This is an observed source-path counterexample to treating raw response bytes as a persisted-URI ceiling, not a claim that Microsoft emitted such data. A future strict UTF-8 rejection would require revisiting the qualification; the test is not a requirement to preserve permissive decoding. The 6 MiB choice is conservative reasoning from the current decoder plus this witness, not exhaustive compatibility proof.

The fourth synthetic case uses legacy-shaped control-character text to show that a URI under the URI-byte limit can serialize above the 8 MiB page limit. It uses JavaScript JSON serialization only; that does not prove the future database serialization format or PostgreSQL transport behavior. Summing unescaped column bytes or checking only the post-decoded JavaScript object cannot stand in for the proposed database gate.

The implemented query inspects URI length before constructing or returning a URI-bearing descriptor. If that gate passes, it constructs one complete serialized page text value, including metadata, and measures that exact value's UTF-8 bytes before returning it as a single text field. The same measured text is returned, not a separately reserialized representation. Its actual execution and transport behavior remain unproved until registered physical CI. Any oversize or malformed result yields only a fixed non-URI refusal, with no candidates or continuation. Do not truncate, skip the source or advance the cursor. An empty successful page is distinct from refusal.

One examined row avoids an oversized multi-row aggregate but does not bound server detoasting, serialization allocation, scan work, plan latency, driver buffers, JavaScript string/object copies or total memory. Legacy/raw rows can exceed either cap and must remain intact and unproved; no automatic deletion or policy-changing remediation is introduced. Before runtime integration, registered disposable CI must measure representative and boundary payload/query behavior through the actual adapter and verify that other tenants can still progress under the eventual admission policy.

Required physical controls add exact/one-byte-over URI and serialized-text boundaries, escaped/control and multi-byte text, a complete page envelope, an oversized row before a later valid row, safe refusal without continuation or error-content leakage, and unchanged source/gap/state. The database-generated field and client-received field must agree byte-for-byte; a synthetic JSON test does not satisfy this requirement. There is no physical result for the new selector or these bounds yet.

## Integration boundaries still separate

| Existing seam | Why the selector alone cannot fix it |
| --- | --- |
| `syncTenant` cooldown/work-due checks and final counts | They omit sticky coverage and cannot infer completeness from an empty candidate read. The coherent outcome/reader contract remains required. |
| `processContent` claim, completion and catch; abandoned PROCESSING reset | Real writers must agree on exact revision and owner checks. Selecting a descriptor does not make their mutations conditional or serialize them with transfer. |
| `discoverContent` insert/cursor writes | Retained gap identity must prevent resurrection under the shared contract, including empty-page cursor commits. |
| Final expired-ledger cleanup | Broad deletion must not bypass unresolved transfer. Completed checkpoint retention/deduplication is separately qualified. |
| Fair-turn helper | It only ranks supplied ready tenants. There is no durable turn storage or advancement policy, and no proven integration with deployment capacity. |
| HAW-21 lease/outcome boundary | Consume the separately qualified owner fence later; do not replace it with a callback, row read or this selector. |

The inactive bounded page implementation still requires database/transport/query-cost proof and production integration. Deployment capacity, cross-tenant selection, durable turn storage and admission-time versus completed-turn advancement remain separate and unresolved. The download ordering, blob/byte ceilings, polling/cooldown, retention and failure policy stay unchanged. No three-tenant fairness bound is promised.

## Cleanup must not bypass unvisited candidates

The current final transaction deletes all scoped ledger-expired content rows, including unresolved statuses that the download query never picked. Integrating a bounded selector while retaining that broad delete would still discard unvisited rows. Restrict or replace cleanup before activation so no unresolved row disappears without its conditional gap/marker transfer and coherent visit outcome. A page or time limit cannot justify deleting the remaining tail. Completed checkpoint deletion remains subject to its separately proved deduplication/retention contract. Status is currently unconstrained text: an unknown status is not a transfer candidate, but must not be deleted or treated as complete by cleanup/outcome because it was excluded from the known-status count. Preserve it as unproved pending the existing reconciliation policy; this contract adds no new status or failure classification.

The negative witness must run the actual current service path on synthetic expired FAILED and PROCESSING rows outside the download selection. Seed the PROCESSING revision recent enough to avoid the abandoned-lease reset, use no due PENDING/RETRY rows, prevent the first cooldown return, and supply complete synthetic subscriptions plus empty discovery so unrelated backlog cannot explain the result. It should demonstrate deletion without sticky gap evidence, then a later zero-backlog path lacking that block. The future corrected path must leave an unprocessed tail intact, transfer only processed exact candidates, and keep the next empty/cooldown outcome incomplete. The current service observation is source-level only; this negative witness has not been executed. Use registered hosted disposable CI, synthetic provider responses and the real later owner/outcome integration, without contacting Microsoft.

## Acceptance before any selector integration

Synthetic checks may cover exact scope/limit binding, over-cap and oversized-row refusal, page bookkeeping, field mapping, empty pages, malformed results and refusal to expose URI/driver details. They do not prove SQL semantics, adapter decoding, database clocks, commits or ownership.

A registered hosted disposable-PostgreSQL case must call the actual new selector through the production Prisma adapter and then the existing transfer body, with synthetic fixtures only. Required controls:

1. Non-zero microseconds survive all four timestamp fields, including values distinct within one millisecond; null provider expiry stays null. Check a non-default session timezone/date format so explicit UTC projection is exercised. Keep this distinct from proving the adapter hook caused the initial timezone.
2. Same-organization sibling and different-organization rows cannot be returned under wrong scope. Populate sibling coverage state with distinctive generation and sticky fields before checking subsequent transfer isolation; an absent sibling state is not enough.
3. Every accepted unresolved status is traversed without turning it into download eligibility. An unexpired low-ID page must not hide an expired later page; all retained rows appear exactly once in a completed stable-population pass. COMPLETED and unknown statuses do not become candidates. Changed or invalid input must still be refused by the helper.
4. Change one selected revision field after selection, and require the actual helper's exact-claim check to refuse stale mutation. A fresh positive control is necessary; malformed input alone cannot prove stale-source protection.
5. Actual selector-plus-transfer rollback leaves the full committed source/gap/state snapshot unchanged; committed visibility through an independent reader matches only the scoped transfer. Preserve original gap retention and native large-integer generation checks.
6. Over-cap limits and oversized URI/page payloads reject before oversized text reaches the client, without deletion, truncation or continuation. Use distinctive oversized synthetic content and assert that neither output nor safe errors contain it; qualify memory/query cost separately.
7. An empty candidate page with examined rows can continue scanning but cannot imply complete coverage. Transport failure or invalid rows cannot invoke transfer. Partial page processing, rejected staging and unknown commit results cannot advance a durable cursor past unprocessed work; future owner-fenced cursor/outcome tests must prove this, not a fake callback. A concurrently deleted source with no matching completed/gap evidence must retain an unproved outcome and cannot satisfy safe advancement. Include an unknown-status row to prove cleanup cannot silently discard it.

Keep all new physical cases behind the registered hosted boundary before client creation. Do not execute a local or live physical database. Tests must be registered and tied to an owner-authorized exact head before claiming they pass. Full selection/fairness, owner takeover, unknown-result recovery, discovery/completion/accounting and coherent service/readers still need their separate witnesses.

## Inactive selector implementation

The [selector](../src/tenants/m365-audit-gap-selection.ts) executes one fixed, parameterized read through the supplied transaction transport. It opens no transaction, holds no row locks, changes no source/cursor/outcome and invokes no transfer or provider method. The scope/cursor/one-row limit are validated and captured before the first await. Tenant plus organization remain query predicates; a cursor cannot widen that scope.

The logical page is selected before advisory expiry. A single database observation is captured, while the existing transfer helper retains the authoritative exact-claim and post-lock expiry checks. The row's URI length is checked before any URI-bearing JSON construction. The complete envelope text is materialized once, then that same text is size-checked and returned in one field. Non-UTF8 server/client encodings yield a fixed refusal rather than a misleading byte guarantee. These are implementation choices; no SQL or transport execution has been established locally.

The decoder accepts exactly one envelope row/field, checks the field's byte ceiling before JSON parsing, and refuses unknown fields, malformed payloads, invalid scope/order/status/attempts or noncanonical six-decimal UTC timestamps. It preserves the source URI/identity/timestamps without normalization. An unexpired examined row returns no candidates but retains its last-examined ID; an empty page ends only this known-status scan pass. Its null last-examined ID means no row was examined, not a request to reset an existing durable cursor. Refusals contain no raw driver/parser message, cause, URI or continuation. These additional decoder checks do not replace the pretransport SQL proof.

The [nine scripted-transport tests](../src/tenants/m365-audit-gap-selection.test.ts) cover fixed scope/cap binding, unexpired continuation versus empty end, all five unresolved statuses, exact timestamps/null expiry, pre-query input refusal, input capture across an await, malformed/out-of-scope/nonforward data, exact/over-limit defensive decoding and safe refusals/errors. They execute no SQL and prove no database selection, lock, snapshot, expiry, serialization, ownership or performance behavior. The padded JSON boundary control is specifically a posttransport decoder test, not a claim that PostgreSQL emits that format.

The SQL choices follow the documented behavior of [CASE](https://www.postgresql.org/docs/16/functions-conditional.html#FUNCTIONS-CASE), [materialized CTEs](https://www.postgresql.org/docs/16/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION) and [string byte lengths](https://www.postgresql.org/docs/16/functions-string.html). They are subject to the exact-query physical gates above. Neither keyset pagination nor a one-row logical page proves bounded scan cost on this schema; no index or lock change is included.

## Delivery sequence and fallback

The isolated one-row selector and synthetic checks are local only. A new thirteenth case in the already registered [transfer suite](../src/tenants/m365-audit-gap-transfer.database-integration.test.ts) prepares the first actual-adapter witness: scoped known-status traversal under asserted session settings, lossless descriptors, sequential stale-revision refusal, fresh selector-plus-transfer rollback/commit and unchanged populated sibling/outside coverage state. It has not run against PostgreSQL. It does not cover payload-byte gates, exact expiry-observation boundaries, query cost or any durable cursor/owner/outcome writer.

Keep payload gating and refusal separate from future cursor/outcome writers. Prepare the remaining bounded payload/expiry witnesses and exact-source CI/Claude handoff next; do not accumulate larger production integrations on unexecuted physical assumptions. Obtain applicable exact-source sharing permission and independent review/CI before claiming physical success. Keep the already reviewed public candidate frozen so its evidence remains attributable.

Protected main remains operational and the candidate stays unmerged and undeployed. This design does not authorize publication, provider work, a migration, manual sync/recovery or release. Complete source review, exact-head CI, protected merge, configured automatic release, actual health and authenticated canary remain required. HAW-75, Baseline and full SYNC are incomplete.
