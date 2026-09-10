import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ROWS_PER_RUN,
  type DirectoryUserRow,
  type NormalizationBatch,
  type NormalizationScope,
  type NormalizationSource,
  type ReferenceResolver,
  type SignInRow,
} from './contract.js';
import {
  DISPROVED_PREDICATE_PATHS,
  RESULT_CODES,
  SHAPE_PREDICATES,
  dispositionForCode,
  mayExclude,
} from './provider-facts.js';
import { normalizeSignInBatch } from './normalize.js';
import {
  OUT_OF_SCOPE_LABELS,
  UNKNOWN_LABELS,
  UNPROCESSABLE_LABELS,
  describeOutOfScope,
  describeUnknown,
  describeUnprocessable,
  type OutOfScopeReason,
  type UnknownObservation,
  type UnprocessableReason,
} from './reasons.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const MICROSOFT_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';
const APP_ID = '55555555-5555-4555-8555-555555555555';

const SCOPE: NormalizationScope = {
  organizationId: ORGANIZATION_ID,
  customerTenantId: CUSTOMER_TENANT_ID,
  microsoftTenantId: MICROSOFT_TENANT_ID,
};

const DIRECTORY: readonly DirectoryUserRow[] = [
  {
    organizationId: ORGANIZATION_ID,
    customerTenantId: CUSTOMER_TENANT_ID,
    microsoftUserId: USER_ID,
    userPrincipalName: 'ann@example.com',
    userType: 'Member',
  },
];

/**
 * Opaque, order-stable references. Deliberately NOT derived from the
 * identifier: a reference that embeds the raw directory id would let these
 * tests pass while raw customer identifiers travelled on the events.
 */
function makeReference(): ReferenceResolver {
  const issued = new Map<string, string>();
  return async (kind, identifier) => {
    const key = `${kind}:${identifier.toLowerCase()}`;
    const existing = issued.get(key);
    if (existing !== undefined) return existing;
    const value = `hvr1_${kind}_ref${issued.size + 1}`;
    issued.set(key, value);
    return value;
  };
}

function graphRow(raw: Record<string, unknown> = {}, overrides: Partial<SignInRow> = {}): SignInRow {
  return {
    organizationId: ORGANIZATION_ID,
    customerTenantId: CUSTOMER_TENANT_ID,
    ingestedAt: new Date('2026-09-10T10:05:00.000Z'),
    raw: {
      id: 'evt-1',
      createdDateTime: '2026-09-10T10:00:00.000Z',
      userId: USER_ID,
      appId: APP_ID,
      ipAddress: '203.0.113.10',
      status: { errorCode: 50126, failureReason: 'Invalid username or password.' },
      ...raw,
    },
    ...overrides,
  };
}

async function run(
  rows: readonly SignInRow[],
  options: {
    directory?: readonly DirectoryUserRow[];
    source?: NormalizationSource;
    reference?: ReferenceResolver;
  } = {},
): Promise<NormalizationBatch> {
  return normalizeSignInBatch({
    scope: SCOPE,
    source: options.source ?? 'GRAPH_SIGN_INS',
    rows,
    directory: options.directory ?? DIRECTORY,
    reference: options.reference ?? makeReference(),
  });
}

function only(batch: NormalizationBatch) {
  assert.equal(batch.events.length, 1, 'expected exactly one normalized event');
  return batch.events[0]!;
}

// ---------------------------------------------------------------------------
// Rule 1: UNKNOWN must never block anything.
// ---------------------------------------------------------------------------

test('unrecognized events never remove a recognized credential failure from evaluation', async () => {
  const unrecognized = Array.from({ length: 25 }, (_, index) =>
    graphRow({ id: `noise-${index}`, status: { errorCode: 99999 + index } }),
  );
  const batch = await run([...unrecognized, graphRow({ id: 'real' })]);

  assert.equal(batch.counts.applies, 1);
  assert.equal(batch.applies.length, 1);
  assert.equal(batch.applies[0]!.eventId, 'real');
  assert.deepEqual(batch.applies[0]!.classification, { kind: 'APPLIES', outcome: 'INVALID_CREDENTIAL' });
  assert.equal(batch.counts.unknownByObservation.UNRECOGNIZED_ERROR_CODE, 25);
});

test('a batch that is entirely unrecognized still returns events and no gate', async () => {
  const batch = await run([graphRow({ status: { errorCode: 777777 } })]);

  assert.equal(batch.counts.applies, 0);
  assert.equal(batch.events.length, 1);
  // Nothing in the batch is a readiness flag, a gap count, or a partial state
  // the evaluation core could branch on to skip a rule.
  assert.deepEqual(Object.keys(batch).sort(), [
    'applies', 'counts', 'coverage', 'events', 'resolvedSubjects', 'scope', 'shapeObservations', 'source',
  ]);
  assert.deepEqual(Object.keys(batch.coverage).sort(), ['consideredRows', 'normalizedRows', 'recognizedRows']);
});

test('unprocessable rows never remove a recognized credential failure from evaluation', async () => {
  const batch = await run([
    graphRow({}, { raw: 'not-an-object' }),
    graphRow({ id: 'no-subject', userId: 'not-a-guid' }),
    graphRow({ id: 'real' }),
  ]);

  assert.equal(batch.counts.applies, 1);
  assert.equal(batch.applies[0]!.eventId, 'real');
  assert.equal(batch.counts.unprocessableByReason.RAW_PAYLOAD_MALFORMED, 1);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_ID_ABSENT_OR_MALFORMED, 1);
});

// ---------------------------------------------------------------------------
// Rule 2: never sum "could not process" with "does not apply".
// ---------------------------------------------------------------------------

test('a malformed row and an MFA interrupt land in different counters', async () => {
  const batch = await run([
    graphRow({}, { raw: null }),
    graphRow({ id: 'mfa', status: { errorCode: 50076 } }),
  ]);

  assert.equal(batch.counts.unprocessableByReason.RAW_PAYLOAD_MALFORMED, 1);
  assert.equal(batch.counts.doesNotApplyByReason.MFA_INTERRUPT, 1);
  // The distinction is only real if neither total can absorb the other.
  assert.equal(batch.counts.doesNotApplyByReason.NON_INTERACTIVE_SIGN_IN, 0);
  assert.equal(batch.counts.unknownByObservation.UNRECOGNIZED_ERROR_CODE, 0);
  assert.equal(batch.coverage.recognizedRows, 1, 'the MFA interrupt is recognized; the malformed row is not');
  assert.equal(batch.coverage.consideredRows, 2);
  assert.equal(batch.coverage.normalizedRows, 1);
});

test('the three reason vocabularies share no key, so no counter can be double-read', () => {
  const outOfScope = Object.keys(OUT_OF_SCOPE_LABELS);
  const unknown = Object.keys(UNKNOWN_LABELS);
  const unprocessable = Object.keys(UNPROCESSABLE_LABELS);
  const all = [...outOfScope, ...unknown, ...unprocessable];
  assert.equal(new Set(all).size, all.length, 'a reason key appears in more than one vocabulary');
});

test('every reason is reported with a zero, so a reporting layer cannot omit one', async () => {
  const batch = await run([graphRow()]);
  assert.deepEqual(Object.keys(batch.counts.doesNotApplyByReason).sort(), Object.keys(OUT_OF_SCOPE_LABELS).sort());
  assert.deepEqual(Object.keys(batch.counts.unknownByObservation).sort(), Object.keys(UNKNOWN_LABELS).sort());
  assert.deepEqual(Object.keys(batch.counts.unprocessableByReason).sort(), Object.keys(UNPROCESSABLE_LABELS).sort());
});

test('the tallies plus the unselected feed account for every row handed in', async () => {
  const batch = await run([
    graphRow({ id: 'applies' }),
    graphRow({ id: 'scope-out', status: { errorCode: 50140 } }),
    graphRow({ id: 'unknown', status: { errorCode: 4242 } }),
    graphRow({}, { raw: 7 }),
    graphRow({ hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY' }),
  ]);
  const sum = (counts: Readonly<Record<string, number>>) => Object.values(counts).reduce((a, b) => a + b, 0);
  const accounted =
    batch.counts.applies +
    sum(batch.counts.doesNotApplyByReason) +
    sum(batch.counts.unknownByObservation) +
    sum(batch.counts.unprocessableByReason) +
    batch.counts.unselectedSourceRows;
  assert.equal(accounted, batch.counts.rows);
  assert.equal(batch.counts.unselectedSourceRows, 1);
});

test('rows from the feed that was not selected are counted separately, not as a defect', async () => {
  const batch = await run([graphRow({ hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY' })]);
  assert.equal(batch.counts.unselectedSourceRows, 1);
  assert.equal(batch.coverage.consideredRows, 0, 'the unselected feed is not part of the assessed scope');
  assert.equal(Object.values(batch.counts.unprocessableByReason).reduce((a, b) => a + b, 0), 0);
  assert.equal(Object.values(batch.counts.doesNotApplyByReason).reduce((a, b) => a + b, 0), 0);
});

// ---------------------------------------------------------------------------
// Rule 3: no default arm, and no label that sends a technician chasing ghosts.
// ---------------------------------------------------------------------------

test('every reason in every vocabulary has a distinct non-empty label', () => {
  const labels: string[] = [
    ...(Object.keys(OUT_OF_SCOPE_LABELS) as OutOfScopeReason[]).map(describeOutOfScope),
    ...(Object.keys(UNKNOWN_LABELS) as UnknownObservation[]).map(describeUnknown),
    ...(Object.keys(UNPROCESSABLE_LABELS) as UnprocessableReason[]).map(describeUnprocessable),
  ];
  for (const label of labels) assert.ok(label.length > 12, `label too short to be meaningful: ${label}`);
  assert.equal(new Set(labels).size, labels.length, 'two reasons share a label');
});

test('out-of-scope and unknown labels never point at collection', () => {
  // The predecessor fell back to a label meaning "incomplete collection
  // window", which told technicians to chase a collection failure that did
  // not exist. Only the unprocessable vocabulary may mention data quality.
  const forbidden = /collect|incomplete|stale|window|retry|permission/i;
  for (const reason of Object.keys(OUT_OF_SCOPE_LABELS) as OutOfScopeReason[]) {
    assert.doesNotMatch(describeOutOfScope(reason), forbidden, `${reason} reads as a collection fault`);
  }
  for (const observation of Object.keys(UNKNOWN_LABELS) as UnknownObservation[]) {
    assert.doesNotMatch(describeUnknown(observation), forbidden, `${observation} reads as a collection fault`);
  }
});

// ---------------------------------------------------------------------------
// Disproved predicates. These two tests are the ones that would have caught
// the real bugs, because each supplies the control cohort that must NOT match.
// ---------------------------------------------------------------------------

test('a non-empty servicePrincipalId does not change how a human sign-in is classified', async () => {
  // servicePrincipalId is non-empty on 100% of Graph rows INCLUDING ordinary
  // human sign-ins, and servicePrincipalName is always empty. The control
  // cohort here is the human sign-in itself: it must still be evaluated.
  const withServicePrincipal = await run([
    graphRow({ servicePrincipalId: '77777777-7777-4777-8777-777777777777', servicePrincipalName: '' }),
  ]);
  const withoutServicePrincipal = await run([graphRow()]);

  assert.deepEqual(only(withServicePrincipal).classification, { kind: 'APPLIES', outcome: 'INVALID_CREDENTIAL' });
  assert.deepEqual(
    only(withServicePrincipal).classification,
    only(withoutServicePrincipal).classification,
    'servicePrincipalId changed a classification; it discriminates nothing and must not be read',
  );
  assert.equal(withServicePrincipal.counts.applies, 1);
});

test('signInEventTypes does not change how a sign-in is classified', async () => {
  // signInEventTypes is absent from every row in the dataset, so a predicate
  // on it matches nothing. Asserting behaviour rather than absence is what
  // keeps it from being reintroduced as a "verified fix" that changes nothing.
  const withTypes = await run([graphRow({ signInEventTypes: ['servicePrincipal', 'managedIdentity'] })]);
  const withoutTypes = await run([graphRow()]);

  assert.deepEqual(only(withTypes).classification, { kind: 'APPLIES', outcome: 'INVALID_CREDENTIAL' });
  assert.deepEqual(only(withTypes).classification, only(withoutTypes).classification);
});

test('disproved predicates are recorded and cannot be consulted', () => {
  assert.deepEqual(
    [...DISPROVED_PREDICATE_PATHS].sort(),
    ['raw.servicePrincipalId', 'raw.servicePrincipalName', 'raw.signInEventTypes'],
  );
  assert.throws(() => mayExclude('graph.service-principal-id'), /DISPROVED_PREDICATE/);
  assert.throws(() => mayExclude('graph.sign-in-event-types'), /DISPROVED_PREDICATE/);
  assert.throws(() => mayExclude('graph.no-such-predicate'), /UNKNOWN_PREDICATE/);
});

// ---------------------------------------------------------------------------
// Unverified predicates are observed, never acted on.
// ---------------------------------------------------------------------------

test('isInteractive is not yet confirmed, so it changes nothing and is only counted', async () => {
  assert.equal(mayExclude('graph.is-interactive-false'), false);

  const batch = await run([
    graphRow({ id: 'non-interactive', isInteractive: false }),
    graphRow({ id: 'interactive', isInteractive: true }),
    graphRow({ id: 'absent' }),
  ]);

  // All three stay in evaluation. Routing the non-interactive one to UNKNOWN
  // would remove it just as effectively as routing it out of scope.
  assert.equal(batch.counts.applies, 3);
  assert.equal(batch.counts.doesNotApplyByReason.NON_INTERACTIVE_SIGN_IN, 0);
  assert.deepEqual(batch.shapeObservations.graphIsInteractive, { TRUE: 1, FALSE: 1, NULL: 0, ABSENT: 1, OTHER_TYPE: 0 });
});

test('the control cohort for isInteractive is reported separately', async () => {
  // Rows carrying 50126 are unambiguously human interactive password
  // failures. If they report FALSE or ABSENT, the predicate is wrong or inert
  // and must never exclude anything. This is the check, run by this layer.
  const batch = await run([
    graphRow({ id: 'failure-a', isInteractive: true, status: { errorCode: 50126 } }),
    graphRow({ id: 'failure-b', status: { errorCode: 50126 } }),
    graphRow({ id: 'refresh', isInteractive: false, status: { errorCode: 4242 } }),
  ]);

  assert.deepEqual(batch.shapeObservations.graphIsInteractiveAmongCredentialFailures, {
    TRUE: 1, FALSE: 0, NULL: 0, ABSENT: 1, OTHER_TYPE: 0,
  });
});

test('the result-code shape distribution is reported, including string codes', async () => {
  const batch = await run([
    graphRow({ id: 'number', status: { errorCode: 50126 } }),
    graphRow({ id: 'string', status: { errorCode: '50126' } }),
    graphRow({ id: 'junk', status: { errorCode: 'fifty-thousand' } }),
    graphRow({ id: 'null', status: { errorCode: null } }),
    graphRow({ id: 'absent', status: {} }),
    graphRow({ id: 'no-status' }, { raw: {
      id: 'no-status', createdDateTime: '2026-09-10T10:00:00.000Z',
      organizationId: ORGANIZATION_ID, userId: USER_ID, appId: APP_ID,
    } }),
  ]);

  assert.deepEqual(batch.shapeObservations.graphErrorCodeShape, {
    NUMBER: 1, NUMERIC_STRING: 1, OTHER_STRING: 1, NULL: 1, ABSENT: 2, OTHER_TYPE: 0,
  });
  // A numeric string is read rather than discarded: if that is how production
  // stores the code, refusing it would send every row to UNKNOWN.
  const asString = batch.events.find(event => event.eventId === 'string')!;
  assert.deepEqual(asString.classification, { kind: 'APPLIES', outcome: 'INVALID_CREDENTIAL' });
  const junk = batch.events.find(event => event.eventId === 'junk')!;
  assert.deepEqual(junk.classification, { kind: 'UNKNOWN', observation: 'ERROR_CODE_SHAPE_UNRECOGNIZED' });
  const absent = batch.events.find(event => event.eventId === 'absent')!;
  assert.deepEqual(absent.classification, { kind: 'UNKNOWN', observation: 'ERROR_CODE_ABSENT' });
});

// ---------------------------------------------------------------------------
// Result-code dispositions.
// ---------------------------------------------------------------------------

test('errorCode 0 is a success with an absent, empty, or "Other." failure reason', async () => {
  for (const failureReason of [undefined, null, '', 'Other.']) {
    const status: Record<string, unknown> = { errorCode: 0 };
    if (failureReason !== undefined) status.failureReason = failureReason;
    const batch = await run([graphRow({ status })]);
    assert.deepEqual(
      only(batch).classification,
      { kind: 'APPLIES', outcome: 'SUCCESS' },
      `failureReason ${JSON.stringify(failureReason)} should still be a success`,
    );
  }
});

test('errorCode 0 with an unrecognized failure reason is unknown, not a success', async () => {
  const batch = await run([graphRow({ status: { errorCode: 0, failureReason: 'Something we have never seen' } })]);
  assert.deepEqual(only(batch).classification, {
    kind: 'UNKNOWN',
    observation: 'SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON',
  });
});

test('50053 is ambiguous and its failure-reason text never changes the classification', async () => {
  // 50053 carries two different meanings distinguished only by free text:
  // smart lockout after repeated failures, and blocked-from-malicious-IP. One
  // tenant, one locale, six weeks is not a durable text contract.
  const lockout = await run([graphRow({ status: { errorCode: 50053, failureReason: 'You’ve tried to sign in too many times with an incorrect user ID or password.' } })]);
  const malicious = await run([graphRow({ status: { errorCode: 50053, failureReason: 'Sign-in was blocked because it came from an IP address with malicious activity.' } })]);
  const bare = await run([graphRow({ status: { errorCode: 50053 } })]);

  const expected = { kind: 'UNKNOWN', observation: 'AMBIGUOUS_DOCUMENTED_CODE' };
  assert.deepEqual(only(lockout).classification, expected);
  assert.deepEqual(only(malicious).classification, expected);
  assert.deepEqual(only(bare).classification, expected);
});

test('error code 1 is HawkView’s own invention and gets no Microsoft code logic', async () => {
  const batch = await run([graphRow({ status: { errorCode: 1, failureReason: 'Other.' } })]);
  assert.deepEqual(only(batch).classification, {
    kind: 'UNKNOWN',
    observation: 'HAWKVIEW_SYNTHETIC_ERROR_CODE',
  });
});

test('interrupts and policy decisions are out of scope, never credential verdicts', async () => {
  const cases: readonly [number, OutOfScopeReason][] = [
    [50074, 'MFA_INTERRUPT'],
    [50076, 'MFA_INTERRUPT'],
    [50072, 'MFA_INTERRUPT'],
    [50079, 'MFA_INTERRUPT'],
    [50140, 'KEEP_ME_SIGNED_IN'],
    [50058, 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN'],
    [53003, 'CONDITIONAL_ACCESS_INTERRUPT'],
    [65001, 'CONSENT_REQUIRED'],
  ];
  for (const [code, reason] of cases) {
    const batch = await run([graphRow({ status: { errorCode: code } })]);
    assert.deepEqual(only(batch).classification, { kind: 'DOES_NOT_APPLY', reason }, `code ${code}`);
  }
});

test('an unlisted code is unknown, and no code is mapped to a credential verdict by accident', () => {
  assert.deepEqual(dispositionForCode(123456), { kind: 'UNKNOWN', observation: 'UNRECOGNIZED_ERROR_CODE' });
  const applying = RESULT_CODES.filter(entry => entry.disposition.kind === 'APPLIES').map(entry => entry.code);
  assert.deepEqual(applying.sort((a, b) => a - b), [0, 50126]);
  assert.equal(new Set(RESULT_CODES.map(entry => entry.code)).size, RESULT_CODES.length);
});

test('every shape predicate carries a verification state and disproved ones carry evidence', () => {
  assert.ok(SHAPE_PREDICATES.length > 0);
  for (const predicate of SHAPE_PREDICATES) {
    const { verification } = predicate;
    if (verification.state === 'PENDING_DISTRIBUTION_CHECK') {
      assert.ok(verification.controlCohort.length > 20, `${predicate.id} has no control cohort`);
    } else {
      assert.ok(verification.evidence.length > 20, `${predicate.id} has no evidence`);
    }
  }
});

// ---------------------------------------------------------------------------
// Subject binding: exact directory object id, never a name.
// ---------------------------------------------------------------------------

test('a directory object id absent from the directory does not bind to anyone', async () => {
  const batch = await run([graphRow({ userId: OTHER_USER_ID })]);
  assert.equal(batch.events.length, 0);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_NOT_IN_DIRECTORY, 1);
});

test('a user principal name in the subject field never binds', async () => {
  const batch = await run([graphRow({ userId: 'ann@example.com' })]);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_ID_ABSENT_OR_MALFORMED, 1);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_NOT_IN_DIRECTORY, 0);
});

test('directory object ids match case-insensitively and carry a protected reference', async () => {
  const batch = await run([graphRow({ userId: USER_ID.toUpperCase() })]);
  const event = only(batch);
  assert.equal(event.subjectRef, 'hvr1_subject_ref1');
  assert.equal(event.applicationRef, 'hvr1_application_ref2');
  assert.deepEqual(batch.resolvedSubjects, [{ subjectRef: 'hvr1_subject_ref1', microsoftUserId: USER_ID }]);
  // The raw directory id never travels on the event itself; it is available
  // only through the separate resolvedSubjects mapping.
  assert.equal(JSON.stringify(event).includes(USER_ID.toLowerCase()), false);
  assert.equal(JSON.stringify(event).includes(APP_ID.toLowerCase()), false);
});

test('an ambiguous directory object id does not bind', async () => {
  const batch = await run([graphRow()], {
    directory: [DIRECTORY[0]!, { ...DIRECTORY[0]!, userPrincipalName: 'ann.other@example.com' }],
  });
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_AMBIGUOUS_IN_DIRECTORY, 1);
});

test('a user with an unexpected userType is still bound', async () => {
  // Filtering the directory index by userType would be an unverified
  // exclusion predicate, and it would report the user as missing from the
  // directory, which reads as a collection fault.
  const batch = await run([graphRow()], { directory: [{ ...DIRECTORY[0]!, userType: null }] });
  assert.equal(batch.counts.applies, 1);
});

test('a directory row from another tenant aborts the run rather than being counted', async () => {
  await assert.rejects(
    run([graphRow()], { directory: [{ ...DIRECTORY[0]!, customerTenantId: OTHER_USER_ID }] }),
    /DIRECTORY_SCOPE_MISMATCH/,
  );
});

test('the audit feed cannot resolve a subject and says so instead of matching by name', async () => {
  const batch = await run(
    [graphRow({ hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY', UserId: 'ann@example.com' })],
    { source: 'M365_AUDIT_STS' },
  );
  assert.equal(batch.events.length, 0);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_NOT_RESOLVABLE_WITHOUT_GUID, 1);
  assert.equal(batch.coverage.consideredRows, 1);
  assert.equal(batch.coverage.recognizedRows, 0);
});

// ---------------------------------------------------------------------------
// Row-level defects, ordering, and bounds.
// ---------------------------------------------------------------------------

test('row defects are each named, and none of them is a scope decision', async () => {
  const cases: readonly [SignInRow, UnprocessableReason][] = [
    [graphRow({}, { organizationId: OTHER_USER_ID }), 'SCOPE_MISMATCH'],
    [graphRow({}, { raw: [] }), 'RAW_PAYLOAD_MALFORMED'],
    [graphRow({ hawkviewSource: 'SOMETHING_ELSE' }), 'SOURCE_UNRECOGNIZED'],
    [graphRow({ id: '' }), 'EVENT_ID_ABSENT_OR_MALFORMED'],
    [graphRow({ createdDateTime: '2026-09-10 10:00:00' }), 'EVENT_TIMESTAMP_INVALID'],
    [graphRow({}, { ingestedAt: new Date('2026-09-10T09:00:00.000Z') }), 'INGESTION_PRECEDES_EVENT'],
    [graphRow({}, { ingestedAt: new Date('nope') }), 'INGESTION_TIMESTAMP_INVALID'],
    [graphRow({ hawkviewAuthenticationIntegrity: { disputed: true } }), 'INTEGRITY_DISPUTED'],
    [graphRow({ appId: 'contoso-mail' }), 'APPLICATION_ID_ABSENT_OR_MALFORMED'],
  ];
  for (const [row, reason] of cases) {
    const batch = await run([row]);
    assert.equal(batch.counts.unprocessableByReason[reason], 1, `expected ${reason}`);
    assert.equal(Object.values(batch.counts.doesNotApplyByReason).reduce((a, b) => a + b, 0), 0);
    assert.equal(Object.values(batch.counts.unknownByObservation).reduce((a, b) => a + b, 0), 0);
  }
});

test('a reference resolver outage is a named row defect, not a silent gap', async () => {
  const batch = await run([graphRow(), graphRow({ id: 'evt-2' })], {
    reference: async () => { throw new Error('kms unavailable'); },
  });
  assert.equal(batch.events.length, 0);
  assert.equal(batch.counts.unprocessableByReason.REFERENCE_UNAVAILABLE, 2);
});

test('a resolver returning an unusable reference does not produce an event', async () => {
  const batch = await run([graphRow()], { reference: async () => '' });
  assert.equal(batch.counts.unprocessableByReason.REFERENCE_UNAVAILABLE, 1);
});

test('events are ordered by event time, then by event id', async () => {
  const batch = await run([
    graphRow({ id: 'b', createdDateTime: '2026-09-10T10:00:00.000Z' }),
    graphRow({ id: 'a', createdDateTime: '2026-09-10T10:00:00.000Z' }),
    graphRow({ id: 'earlier', createdDateTime: '2026-09-10T09:00:00.000Z' }),
  ]);
  assert.deepEqual(batch.events.map(event => event.eventId), ['earlier', 'a', 'b']);
  assert.deepEqual(batch.applies.map(event => event.eventId), ['earlier', 'a', 'b']);
});

test('the client address is canonicalized and its absence is qualified, not dropped', async () => {
  const missing = await run([graphRow({ ipAddress: undefined })]);
  assert.deepEqual(only(missing).clientSource, { qualification: 'MISSING', address: null });
  const ipv6 = await run([graphRow({ ipAddress: '2001:DB8::1' })]);
  assert.deepEqual(only(ipv6).clientSource, { qualification: 'QUALIFIED', address: '2001:db8::1' });
  const garbage = await run([graphRow({ ipAddress: 'unknown' })]);
  assert.deepEqual(only(garbage).clientSource, { qualification: 'MISSING', address: null });
});

test('the per-run row bound costs the excess rows, never the run', async () => {
  const rows = Array.from({ length: MAX_ROWS_PER_RUN + 3 }, (_, index) =>
    index === 0
      ? graphRow({ id: 'real' })
      : graphRow({ id: `filler-${index}`, userId: 'not-a-guid' }),
  );
  const batch = await run(rows);

  assert.equal(batch.counts.applies, 1, 'the row inside the bound is still evaluated');
  assert.equal(batch.counts.unprocessableByReason.BATCH_LIMIT_EXCEEDED, 3);
  assert.equal(batch.counts.rows, MAX_ROWS_PER_RUN + 3);
});
