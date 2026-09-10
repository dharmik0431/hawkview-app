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
  type NormalizedEvent,
  type ReferenceResolver,
  type SignInRow,
} from './contract.js';
import { dispositionForCode, mayExclude } from './provider-facts.js';
import {
  OUT_OF_SCOPE_LABELS,
  UNKNOWN_LABELS,
  UNPROCESSABLE_LABELS,
  unreachable,
  zeroCounts,
  type OutOfScopeReason,
  type UnknownObservation,
  type UnprocessableReason,
} from './reasons.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_DECIMAL = /^(0|[1-9]\d{0,8})$/;

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

/** Verified: errorCode 0 carries either an empty/absent failureReason or the literal "Other.". */
function successFailureReasonAccepted(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === 'Other.';
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
 * The numeric result code, or null when it is absent or in a form we do not
 * read. Both `number` and a canonical decimal string are accepted: the JSON
 * type of `raw.status.errorCode` in production has not been confirmed, and
 * refusing a string would send every row to UNKNOWN if that is what is stored.
 * `shapeObservations.graphErrorCodeShape` reports which form was actually
 * seen, so the question gets answered by running this layer.
 */
export function readErrorCode(record: Record<string, unknown>): number | null {
  const shape = errorCodeShape(record);
  const status = record.status;
  if (!plainObject(status)) return null;
  if (shape === 'NUMBER') return status.errorCode as number;
  if (shape === 'NUMERIC_STRING') return Number(status.errorCode as string);
  return null;
}

/**
 * Classify one Graph record.
 *
 * The `isInteractive === false` check is placed here, ahead of result-code
 * dispositioning, so that activating it is a one-line verification flip rather
 * than a reordering. Until that predicate has a distribution check with a
 * passing control cohort, `mayExclude` returns false and the predicate has NO
 * effect on classification at all — it is observed and counted, never acted
 * on. Acting on an unverified exclusion predicate can only remove traffic from
 * evaluation, whether it routes to DOES_NOT_APPLY or to UNKNOWN, and removing
 * traffic on an unconfirmed shape claim is exactly what produced 1,054
 * evaluation runs and zero findings.
 */
export function classifyGraphRecord(record: Record<string, unknown>): {
  classification: EventClassification;
  errorCode: number | null;
} {
  const shape = errorCodeShape(record);
  const errorCode = readErrorCode(record);

  if (record.isInteractive === false && mayExclude('graph.is-interactive-false')) {
    return { classification: { kind: 'DOES_NOT_APPLY', reason: 'NON_INTERACTIVE_SIGN_IN' }, errorCode };
  }

  if (errorCode === null) {
    const observation: UnknownObservation =
      shape === 'ABSENT' || shape === 'NULL' ? 'ERROR_CODE_ABSENT' : 'ERROR_CODE_SHAPE_UNRECOGNIZED';
    return { classification: { kind: 'UNKNOWN', observation }, errorCode: null };
  }

  const disposition = dispositionForCode(errorCode);
  if (disposition.kind === 'APPLIES' && disposition.outcome === 'SUCCESS') {
    const status = record.status;
    const failureReason = plainObject(status) ? status.failureReason : undefined;
    if (!successFailureReasonAccepted(failureReason)) {
      return {
        classification: { kind: 'UNKNOWN', observation: 'SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON' },
        errorCode,
      };
    }
  }
  return { classification: disposition, errorCode };
}

/** Which collection feed produced a row. Preserved from the collection contract. */
export function rowSource(raw: Record<string, unknown>): NormalizationSource | null {
  if (raw.hawkviewSource === 'MICROSOFT_365_MANAGEMENT_ACTIVITY') return 'M365_AUDIT_STS';
  if (raw.hawkviewSource === undefined) return 'GRAPH_SIGN_INS';
  return null;
}

interface DirectoryIndex {
  lookup(microsoftUserId: string): { readonly kind: 'ONE'; readonly user: DirectoryUserRow } | { readonly kind: 'NONE' } | { readonly kind: 'MANY' };
}

/**
 * Index the collected directory by `microsoft_user_id` only.
 *
 * No UPN or mail index exists here on purpose: a UPN is renameable and
 * reassignable, so binding a sign-in to a person by name can attribute one
 * user's activity to another.
 *
 * `userType` is deliberately NOT filtered. Restricting the index to
 * Member/Guest would be an unverified exclusion predicate, and it would push
 * every user whose type is null or unexpected into "not in the directory",
 * which reads as a collection fault rather than as what it is.
 */
export function indexDirectory(
  scope: NormalizationScope,
  directory: readonly DirectoryUserRow[],
): DirectoryIndex {
  const byId = new Map<string, DirectoryUserRow[]>();
  for (const user of directory) {
    // A directory row from another tenant in this index could bind a sign-in
    // to the wrong person, so it aborts the run rather than being counted.
    if (user.organizationId !== scope.organizationId || user.customerTenantId !== scope.customerTenantId) {
      throw new Error('RISKY_USERS_NORMALIZATION_DIRECTORY_SCOPE_MISMATCH');
    }
    if (!GUID.test(user.microsoftUserId)) continue;
    const key = user.microsoftUserId.toLowerCase();
    const existing = byId.get(key);
    if (existing) existing.push(user);
    else byId.set(key, [user]);
  }
  return {
    lookup(microsoftUserId: string) {
      const matches = byId.get(microsoftUserId.toLowerCase());
      if (!matches || matches.length === 0) return { kind: 'NONE' as const };
      if (matches.length > 1) return { kind: 'MANY' as const };
      return { kind: 'ONE' as const, user: matches[0]! };
    },
  };
}

interface RowContext {
  readonly scope: NormalizationScope;
  readonly source: NormalizationSource;
  readonly directory: DirectoryIndex;
  readonly resolveReference: (kind: 'subject' | 'application', identifier: string) => Promise<string | 'BUDGET' | 'UNAVAILABLE'>;
}

/**
 * Internal result. Carries the resolved directory id alongside the event so
 * the reference-to-identifier mapping can be built without re-reading the raw
 * payload; the id itself never travels on the event.
 */
type InternalRowResult =
  | { readonly kind: 'NORMALIZED'; readonly event: NormalizedEvent; readonly microsoftUserId: string }
  | { readonly kind: 'UNPROCESSABLE'; readonly reason: UnprocessableReason };

const unprocessable = (reason: UnprocessableReason): InternalRowResult => ({ kind: 'UNPROCESSABLE', reason });

/**
 * Normalize one row of the selected feed. Callers must have already confirmed
 * the row belongs to the selected source.
 */
async function normalizeRow(row: SignInRow, raw: Record<string, unknown>, context: RowContext): Promise<InternalRowResult> {
  const ingestedAt = row.ingestedAt instanceof Date && Number.isFinite(row.ingestedAt.getTime())
    ? row.ingestedAt.getTime()
    : null;
  if (ingestedAt === null) return unprocessable('INGESTION_TIMESTAMP_INVALID');

  // Collection marks records whose integrity it could not stand behind. That
  // is a data-quality claim, not a scope decision, so it gets its own reason.
  if (raw.hawkviewAuthenticationIntegrity !== undefined) return unprocessable('INTEGRITY_DISPUTED');

  // The audit feed identifies users only by UPN. Subjects bind by directory
  // object id and nothing else, so these rows cannot resolve a person at all.
  // They are reported as unprocessable rather than UPN-matched, which means
  // the audit fallback path visibly detects nothing instead of quietly
  // attributing sign-ins by a renameable name.
  if (context.source === 'M365_AUDIT_STS') return unprocessable('SUBJECT_NOT_RESOLVABLE_WITHOUT_GUID');

  const eventId = raw.id;
  if (!textValue(eventId)) return unprocessable('EVENT_ID_ABSENT_OR_MALFORMED');
  const eventAt = utcMillis(raw.createdDateTime);
  if (eventAt === null) return unprocessable('EVENT_TIMESTAMP_INVALID');
  if (ingestedAt < eventAt) return unprocessable('INGESTION_PRECEDES_EVENT');

  const rawUserId = raw.userId;
  if (typeof rawUserId !== 'string' || !GUID.test(rawUserId)) return unprocessable('SUBJECT_ID_ABSENT_OR_MALFORMED');
  const match = context.directory.lookup(rawUserId);
  if (match.kind === 'NONE') return unprocessable('SUBJECT_NOT_IN_DIRECTORY');
  if (match.kind === 'MANY') return unprocessable('SUBJECT_AMBIGUOUS_IN_DIRECTORY');

  const rawAppId = raw.appId;
  if (typeof rawAppId !== 'string' || !GUID.test(rawAppId)) return unprocessable('APPLICATION_ID_ABSENT_OR_MALFORMED');

  const subjectRef = await context.resolveReference('subject', match.user.microsoftUserId);
  if (subjectRef === 'BUDGET') return unprocessable('REFERENCE_BUDGET_EXCEEDED');
  if (subjectRef === 'UNAVAILABLE') return unprocessable('REFERENCE_UNAVAILABLE');
  const applicationRef = await context.resolveReference('application', rawAppId);
  if (applicationRef === 'BUDGET') return unprocessable('REFERENCE_BUDGET_EXCEEDED');
  if (applicationRef === 'UNAVAILABLE') return unprocessable('REFERENCE_UNAVAILABLE');

  const { classification, errorCode } = classifyGraphRecord(raw);
  const address = canonicalAddress(raw.ipAddress);

  const event: NormalizedEvent = {
    organizationId: context.scope.organizationId,
    customerTenantId: context.scope.customerTenantId,
    microsoftTenantId: context.scope.microsoftTenantId,
    source: context.source,
    eventId,
    eventAt: new Date(eventAt).toISOString(),
    ingestedAt: new Date(ingestedAt).toISOString(),
    subjectRef,
    applicationRef,
    errorCode,
    clientSource: {
      qualification: address === null ? 'MISSING' : 'QUALIFIED',
      address,
    },
    classification,
  };
  return { kind: 'NORMALIZED', event, microsoftUserId: match.user.microsoftUserId };
}

export interface NormalizeBatchOptions {
  readonly scope: NormalizationScope;
  /** Exactly one selected feed. Independent feeds are never pooled. */
  readonly source: NormalizationSource;
  readonly rows: readonly SignInRow[];
  readonly directory: readonly DirectoryUserRow[];
  readonly reference: ReferenceResolver;
}

export async function normalizeSignInBatch(options: NormalizeBatchOptions): Promise<NormalizationBatch> {
  const { scope, source, rows, directory, reference } = options;
  const index = indexDirectory(scope, directory);

  const doesNotApplyByReason = zeroCounts<OutOfScopeReason>(OUT_OF_SCOPE_LABELS);
  const unknownByObservation = zeroCounts<UnknownObservation>(UNKNOWN_LABELS);
  const unprocessableByReason = zeroCounts<UnprocessableReason>(UNPROCESSABLE_LABELS);
  const graphErrorCodeShape: Record<ErrorCodeShape, number> = {
    NUMBER: 0, NUMERIC_STRING: 0, OTHER_STRING: 0, NULL: 0, ABSENT: 0, OTHER_TYPE: 0,
  };
  const graphIsInteractive: Record<IsInteractiveShape, number> = { TRUE: 0, FALSE: 0, NULL: 0, ABSENT: 0, OTHER_TYPE: 0 };
  const graphIsInteractiveAmongCredentialFailures: Record<IsInteractiveShape, number> = {
    TRUE: 0, FALSE: 0, NULL: 0, ABSENT: 0, OTHER_TYPE: 0,
  };

  let applies = 0;
  let unselectedSourceRows = 0;
  let consideredRows = 0;
  const events: NormalizedEvent[] = [];
  const resolvedSubjects = new Map<string, string>();

  const references = new Map<string, string>();
  let referenceFailed = false;
  const resolveReference = async (kind: 'subject' | 'application', identifier: string) => {
    const key = `${kind}:${identifier.toLowerCase()}`;
    const cached = references.get(key);
    if (cached !== undefined) return cached;
    if (references.size >= MAX_DISTINCT_REFERENCES) return 'BUDGET' as const;
    // One resolver failure is a resolver outage, not a per-row property. Fail
    // the remaining rows the same way instead of retrying thousands of times.
    if (referenceFailed) return 'UNAVAILABLE' as const;
    let value: string;
    try {
      value = await reference(kind, identifier);
    } catch {
      referenceFailed = true;
      return 'UNAVAILABLE' as const;
    }
    if (!textValue(value)) {
      referenceFailed = true;
      return 'UNAVAILABLE' as const;
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
      unselectedSourceRows += 1;
      continue;
    }
    consideredRows += 1;

    // Shape observations are recorded for every readable row of the selected
    // feed, including rows that later turn out to be unprocessable: the
    // question these answer is about payload shape, not about whether the
    // subject bound.
    if (rowFeed === 'GRAPH_SIGN_INS') {
      graphErrorCodeShape[errorCodeShape(row.raw)] += 1;
      const interactive = isInteractiveShape(row.raw);
      graphIsInteractive[interactive] += 1;
      if (readErrorCode(row.raw) === 50126) graphIsInteractiveAmongCredentialFailures[interactive] += 1;
    }

    if (position >= MAX_ROWS_PER_RUN) {
      unprocessableByReason.BATCH_LIMIT_EXCEEDED += 1;
      continue;
    }

    const result = await normalizeRow(row, row.raw, context);
    if (result.kind === 'UNPROCESSABLE') {
      unprocessableByReason[result.reason] += 1;
      continue;
    }
    const { event } = result;
    events.push(event);
    resolvedSubjects.set(event.subjectRef, result.microsoftUserId);
    const { classification } = event;
    switch (classification.kind) {
      case 'APPLIES':
        applies += 1;
        break;
      case 'DOES_NOT_APPLY':
        doesNotApplyByReason[classification.reason] += 1;
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

  return {
    scope,
    source,
    events: ordered,
    applies: ordered.filter(event => event.classification.kind === 'APPLIES'),
    resolvedSubjects: [...resolvedSubjects].map(([subjectRef, microsoftUserId]) => ({ subjectRef, microsoftUserId })),
    counts: {
      rows: rows.length,
      applies,
      doesNotApplyByReason,
      unknownByObservation,
      unprocessableByReason,
      unselectedSourceRows,
    },
    coverage: {
      consideredRows,
      normalizedRows: ordered.length,
      recognizedRows: applies + outOfScopeTotal,
    },
    shapeObservations: {
      graphErrorCodeShape,
      graphIsInteractive,
      graphIsInteractiveAmongCredentialFailures,
    },
  };
}
