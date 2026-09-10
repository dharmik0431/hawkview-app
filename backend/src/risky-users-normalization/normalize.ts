import { isIP } from 'node:net';
import {
  MAX_DISTINCT_REFERENCES,
  MAX_ROWS_PER_RUN,
  type DirectoryUserRow,
  type ErrorCodeShape,
  type EventClassification,
  type IsInteractiveShape,
  type NormalizationBatch,
  type NormalizationScope,
  type NormalizationSource,
  type NormalizeBatchOptions,
  type NormalizedEvent,
  type ReferenceResolver,
  type SignInRow,
  type SubjectBindingMethod,
} from './contract.js';
import {
  UNREACHABLE_BY_SUBJECT_RESOLUTION,
  auditReasonEntry,
  dispositionForCode,
  failureReasonMeaning,
  resultCodeEntry,
  type CodeDisposition,
} from './provider-facts.js';
import {
  OUT_OF_SCOPE_LABELS,
  UNKNOWN_LABELS,
  SUBJECT_RESOLUTION_FAILURES,
  UNCITED_LABELS,
  UNPROCESSABLE_LABELS,
  UNSELECTED_ROW_LABELS,
  unreachable,
  zeroCounts,
  type OutOfScopeReason,
  type UncitedReason,
  type UnknownObservation,
  type UnprocessableReason,
  type UnselectedRowReason,
} from './reasons.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_DECIMAL = /^(0|[1-9]\d{0,8})$/;
/** Deliberately permissive on the local part and strict on shape. Never fuzzy. */
const UPN = /^[^\s@]{1,255}@[^\s@.]+(?:\.[^\s@.]+)+$/;

const AUDIT_STS_RECORD_TYPE = 15;
const AUDIT_SIGN_IN_OPERATIONS = new Set(['UserLoggedIn', 'UserLoginFailed']);

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** UTC source timestamps only. Sub-millisecond precision is rejected, never rounded. */
function utcMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3}|\.\d{3}0{1,4})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : null;
}

function canonicalAddress(value: unknown): string | null {
  if (!textValue(value) || value.includes('%') || value.trim() !== value) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  return null;
}

/**
 * A description that cannot contradict a success.
 *
 * Verified separately per feed and never mixed: on the GRAPH path errorCode 0
 * carries the literal "Other." on 100% of rows; the empty/absent-description
 * successes measured in production are all AUDIT rows. Both are accepted here
 * because an empty description cannot contradict a success and accepting it
 * keeps a future drift from "Other." toward empty from demoting every real
 * success to UNKNOWN. Anything ELSE alongside a 0 is UNKNOWN, and
 * `shapeObservations` is what would surface the drift.
 */
function descriptionPermitsSuccess(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === 'Other.';
}

/** Exact normalized UPN. Case-insensitive, whitespace-trimmed, never partial. */
export function normalizeUpn(value: string): string {
  return value.trim().toLowerCase();
}

export function errorCodeShape(record: Record<string, unknown>): ErrorCodeShape {
  const status = record.status;
  if (status === undefined || status === null) return 'ABSENT';
  if (!plainObject(status)) return 'OTHER_TYPE';
  if (!('errorCode' in status)) return 'ABSENT';
  const code = status.errorCode;
  if (code === null) return 'NULL';
  if (typeof code === 'number') return Number.isSafeInteger(code) ? 'NUMBER' : 'OTHER_TYPE';
  if (typeof code === 'string') return CANONICAL_DECIMAL.test(code) ? 'NUMERIC_STRING' : 'OTHER_STRING';
  return 'OTHER_TYPE';
}

export function isInteractiveShape(record: Record<string, unknown>): IsInteractiveShape {
  if (!('isInteractive' in record)) return 'ABSENT';
  const value = record.isInteractive;
  if (value === null) return 'NULL';
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  return 'OTHER_TYPE';
}

/**
 * The Graph result code. A JSON number and nothing else.
 *
 * Confirmed in production: `number` on 100% of 2,635 Graph rows, with zero
 * string, zero null, zero absent, and zero rows where `status` itself is
 * missing — so the control is satisfied and nothing can be misread as 0. A
 * numeric string is therefore drift, not a supported form: it is counted in
 * `shapeObservations` and routed to UNKNOWN rather than coerced.
 */
export function readGraphErrorCode(record: Record<string, unknown>): number | null {
  if (errorCodeShape(record) !== 'NUMBER') return null;
  const status = record.status;
  return plainObject(status) ? (status.errorCode as number) : null;
}

/**
 * Refine a code whose meaning lives in its description text.
 *
 * Only codes the table has already marked as text-dependent are refined, and
 * only to a member of the closed set. Text matching nothing, or matching more
 * than one meaning, keeps the table's UNKNOWN disposition.
 */
function refineByDescription(code: number, disposition: CodeDisposition, description: unknown): CodeDisposition {
  const allowed = resultCodeEntry(code)?.textMeanings;
  if (!allowed || allowed.length === 0) return disposition;
  return failureReasonMeaning(description, allowed)?.disposition ?? disposition;
}

export function classifyGraphRecord(record: Record<string, unknown>): {
  classification: EventClassification;
  errorCode: number | null;
} {
  const shape = errorCodeShape(record);
  const errorCode = readGraphErrorCode(record);
  if (errorCode === null) {
    const observation: UnknownObservation =
      shape === 'ABSENT' || shape === 'NULL' ? 'ERROR_CODE_ABSENT' : 'ERROR_CODE_SHAPE_UNRECOGNIZED';
    return { classification: { kind: 'UNKNOWN', observation }, errorCode: null };
  }

  const status = plainObject(record.status) ? record.status : {};
  const description = status.failureReason;
  const disposition = refineByDescription(errorCode, dispositionForCode(errorCode), description);

  if (disposition.kind === 'APPLIES' && disposition.outcome === 'PASSWORD_ACCEPTED_COMPLETED') {
    if (!descriptionPermitsSuccess(description)) {
      return {
        classification: { kind: 'UNKNOWN', observation: 'SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON' },
        errorCode,
      };
    }
  }
  return { classification: disposition, errorCode };
}

/**
 * Collect the audit result code from every place it can appear, requiring all
 * of them to agree.
 *
 * `ResultStatus` is deliberately not consulted anywhere in this file. For STS
 * logon events a ResultStatus of "Succeeded" means HTTP success, NOT logon
 * success, and reading it fails silently in the direction of calling failed
 * sign-ins successful.
 */
function readAuditErrorCode(record: Record<string, unknown>): { code: number | null; present: boolean } {
  const codes: unknown[] = [];
  if (record.ErrorCode !== undefined) codes.push(record.ErrorCode);
  const properties = record.ExtendedProperties;
  if (Array.isArray(properties)) {
    for (const property of properties.slice(0, 100)) {
      if (!plainObject(property) || typeof property.Name !== 'string') continue;
      if (property.Name === 'ErrorCode' || property.Name === 'ErrorNumber') codes.push(property.Value);
    }
  }
  if (codes.length === 0) return { code: null, present: false };
  const canonical = codes.map(value =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : typeof value === 'string' && CANONICAL_DECIMAL.test(value)
        ? value
        : null,
  );
  if (canonical.some(value => value === null) || new Set(canonical).size !== 1) {
    return { code: null, present: true };
  }
  return { code: Number(canonical[0]), present: true };
}

function readAuditLogonErrors(record: Record<string, unknown>): unknown[] {
  const errors: unknown[] = [record.LogonError];
  const properties = record.ExtendedProperties;
  if (Array.isArray(properties)) {
    for (const property of properties.slice(0, 100)) {
      if (plainObject(property) && property.Name === 'LogonError') errors.push(property.Value);
    }
  }
  return errors;
}

const emptyLogonError = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || value === 'None';

/**
 * Classify one audit-STS record, REASON-NAME FIRST.
 *
 * The two feeds invert on which field is trustworthy, so classifying them
 * symmetrically is wrong. On Graph the result code is a clean number on 100%
 * of rows and the description is free prose. On AUDIT the code is unreliable
 * and the reason NAME is the stable identifier: `InvalidUserNameOrPassword`
 * appears with errorCode "1" AND with the code entirely absent, in both audit
 * tenants. Same event, same meaning, different code — and a classifier keyed
 * on the code drops half of them while catching the other half, invisibly.
 *
 * Error code "1" is HawkView's own invention on this feed rather than an Azure
 * code, so it carries no provider information: it is used neither as a key nor
 * as corroboration. That is the second time its instability has bitten.
 *
 * The code still CORROBORATES and never overrides. A contradiction between the
 * name, the operation and a real Microsoft code is reported as a contradiction
 * rather than resolved by preferring one field.
 */
export function classifyAuditRecord(record: Record<string, unknown>): {
  classification: EventClassification;
  errorCode: number | null;
} {
  const { code, present } = readAuditErrorCode(record);
  const providerCode = code === 1 ? null : code;
  const succeeded = record.Operation === 'UserLoggedIn';
  const inconsistent = {
    classification: { kind: 'UNKNOWN', observation: 'INCONSISTENT_OPERATION_AND_CODE' } as const,
    errorCode: code,
  };
  const reasonName = readAuditLogonErrors(record).find(
    value => textValue(value) && !emptyLogonError(value),
  );

  if (reasonName === undefined) {
    // No reason name to go on. The code is only trustworthy here for a clean
    // success, and code "1" is not a provider code at all.
    if (providerCode === 0) {
      return succeeded
        ? { classification: { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_COMPLETED' }, errorCode: code }
        : inconsistent;
    }
    if (providerCode === null) {
      const observation: UnknownObservation =
        code === 1 ? 'HAWKVIEW_SYNTHETIC_ERROR_CODE'
          : present ? 'ERROR_CODE_SHAPE_UNRECOGNIZED'
            : 'ERROR_CODE_ABSENT';
      return { classification: { kind: 'UNKNOWN', observation }, errorCode: code };
    }
    if (succeeded) return inconsistent;
    return { classification: dispositionForCode(providerCode), errorCode: code };
  }

  const entry = auditReasonEntry(reasonName as string);
  if (!entry) {
    return { classification: { kind: 'UNKNOWN', observation: 'UNRECOGNIZED_REASON_NAME' }, errorCode: code };
  }
  const { disposition } = entry;
  if (disposition.kind === 'APPLIES') {
    const wantsSuccess = disposition.outcome === 'PASSWORD_ACCEPTED_COMPLETED';
    if (wantsSuccess !== succeeded) return inconsistent;
    if (providerCode === 0 && !wantsSuccess) return inconsistent;
    if (providerCode !== null && providerCode !== 0) {
      const byCode = dispositionForCode(providerCode);
      if (byCode.kind === 'APPLIES' && byCode.outcome !== disposition.outcome) return inconsistent;
    }
  }
  return { classification: disposition, errorCode: code };
}

/** Which collection feed produced a row. Preserved from the collection contract. */
export function rowSource(raw: Record<string, unknown>): NormalizationSource | null {
  if (raw.hawkviewSource === 'MICROSOFT_365_MANAGEMENT_ACTIVITY') return 'M365_AUDIT_STS';
  if (raw.hawkviewSource === undefined) return 'GRAPH_SIGN_INS';
  return null;
}

type Resolution =
  | { readonly kind: 'ONE'; readonly user: DirectoryUserRow }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MANY' };

export interface DirectoryIndex {
  byObjectId(microsoftUserId: string): Resolution;
  byUpn(userPrincipalName: string): Resolution;
}

function resolve(matches: DirectoryUserRow[] | undefined): Resolution {
  if (!matches || matches.length === 0) return { kind: 'NONE' };
  if (matches.length > 1) return { kind: 'MANY' };
  return { kind: 'ONE', user: matches[0]! };
}

/**
 * Index the collected directory by directory object id AND by exact
 * normalized UPN.
 *
 * The UPN index exists because GUID-only binding takes the non-premium audit
 * path from ~97% resolution to ~0%: measured across the three fallback-path
 * tenants, audit rows resolve 96.8% / 97.1% / 77.8% by UPN against
 * 15.2% / 0.0% / 0.0% by GUID. Two of three tenants would detect nothing on a
 * feature whose whole premise is working without premium licensing.
 *
 * The hazard was never naming, it was AMBIGUITY — two directory users
 * normalizing to one UPN — so both lookups demand EXACTLY ONE non-deleted
 * match and every other outcome is unprocessable. The binding method is then
 * recorded on the event, because a UPN can be reassigned after a user is
 * deleted and a historical event can bind to the wrong person. That residual
 * risk is smaller than detecting nothing for two thirds of tenants, and it is
 * disclosed rather than implied away.
 *
 * `userType` is deliberately NOT filtered. Restricting the index would be an
 * unverified exclusion predicate, and it would push every user with an
 * unexpected type into "not in the directory", which reads as a collection
 * fault rather than as what it is.
 */
export function indexDirectory(
  scope: NormalizationScope,
  directory: readonly DirectoryUserRow[],
): DirectoryIndex {
  const byId = new Map<string, DirectoryUserRow[]>();
  const byUpn = new Map<string, DirectoryUserRow[]>();
  const push = (map: Map<string, DirectoryUserRow[]>, key: string, user: DirectoryUserRow) => {
    const existing = map.get(key);
    if (existing) existing.push(user);
    else map.set(key, [user]);
  };
  for (const user of directory) {
    // A directory row from another tenant in this index could bind a sign-in
    // to the wrong person, so it aborts the run rather than being counted.
    if (user.organizationId !== scope.organizationId || user.customerTenantId !== scope.customerTenantId) {
      throw new Error('RISKY_USERS_NORMALIZATION_DIRECTORY_SCOPE_MISMATCH');
    }
    if (GUID.test(user.microsoftUserId)) push(byId, user.microsoftUserId.toLowerCase(), user);
    if (textValue(user.userPrincipalName)) push(byUpn, normalizeUpn(user.userPrincipalName), user);
  }
  return {
    byObjectId: (microsoftUserId: string) => resolve(byId.get(microsoftUserId.toLowerCase())),
    byUpn: (userPrincipalName: string) => resolve(byUpn.get(normalizeUpn(userPrincipalName))),
  };
}

type ReferenceOutcome = string | 'BUDGET' | 'UNAVAILABLE';

interface RowContext {
  readonly scope: NormalizationScope;
  readonly source: NormalizationSource;
  readonly directory: DirectoryIndex;
  readonly resolveReference: (kind: 'subject' | 'application', identifier: string) => Promise<ReferenceOutcome>;
}

/**
 * Internal result. Carries the resolved directory id alongside the event so
 * the reference-to-identifier mapping can be built without re-reading the raw
 * payload; the id itself never travels on the event.
 */
type InternalRowResult =
  | {
      readonly kind: 'NORMALIZED';
      readonly event: NormalizedEvent;
      readonly microsoftUserId: string;
    }
  | { readonly kind: 'UNPROCESSABLE'; readonly reason: UnprocessableReason };

const unprocessable = (reason: UnprocessableReason): InternalRowResult => ({ kind: 'UNPROCESSABLE', reason });

interface SubjectBinding {
  readonly user: DirectoryUserRow;
  readonly method: SubjectBindingMethod;
}

/** Graph subjects bind on the directory object id in the payload, and nothing else. */
function bindGraphSubject(raw: Record<string, unknown>, directory: DirectoryIndex): SubjectBinding | UnprocessableReason {
  const rawUserId = raw.userId;
  if (typeof rawUserId !== 'string' || !GUID.test(rawUserId)) return 'SUBJECT_ID_ABSENT_OR_MALFORMED';
  const match = directory.byObjectId(rawUserId);
  if (match.kind === 'NONE') return 'SUBJECT_NOT_IN_DIRECTORY';
  if (match.kind === 'MANY') return 'SUBJECT_AMBIGUOUS_IN_DIRECTORY';
  return { user: match.user, method: 'DIRECTORY_OBJECT_ID' };
}

/**
 * Audit subjects bind on the UPN in the management-activity record.
 *
 * Never on the `sign_in_logs.user_id` COLUMN: measured in production that
 * column is GUID-shaped on essentially every row, matches no directory user on
 * any row, and is more granular than the real user (6 distinct column GUIDs
 * against 2 real users across 950 rows). It looks synthesized rather than
 * sourced, so it is not an identity.
 */
function bindAuditSubject(record: Record<string, unknown>, directory: DirectoryIndex): SubjectBinding | UnprocessableReason {
  const rawUpn = record.UserId;
  if (!textValue(rawUpn) || !UPN.test(rawUpn.trim())) return 'SUBJECT_UPN_ABSENT_OR_MALFORMED';
  const match = directory.byUpn(rawUpn);
  if (match.kind === 'NONE') return 'SUBJECT_UPN_NOT_IN_DIRECTORY';
  if (match.kind === 'MANY') return 'SUBJECT_UPN_AMBIGUOUS_IN_DIRECTORY';
  return { user: match.user, method: 'NORMALIZED_UPN' };
}

interface FeedRecord {
  readonly record: Record<string, unknown>;
  readonly eventIdField: 'id' | 'Id';
  readonly eventAtField: 'createdDateTime' | 'CreationTime';
}

async function normalizeRow(row: SignInRow, raw: Record<string, unknown>, context: RowContext): Promise<InternalRowResult> {
  const ingestedAt = row.ingestedAt instanceof Date && Number.isFinite(row.ingestedAt.getTime())
    ? row.ingestedAt.getTime()
    : null;
  if (ingestedAt === null) return unprocessable('INGESTION_TIMESTAMP_INVALID');

  // Collection marks records whose integrity it could not stand behind. That
  // is a data-quality claim, not a scope decision, so it gets its own reason.
  if (raw.hawkviewAuthenticationIntegrity !== undefined) return unprocessable('INTEGRITY_DISPUTED');

  const graph = context.source === 'GRAPH_SIGN_INS';
  let feed: FeedRecord;
  if (graph) {
    feed = { record: raw, eventIdField: 'id', eventAtField: 'createdDateTime' };
  } else {
    const inner = raw.managementActivityRecord;
    if (!plainObject(inner)) return unprocessable('RAW_PAYLOAD_MALFORMED');
    if (inner.OrganizationId !== undefined && inner.OrganizationId !== context.scope.microsoftTenantId) {
      return unprocessable('TENANT_BINDING_MISMATCH');
    }
    if (inner.RecordType !== AUDIT_STS_RECORD_TYPE || typeof inner.Operation !== 'string' ||
      !AUDIT_SIGN_IN_OPERATIONS.has(inner.Operation)) {
      return unprocessable('UNSUPPORTED_AUDIT_OPERATION');
    }
    feed = { record: inner, eventIdField: 'Id', eventAtField: 'CreationTime' };
  }
  const { record } = feed;

  const eventId = record[feed.eventIdField];
  if (!textValue(eventId)) return unprocessable('EVENT_ID_ABSENT_OR_MALFORMED');
  const eventAt = utcMillis(record[feed.eventAtField]);
  if (eventAt === null) return unprocessable('EVENT_TIMESTAMP_INVALID');
  if (ingestedAt < eventAt) return unprocessable('INGESTION_PRECEDES_EVENT');

  const binding = graph
    ? bindGraphSubject(record, context.directory)
    : bindAuditSubject(record, context.directory);
  if (typeof binding === 'string') return unprocessable(binding);

  const applicationIdentifier = graph
    ? (typeof record.appId === 'string' && GUID.test(record.appId) ? record.appId : null)
    : (typeof record.ApplicationId === 'string' && GUID.test(record.ApplicationId)
        ? record.ApplicationId
        : textValue(record.Application) ? record.Application : null);
  if (applicationIdentifier === null) return unprocessable('APPLICATION_ID_ABSENT_OR_MALFORMED');

  const subjectRef = await context.resolveReference('subject', binding.user.microsoftUserId);
  if (subjectRef === 'BUDGET') return unprocessable('REFERENCE_BUDGET_EXCEEDED');
  if (subjectRef === 'UNAVAILABLE') return unprocessable('REFERENCE_UNAVAILABLE');
  const applicationRef = await context.resolveReference('application', applicationIdentifier);
  if (applicationRef === 'BUDGET') return unprocessable('REFERENCE_BUDGET_EXCEEDED');
  if (applicationRef === 'UNAVAILABLE') return unprocessable('REFERENCE_UNAVAILABLE');

  const { classification, errorCode } = graph ? classifyGraphRecord(record) : classifyAuditRecord(record);
  const address = graph
    ? canonicalAddress(record.ipAddress)
    : canonicalAddress(record.ClientIP) ?? canonicalAddress(record.ActorIpAddress);

  const event: NormalizedEvent = {
    organizationId: context.scope.organizationId,
    customerTenantId: context.scope.customerTenantId,
    microsoftTenantId: context.scope.microsoftTenantId,
    source: context.source,
    eventId,
    eventAt: new Date(eventAt).toISOString(),
    ingestedAt: new Date(ingestedAt).toISOString(),
    subjectRef,
    subjectBinding: binding.method,
    applicationRef,
    errorCode,
    clientSource: {
      qualification: address === null ? 'MISSING' : 'QUALIFIED',
      address,
    },
    classification,
  };
  return { kind: 'NORMALIZED', event, microsoftUserId: binding.user.microsoftUserId };
}

export async function normalizeSignInBatch(options: NormalizeBatchOptions): Promise<NormalizationBatch> {
  const { scope, source, rows, directory, reference, collectionScope } = options;
  const index = indexDirectory(scope, directory);

  const doesNotApplyByReason = zeroCounts<OutOfScopeReason>(OUT_OF_SCOPE_LABELS);
  const unknownByObservation = zeroCounts<UnknownObservation>(UNKNOWN_LABELS);
  const notYetCitedByReason = zeroCounts<UncitedReason>(UNCITED_LABELS);
  const unprocessableByReason = zeroCounts<UnprocessableReason>(UNPROCESSABLE_LABELS);
  const unselectedRowsByReason = zeroCounts<UnselectedRowReason>(UNSELECTED_ROW_LABELS);
  const bindingMethods: Record<SubjectBindingMethod, number> = { DIRECTORY_OBJECT_ID: 0, NORMALIZED_UPN: 0 };
  const graphErrorCodeShape: Record<ErrorCodeShape, number> = {
    NUMBER: 0, NUMERIC_STRING: 0, OTHER_STRING: 0, NULL: 0, ABSENT: 0, OTHER_TYPE: 0,
  };
  const graphIsInteractive: Record<IsInteractiveShape, number> = { TRUE: 0, FALSE: 0, NULL: 0, ABSENT: 0, OTHER_TYPE: 0 };
  const graphIsInteractiveAmongCredentialFailures: Record<IsInteractiveShape, number> = {
    TRUE: 0, FALSE: 0, NULL: 0, ABSENT: 0, OTHER_TYPE: 0,
  };

  let applies = 0;
  let enumerationCodesOnUnresolvedSubjects = 0;

  let consideredRows = 0;
  const events: NormalizedEvent[] = [];
  const resolvedSubjects = new Map<string, { microsoftUserId: string; binding: SubjectBindingMethod }>();

  const references = new Map<string, string>();
  let referenceFailed = false;
  const resolveReference = async (kind: 'subject' | 'application', identifier: string): Promise<ReferenceOutcome> => {
    const key = `${kind}:${identifier.toLowerCase()}`;
    const cached = references.get(key);
    if (cached !== undefined) return cached;
    if (references.size >= MAX_DISTINCT_REFERENCES) return 'BUDGET';
    // One resolver failure is a resolver outage, not a per-row property. Fail
    // the remaining rows the same way instead of retrying thousands of times.
    if (referenceFailed) return 'UNAVAILABLE';
    let value: string;
    try {
      value = await reference(kind, identifier);
    } catch {
      referenceFailed = true;
      return 'UNAVAILABLE';
    }
    if (!textValue(value)) {
      referenceFailed = true;
      return 'UNAVAILABLE';
    }
    references.set(key, value);
    return value;
  };

  const context: RowContext = { scope, source, directory: index, resolveReference };

  for (const [position, row] of rows.entries()) {
    if (row.organizationId !== scope.organizationId || row.customerTenantId !== scope.customerTenantId) {
      consideredRows += 1;
      unprocessableByReason.SCOPE_MISMATCH += 1;
      continue;
    }
    if (!plainObject(row.raw)) {
      consideredRows += 1;
      unprocessableByReason.RAW_PAYLOAD_MALFORMED += 1;
      continue;
    }
    const rowFeed = rowSource(row.raw);
    if (rowFeed === null) {
      consideredRows += 1;
      unprocessableByReason.SOURCE_UNRECOGNIZED += 1;
      continue;
    }
    if (rowFeed !== source) {
      unselectedRowsByReason.ROW_FROM_OTHER_FEED += 1;
      continue;
    }
    consideredRows += 1;

    // Shape observations are recorded for every readable row of the selected
    // feed, including rows that later turn out to be unprocessable: the
    // question these answer is about payload shape, not about whether the
    // subject bound. They keep a shape that has been confirmed once under
    // observation rather than assumed forever.
    if (rowFeed === 'GRAPH_SIGN_INS') {
      graphErrorCodeShape[errorCodeShape(row.raw)] += 1;
      const interactive = isInteractiveShape(row.raw);
      graphIsInteractive[interactive] += 1;
      if (readGraphErrorCode(row.raw) === 50126) graphIsInteractiveAmongCredentialFailures[interactive] += 1;
    }

    if (position >= MAX_ROWS_PER_RUN) {
      unprocessableByReason.BATCH_LIMIT_EXCEEDED += 1;
      continue;
    }

    const result = await normalizeRow(row, row.raw, context);
    if (result.kind === 'UNPROCESSABLE') {
      unprocessableByReason[result.reason] += 1;
      // A row that failed subject resolution while carrying an enumeration
      // code is a signal this layer structurally cannot classify: those codes
      // describe a subject that is by definition absent from the directory.
      // Counted so the blind spot is visible rather than merely commented.
      if (SUBJECT_RESOLUTION_FAILURES.includes(result.reason)) {
        const code = rowFeed === 'GRAPH_SIGN_INS' ? readGraphErrorCode(row.raw) : null;
        if (code !== null && UNREACHABLE_BY_SUBJECT_RESOLUTION.some(entry => entry.code === code)) {
          enumerationCodesOnUnresolvedSubjects += 1;
        }
      }
      continue;
    }
    const { event } = result;
    events.push(event);
    bindingMethods[event.subjectBinding] += 1;
    resolvedSubjects.set(event.subjectRef, {
      microsoftUserId: result.microsoftUserId,
      binding: event.subjectBinding,
    });
    const { classification } = event;
    switch (classification.kind) {
      case 'APPLIES':
        applies += 1;
        break;
      case 'DOES_NOT_APPLY':
        doesNotApplyByReason[classification.reason] += 1;
        break;
      case 'NOT_YET_CITED':
        notYetCitedByReason[classification.reason] += 1;
        break;
      case 'UNKNOWN':
        unknownByObservation[classification.observation] += 1;
        break;
      default:
        unreachable(classification);
    }
  }

  const ordered = [...events].sort((left, right) =>
    left.eventAt === right.eventAt
      ? (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)
      : (left.eventAt < right.eventAt ? -1 : 1),
  );
  const outOfScopeTotal = Object.values(doesNotApplyByReason).reduce((sum, value) => sum + value, 0);
  const notYetCitedTotal = Object.values(notYetCitedByReason).reduce((sum, value) => sum + value, 0);

  return {
    scope,
    source,
    events: ordered,
    applies: ordered.filter(event => event.classification.kind === 'APPLIES'),
    microsoftRiskVerdicts: ordered.filter(
      event =>
        event.classification.kind === 'DOES_NOT_APPLY' &&
        event.classification.reason === 'MICROSOFT_RISK_VERDICT',
    ),
    resolvedSubjects: [...resolvedSubjects].map(([subjectRef, entry]) => ({ subjectRef, ...entry })),
    counts: {
      rows: rows.length,
      applies,
      doesNotApplyByReason,
      notYetCitedByReason,
      unknownByObservation,
      unprocessableByReason,
      bindingMethods,
      unselectedRowsByReason,
    },
    coverage: {
      collectionScope,
      consideredRows,
      normalizedRows: ordered.length,
      recognizedRows: applies + outOfScopeTotal + notYetCitedTotal,
    },
    shapeObservations: {
      graphErrorCodeShape,
      graphIsInteractive,
      graphIsInteractiveAmongCredentialFailures,
      enumerationCodesOnUnresolvedSubjects,
    },
  };
}
