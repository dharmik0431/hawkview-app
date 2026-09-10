import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ROWS_PER_RUN,
  coverageForEvaluation,
  isPostPasswordInterrupt,
  passwordWasAccepted,
  type DirectoryUserRow,
  type EventOutcome,
  type NormalizationBatch,
  type NormalizationScope,
  type NormalizationSource,
  type ReferenceResolver,
  type SignInRow,
} from './contract.js';
import {
  DISPROVED_PREDICATE_PATHS,
  FAILURE_REASON_MEANINGS,
  RESULT_CODES,
  SHAPE_PREDICATES,
  OBSERVED_BUT_UNMAPPED_GRAPH_CODES,
  OBSERVED_GRAPH_ERROR_CODES,
  UNREACHABLE_BY_SUBJECT_RESOLUTION,
  UNVALIDATED_FAILURE_REASON_MEANINGS,
  dispositionForCode,
  AUDIT_REASON_NAMES,
  AUDIT_REASON_NAMES_OBSERVED_UNMAPPED,
  auditReasonEntry,
  failureReasonMeaning,
  mayExclude,
  resultCodeEntry,
} from './provider-facts.js';
import { normalizeSignInBatch } from './normalize.js';
import {
  OUT_OF_SCOPE_LABELS,
  UNKNOWN_LABELS,
  COLLECTION_SCOPE_LABELS,
  UNCITED_LABELS,
  UNPROCESSABLE_LABELS,
  UNSELECTED_ROW_LABELS,
  describeCollectionScope,
  describeOutOfScope,
  describeUncited,
  describeUnknown,
  describeUnprocessable,
  describeUnselectedRow,
  type CollectionScope,
  type OutOfScopeReason,
  type UncitedReason,
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
 * identifier: a reference embedding the raw directory id would let these tests
 * pass while raw customer identifiers travelled on the events.
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
      isInteractive: true,
      status: { errorCode: 50126, failureReason: 'Invalid username or password.' },
      ...raw,
    },
    ...overrides,
  };
}

function auditRow(record: Record<string, unknown> = {}, overrides: Partial<SignInRow> = {}): SignInRow {
  return {
    organizationId: ORGANIZATION_ID,
    customerTenantId: CUSTOMER_TENANT_ID,
    ingestedAt: new Date('2026-09-10T10:05:00.000Z'),
    raw: {
      hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
      managementActivityRecord: {
        Id: 'aud-1',
        CreationTime: '2026-09-10T10:00:00.000Z',
        OrganizationId: MICROSOFT_TENANT_ID,
        RecordType: 15,
        Operation: 'UserLoginFailed',
        UserId: 'ann@example.com',
        ApplicationId: APP_ID,
        ClientIP: '203.0.113.10',
        ErrorCode: '50126',
        ...record,
      },
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
    collectionScope?: CollectionScope;
  } = {},
): Promise<NormalizationBatch> {
  const source = options.source ?? 'GRAPH_SIGN_INS';
  return normalizeSignInBatch({
    scope: SCOPE,
    source,
    rows,
    directory: options.directory ?? DIRECTORY,
    reference: options.reference ?? makeReference(),
    collectionScope:
      options.collectionScope ?? (source === 'GRAPH_SIGN_INS' ? 'GRAPH_INTERACTIVE_ONLY' : 'AUDIT_STS_LOGON_EVENTS'),
  });
}

function only(batch: NormalizationBatch) {
  assert.equal(batch.events.length, 1, 'expected exactly one normalized event');
  return batch.events[0]!;
}

const total = (counts: Readonly<Record<string, number>>) => Object.values(counts).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Rule 1: UNKNOWN must never block anything.
// ---------------------------------------------------------------------------

test('unrecognized events never remove a recognized credential failure from evaluation', async () => {
  const unrecognized = Array.from({ length: 25 }, (_, index) =>
    graphRow({ id: `noise-${index}`, status: { errorCode: 99999 + index } }),
  );
  const batch = await run([...unrecognized, graphRow({ id: 'real' })]);

  assert.equal(batch.counts.applies, 1);
  assert.equal(batch.applies[0]!.eventId, 'real');
  assert.deepEqual(batch.applies[0]!.classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  assert.equal(batch.counts.unknownByObservation.UNRECOGNIZED_ERROR_CODE, 25);
});

test('a batch that is entirely unrecognized still returns events and no gate', async () => {
  const batch = await run([graphRow({ status: { errorCode: 777777 } })]);

  assert.equal(batch.counts.applies, 0);
  assert.equal(batch.events.length, 1);
  // Nothing in the batch is a readiness flag, a gap count, or a partial state
  // the evaluation core could branch on to skip a rule.
  assert.deepEqual(Object.keys(batch).sort(), [
    'applies', 'counts', 'coverage', 'events', 'microsoftRiskVerdicts',
    'microsoftSafetyVerdicts', 'resolvedSubjects', 'scope', 'shapeObservations', 'source',
  ]);
  assert.deepEqual(Object.keys(batch.coverage).sort(), [
    'collectionScope', 'consideredRows', 'normalizedRows', 'recognizedRows',
  ]);
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

test('a malformed row and an expected-flow interrupt land in different counters', async () => {
  const batch = await run([
    graphRow({}, { raw: null }),
    graphRow({ id: 'kmsi', status: { errorCode: 50140 } }),
  ]);

  assert.equal(batch.counts.unprocessableByReason.RAW_PAYLOAD_MALFORMED, 1);
  assert.equal(batch.counts.doesNotApplyByReason.KEEP_ME_SIGNED_IN, 1);
  assert.equal(batch.coverage.recognizedRows, 1, 'the interrupt is recognized; the malformed row is not');
  assert.equal(batch.coverage.consideredRows, 2);
  assert.equal(batch.coverage.normalizedRows, 1);
});

test('the reason vocabularies share no key, so no counter can be double-read', () => {
  const all = [
    ...Object.keys(OUT_OF_SCOPE_LABELS),
    ...Object.keys(UNCITED_LABELS),
    ...Object.keys(UNKNOWN_LABELS),
    ...Object.keys(UNPROCESSABLE_LABELS),
    ...Object.keys(UNSELECTED_ROW_LABELS),
  ];
  assert.equal(new Set(all).size, all.length, 'a reason key appears in more than one vocabulary');
});

test('"we never looked" is reported by reason, not as a bare number', () => {
  // A consumer has to be able to tell a feed boundary, which is harmless, from
  // a scope narrowing, which by the verification rule should not exist. One
  // member is the answer, and a second appearing is visible rather than
  // absorbed into a total.
  assert.deepEqual(Object.keys(UNSELECTED_ROW_LABELS), ['ROW_FROM_OTHER_FEED']);
  assert.ok(describeUnselectedRow('ROW_FROM_OTHER_FEED').length > 12);
});

test('"we lack a citation" is a sibling of unknown, not a reason inside it', () => {
  // Gating a clean claim on anything unknown would let eighteen rows of a
  // well-understood consent prompt withhold a tenant's claim indefinitely. As
  // its own classification, a switch forces a consumer to decide about it.
  const uncited: UncitedReason[] = Object.keys(UNCITED_LABELS) as UncitedReason[];
  assert.deepEqual(uncited, ['EXCLUSION_NOT_YET_CITED']);
  assert.ok(describeUncited('EXCLUSION_NOT_YET_CITED').length > 12);
  for (const key of uncited) {
    assert.equal(Object.keys(UNKNOWN_LABELS).includes(key), false, 'must not also live inside unknown');
  }
  // 50158 stays in unknown: no citation can resolve it, because the ambiguity
  // is Microsoft's own statement about the code, not our unfinished homework.
  assert.ok(Object.keys(UNKNOWN_LABELS).includes('AMBIGUOUS_BY_PROVIDER_STATEMENT'));
});

test('the evaluation coverage view keeps "no citation" out of the gate', async () => {
  const batch = await run([
    graphRow({ id: 'applies', status: { errorCode: 50126 } }),
    graphRow({ id: 'consent', status: { errorCode: 65001 } }),
    graphRow({ id: 'unreadable', status: { errorCode: 424242 } }),
    graphRow({ id: 'kmsi', status: { errorCode: 50140 } }),
    graphRow({}, { raw: null }),
  ]);
  const coverage = coverageForEvaluation(batch);

  assert.equal(coverage.applies, 1);
  assert.equal(coverage.doesNotApply.KEEP_ME_SIGNED_IN, 1);
  // 65001 is understood; only our basis for excluding it is missing. It is
  // disclosed, but it is not a limit on what we read, so it is NOT in the
  // number a consumer gates on.
  assert.equal(coverage.notYetCitedEvents, 1);
  assert.equal(coverage.uninterpretedEvents, 2, 'the unrecognized code and the malformed row');
  assert.deepEqual(Object.keys(coverage).sort(), [
    'applies', 'doesNotApply', 'notYetCited', 'notYetCitedEvents',
    'uninterpretedEvents', 'unknown', 'unprocessable',
  ]);
  // Recognized includes the uncited ones: we read those events correctly.
  assert.equal(batch.coverage.recognizedRows, 3);
});

test('every reason is reported with a zero, so a reporting layer cannot omit one', async () => {
  const batch = await run([graphRow()]);
  assert.deepEqual(Object.keys(batch.counts.doesNotApplyByReason).sort(), Object.keys(OUT_OF_SCOPE_LABELS).sort());
  assert.deepEqual(Object.keys(batch.counts.notYetCitedByReason).sort(), Object.keys(UNCITED_LABELS).sort());
  assert.deepEqual(Object.keys(batch.counts.unknownByObservation).sort(), Object.keys(UNKNOWN_LABELS).sort());
  assert.deepEqual(Object.keys(batch.counts.unprocessableByReason).sort(), Object.keys(UNPROCESSABLE_LABELS).sort());
});

test('the tallies plus the unselected feed account for every row handed in', async () => {
  const batch = await run([
    graphRow({ id: 'applies' }),
    graphRow({ id: 'scope-out', status: { errorCode: 50140 } }),
    graphRow({ id: 'unknown', status: { errorCode: 4242 } }),
    graphRow({}, { raw: 7 }),
    auditRow(),
  ]);
  const accounted =
    batch.counts.applies +
    total(batch.counts.doesNotApplyByReason) +
    total(batch.counts.unknownByObservation) +
    total(batch.counts.unprocessableByReason) +
    batch.counts.unselectedRowsByReason.ROW_FROM_OTHER_FEED;
  assert.equal(accounted, batch.counts.rows);
  assert.equal(batch.counts.unselectedRowsByReason.ROW_FROM_OTHER_FEED, 1);
});

test('rows from the feed that was not selected are counted separately, not as a defect', async () => {
  const batch = await run([auditRow()]);
  assert.equal(batch.counts.unselectedRowsByReason.ROW_FROM_OTHER_FEED, 1);
  assert.equal(batch.coverage.consideredRows, 0, 'the unselected feed is not part of the assessed scope');
  assert.equal(total(batch.counts.unprocessableByReason), 0);
  assert.equal(total(batch.counts.doesNotApplyByReason), 0);
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
// The exclusion standard: excluding a code needs a positive citation.
// ---------------------------------------------------------------------------

test('every out-of-scope code carries a documented citation', () => {
  const excluded = RESULT_CODES.filter(entry => entry.disposition.kind === 'DOES_NOT_APPLY');
  // 50058 and 50140 on Microsoft's own "expected part of the flow" statements;
  // 53004 on the owner's channel-separation rule, since ProofUpBlockedDueToRisk
  // is a block Microsoft's intelligence decided on.
  assert.deepEqual(excluded.map(entry => entry.code).sort((a, b) => a - b), [50058, 50140, 53004]);
  for (const entry of excluded) {
    assert.ok(
      entry.exclusionCitation && entry.exclusionCitation.length > 15,
      `${entry.code} is excluded with no citation; absence of a reason to include is not a reason to exclude`,
    );
  }
});

test('50076 is a control signal, not "not a credential event"', () => {
  // The predecessor confidently classified 50076 as NON_QUALIFYING. That is a
  // wrong CONFIDENT classification, so the unverified-predicate guard does not
  // reach it — it walks straight through. This test is the guard for it.
  assert.deepEqual(dispositionForCode(50076), {
    kind: 'APPLIES',
    outcome: 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED',
  });
  assert.deepEqual(dispositionForCode(50074), {
    kind: 'APPLIES',
    outcome: 'PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED',
  });
  for (const code of [50072, 50079, 500121]) {
    const disposition = dispositionForCode(code);
    assert.equal(disposition.kind, 'APPLIES', `code ${code} must stay in evaluation`);
  }
});

test('the post-password interrupt family is expressible and groupable', async () => {
  // The three-state predecessor vocabulary could not say "the password was
  // accepted and the sign-in did not complete", which is the basis of the
  // highest-value detector available without Entra ID P2.
  const batch = await run([
    graphRow({ id: 'rejected', status: { errorCode: 50126 } }),
    graphRow({ id: 'completed', status: { errorCode: 0, failureReason: 'Other.' } }),
    graphRow({ id: 'challenged', status: { errorCode: 50076 } }),
    graphRow({ id: 'not-passed', status: { errorCode: 50074 } }),
    graphRow({ id: 'unregistered', status: { errorCode: 50079 } }),
  ]);
  assert.equal(batch.counts.applies, 5);

  const outcomeOf = (eventId: string): EventOutcome => {
    const classification = batch.events.find(event => event.eventId === eventId)!.classification;
    assert.equal(classification.kind, 'APPLIES');
    return (classification as { kind: 'APPLIES'; outcome: EventOutcome }).outcome;
  };
  assert.equal(passwordWasAccepted(outcomeOf('rejected')), false);
  assert.equal(passwordWasAccepted(outcomeOf('completed')), true);
  assert.equal(isPostPasswordInterrupt(outcomeOf('completed')), false);
  for (const id of ['challenged', 'not-passed', 'unregistered']) {
    assert.equal(passwordWasAccepted(outcomeOf(id)), true, id);
    assert.equal(isPostPasswordInterrupt(outcomeOf(id)), true, id);
  }
});

test('codes with no exclusion citation are held, not excluded and not called unreadable', async () => {
  for (const code of [50055, 50144, 50056, 50133, 50173, 65001]) {
    const batch = await run([graphRow({ status: { errorCode: code } })]);
    assert.deepEqual(
      only(batch).classification,
      { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
      `code ${code}`,
    );
  }
  const ambiguous = await run([graphRow({ status: { errorCode: 50158 } })]);
  assert.deepEqual(only(ambiguous).classification, {
    kind: 'UNKNOWN',
    observation: 'AMBIGUOUS_BY_PROVIDER_STATEMENT',
  });
});

test('the two expected-flow codes are out of scope', async () => {
  const cases: readonly [number, OutOfScopeReason][] = [
    [50140, 'KEEP_ME_SIGNED_IN'],
    [50058, 'INSUFFICIENT_SESSION_FOR_SILENT_SIGN_IN'],
  ];
  for (const [code, reason] of cases) {
    const batch = await run([graphRow({ status: { errorCode: code } })]);
    assert.deepEqual(only(batch).classification, { kind: 'DOES_NOT_APPLY', reason }, `code ${code}`);
  }
});

test('the enumeration codes are recorded as a known blind spot rather than mapped', () => {
  // Requiring a resolved directory user means these can never be classified:
  // by definition their subject is not in the directory.
  assert.deepEqual(UNREACHABLE_BY_SUBJECT_RESOLUTION.map(entry => entry.code).sort((a, b) => a - b), [50034, 51004]);
  for (const entry of UNREACHABLE_BY_SUBJECT_RESOLUTION) {
    assert.equal(dispositionForCode(entry.code).kind, 'UNKNOWN', 'must not be silently mapped');
  }
});

// ---------------------------------------------------------------------------
// 50053: the meaning lives in the description text, parsed as a closed set.
// ---------------------------------------------------------------------------

test('50053 resolves its three documented meanings from the description text', async () => {
  const lockout = await run([graphRow({ status: {
    errorCode: 50053,
    failureReason: 'You’ve tried to sign in too many times with an incorrect user ID or password.',
  } })]);
  assert.deepEqual(only(lockout).classification, {
    kind: 'APPLIES',
    outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
  });

  // Microsoft's own threat intelligence made this call, so it is Microsoft's
  // channel rather than a control the tenant configured.
  const malicious = await run([graphRow({ status: {
    errorCode: 50053,
    failureReason: 'Sign-in was blocked because it came from an IP address with malicious activity.',
  } })]);
  assert.deepEqual(only(malicious).classification, {
    kind: 'DOES_NOT_APPLY',
    reason: 'MICROSOFT_RISK_VERDICT',
  });

  const risk = await run([graphRow({ status: {
    errorCode: 50053,
    failureReason: 'Sign-in was blocked by built-in protections due to high confidence of risk.',
  } })]);
  assert.deepEqual(only(risk).classification, {
    kind: 'DOES_NOT_APPLY',
    reason: 'MICROSOFT_RISK_VERDICT',
  });
});

test('50053 text that matches nothing, or more than one meaning, stays unknown', async () => {
  const bare = await run([graphRow({ status: { errorCode: 50053 } })]);
  assert.deepEqual(only(bare).classification, {
    kind: 'UNKNOWN',
    observation: 'AMBIGUOUS_FAILURE_REASON_TEXT',
  });

  const localised = await run([graphRow({ status: { errorCode: 50053, failureReason: 'Konto gesperrt.' } })]);
  assert.deepEqual(only(localised).classification, {
    kind: 'UNKNOWN',
    observation: 'AMBIGUOUS_FAILURE_REASON_TEXT',
  });

  // Two meanings in one string is the case where guessing would be tempting.
  const both = await run([graphRow({ status: {
    errorCode: 50053,
    failureReason: 'Blocked by built-in protections due to high confidence of risk after malicious activity.',
  } })]);
  assert.deepEqual(only(both).classification, {
    kind: 'UNKNOWN',
    observation: 'AMBIGUOUS_FAILURE_REASON_TEXT',
  });
  assert.equal(failureReasonMeaning('nothing familiar here'), null);
});

test('the description-text meanings are a closed set and each records its evidence', () => {
  assert.deepEqual(
    FAILURE_REASON_MEANINGS.map(pattern => pattern.meaning).sort(),
    ['HIGH_CONFIDENCE_RISK_BLOCK', 'MALICIOUS_IP_BLOCK', 'SMART_LOCKOUT', 'SUSPICIOUS_ACTIVITY_BLOCK'],
  );
  for (const pattern of FAILURE_REASON_MEANINGS) {
    assert.ok(pattern.fragments.length > 0);
    for (const fragment of pattern.fragments) {
      assert.equal(fragment, fragment.toLowerCase(), 'fragments are matched against lowercased text');
    }
  }
  // The risk-verdict branch has zero occurrences across all 1,479 rows of
  // 50053 in all history: it is present in code, exercised only synthetically,
  // and must not read as a working path.
  assert.deepEqual([...UNVALIDATED_FAILURE_REASON_MEANINGS].sort(), ['HIGH_CONFIDENCE_RISK_BLOCK', 'SUSPICIOUS_ACTIVITY_BLOCK']);
});

test('the one branch that removes an event from evaluation has the narrowest fragment', () => {
  // Every other branch keeps the event in `applies`, so a too-broad fragment
  // there costs an outcome label. The risk-verdict branch diverts the event
  // into Microsoft's channel and out of our findings entirely, so it is held
  // to a single distinctive phrase — and the two texts that DO occur in
  // production must not reach it.
  const risk = FAILURE_REASON_MEANINGS.find(pattern => pattern.meaning === 'HIGH_CONFIDENCE_RISK_BLOCK')!;
  assert.equal(risk.disposition.kind, 'DOES_NOT_APPLY');
  assert.deepEqual(risk.fragments, ['high confidence of risk']);

  for (const text of [
    'You’ve tried to sign in too many times with an incorrect user ID or password.',
    'Sign-in was blocked because it came from an IP address with malicious activity.',
    'The account is locked by built-in protections.',
  ]) {
    assert.notEqual(
      failureReasonMeaning(text)?.meaning,
      'HIGH_CONFIDENCE_RISK_BLOCK',
      `"${text}" must not be diverted out of our findings`,
    );
  }
});

test('the lockout gets its own outcome rather than being called an invalid credential', async () => {
  // It carries unique weight: for 94.8% of lockout rows there is no 50126 for
  // the same user within ±15 minutes, so at the moment of lockout this is the
  // only signal present. But a lockout is a refusal, not a credential that was
  // validated and found wrong, so it is not PASSWORD_REJECTED either.
  const batch = await run([graphRow({ status: {
    errorCode: 50053,
    failureReason: 'You’ve tried to sign in too many times with an incorrect user ID or password.',
  } })]);
  const classification = only(batch).classification;
  assert.deepEqual(classification, { kind: 'APPLIES', outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES' });
  assert.equal(passwordWasAccepted('LOCKED_OUT_AFTER_REPEATED_FAILURES'), false);
  assert.equal(isPostPasswordInterrupt('LOCKED_OUT_AFTER_REPEATED_FAILURES'), false);
});

test('Microsoft’s risk verdict is surfaced separately and kept out of our findings', async () => {
  // Our findings and Microsoft-reported risk are two evidence channels that
  // are never merged or summed. A verdict Microsoft reached is not a HawkView
  // finding — but it is the only Microsoft risk signal an unlicensed tenant
  // gets, so it must not be lost to a counter either.
  const batch = await run([
    graphRow({ id: 'ours', status: { errorCode: 50126 } }),
    graphRow({ id: 'microsofts', status: {
      errorCode: 50053,
      failureReason: 'Sign-in was blocked by built-in protections due to high confidence of risk.',
    } }),
  ]);

  assert.deepEqual(batch.applies.map(event => event.eventId), ['ours']);
  assert.deepEqual(batch.microsoftRiskVerdicts.map(event => event.eventId), ['microsofts']);
  assert.equal(batch.counts.doesNotApplyByReason.MICROSOFT_RISK_VERDICT, 1);
});

// ---------------------------------------------------------------------------
// Disproved predicates. Each supplies the control cohort that must NOT match.
// ---------------------------------------------------------------------------

test('a non-empty servicePrincipalId does not change how a human sign-in is classified', async () => {
  // servicePrincipalId is non-empty on 100% of Graph rows INCLUDING ordinary
  // human sign-ins. The control cohort is the human sign-in itself: it must
  // still be evaluated.
  const withServicePrincipal = await run([
    graphRow({ servicePrincipalId: '77777777-7777-4777-8777-777777777777', servicePrincipalName: '' }),
  ]);
  const withoutServicePrincipal = await run([graphRow()]);

  assert.deepEqual(only(withServicePrincipal).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  assert.deepEqual(
    only(withServicePrincipal).classification,
    only(withoutServicePrincipal).classification,
    'servicePrincipalId changed a classification; it discriminates nothing and must not be read',
  );
});

test('signInEventTypes does not change how a sign-in is classified', async () => {
  const withTypes = await run([graphRow({ signInEventTypes: ['servicePrincipal', 'managedIdentity'] })]);
  const withoutTypes = await run([graphRow()]);
  assert.deepEqual(only(withTypes).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  assert.deepEqual(only(withTypes).classification, only(withoutTypes).classification);
});

test('isInteractive is inert on real data and changes nothing', async () => {
  // true on 100% of 2,635 rows. The 50126 control cohort passes, but a
  // predicate true on every row discriminates nothing. Root cause is a
  // collection-scope gap: the collector applies no signInEventTypes filter, so
  // Graph returns its default interactive-only set.
  const interactive = await run([graphRow({ isInteractive: true })]);
  const nonInteractive = await run([graphRow({ isInteractive: false })]);
  const absent = await run([graphRow({}, { raw: {
    id: 'evt-1', createdDateTime: '2026-09-10T10:00:00.000Z',
    userId: USER_ID, appId: APP_ID, status: { errorCode: 50126 },
  } })]);

  for (const batch of [interactive, nonInteractive, absent]) {
    assert.deepEqual(only(batch).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  }
  assert.equal(nonInteractive.counts.doesNotApplyByReason.NON_INTERACTIVE_SIGN_IN, 0);
});

test('the audit ResultStatus is never consulted', async () => {
  // For STS logon events "Succeeded" means HTTP success, NOT logon success.
  // This one fails silently in the direction of calling failures successes.
  const succeeded = await run([auditRow({ ResultStatus: 'Succeeded' })], { source: 'M365_AUDIT_STS' });
  const failed = await run([auditRow({ ResultStatus: 'Failed' })], { source: 'M365_AUDIT_STS' });
  const absent = await run([auditRow()], { source: 'M365_AUDIT_STS' });

  for (const batch of [succeeded, failed, absent]) {
    assert.deepEqual(only(batch).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  }
});

test('disproved predicates are recorded and cannot be consulted', () => {
  assert.deepEqual(
    [...DISPROVED_PREDICATE_PATHS].sort(),
    [
      'managementActivityRecord.ResultStatus',
      'raw.isInteractive',
      'raw.servicePrincipalId',
      'raw.servicePrincipalName',
      'raw.signInEventTypes',
      'sign_in_logs.user_id',
    ],
  );
  for (const id of ['graph.service-principal-id', 'graph.sign-in-event-types', 'graph.is-interactive-false',
    'audit.result-status', 'signin.user-id-column']) {
    assert.throws(() => mayExclude(id), /DISPROVED_PREDICATE/, id);
  }
  assert.throws(() => mayExclude('graph.no-such-predicate'), /UNKNOWN_PREDICATE/);
});

test('a predicate whose control cohort does not exist is not treated as verified', () => {
  // Graph subject binding matches 100% positively, but zero observed rows
  // carry a well-formed GUID absent from the directory, so the unprocessable
  // path is untested against production and must not be recorded as passing.
  assert.equal(mayExclude('graph.subject-directory-object-id'), false);
  const predicate = SHAPE_PREDICATES.find(entry => entry.id === 'graph.subject-directory-object-id')!;
  assert.equal(predicate.verification.state, 'CONTROL_COHORT_UNAVAILABLE');
});

test('every shape predicate records how it was checked', () => {
  for (const predicate of SHAPE_PREDICATES) {
    const { verification } = predicate;
    if (verification.state === 'PENDING_DISTRIBUTION_CHECK') {
      assert.ok(verification.controlCohort.length > 20, `${predicate.id} has no control cohort`);
    } else if (verification.state === 'PRODUCTION_VERIFIED') {
      assert.ok(verification.control.length > 20, `${predicate.id} records no control result`);
      assert.ok(verification.evidence.length > 20, `${predicate.id} has no evidence`);
    } else if (verification.state === 'CONTROL_COHORT_UNAVAILABLE') {
      assert.ok(verification.why.length > 20, `${predicate.id} does not say why the control is unavailable`);
    } else {
      assert.ok(verification.evidence.length > 20, `${predicate.id} has no evidence`);
    }
  }
});

// ---------------------------------------------------------------------------
// Graph result-code shape.
// ---------------------------------------------------------------------------

test('the Graph result code must be a number, and drift is reported not coerced', async () => {
  const batch = await run([
    graphRow({ id: 'number', status: { errorCode: 50126 } }),
    graphRow({ id: 'string', status: { errorCode: '50126' } }),
    graphRow({ id: 'junk', status: { errorCode: 'fifty-thousand' } }),
    graphRow({ id: 'null', status: { errorCode: null } }),
    graphRow({ id: 'absent', status: {} }),
  ]);

  assert.deepEqual(batch.shapeObservations.graphErrorCodeShape, {
    NUMBER: 1, NUMERIC_STRING: 1, OTHER_STRING: 1, NULL: 1, ABSENT: 1, OTHER_TYPE: 0,
  });
  const classificationOf = (eventId: string) => batch.events.find(event => event.eventId === eventId)!.classification;
  assert.deepEqual(classificationOf('number'), { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  // Confirmed number on 100% of 2,635 rows, so a string is drift. Counted and
  // routed to UNKNOWN rather than coerced into a verdict.
  assert.deepEqual(classificationOf('string'), { kind: 'UNKNOWN', observation: 'ERROR_CODE_SHAPE_UNRECOGNIZED' });
  assert.deepEqual(classificationOf('junk'), { kind: 'UNKNOWN', observation: 'ERROR_CODE_SHAPE_UNRECOGNIZED' });
  assert.deepEqual(classificationOf('null'), { kind: 'UNKNOWN', observation: 'ERROR_CODE_ABSENT' });
  assert.deepEqual(classificationOf('absent'), { kind: 'UNKNOWN', observation: 'ERROR_CODE_ABSENT' });
});

test('the isInteractive control cohort is reported separately', async () => {
  const batch = await run([
    graphRow({ id: 'failure-a', isInteractive: true, status: { errorCode: 50126 } }),
    graphRow({ id: 'failure-b', isInteractive: false, status: { errorCode: 50126 } }),
    graphRow({ id: 'other', isInteractive: true, status: { errorCode: 4242 } }),
  ]);
  assert.deepEqual(batch.shapeObservations.graphIsInteractiveAmongCredentialFailures, {
    TRUE: 1, FALSE: 1, NULL: 0, ABSENT: 0, OTHER_TYPE: 0,
  });
  assert.deepEqual(batch.shapeObservations.graphIsInteractive, {
    TRUE: 2, FALSE: 1, NULL: 0, ABSENT: 0, OTHER_TYPE: 0,
  });
});

test('a Graph success carries "Other." and an unrecognized description is not a success', async () => {
  // Verified: on the Graph path errorCode 0 carries "Other." on 100% of rows.
  // The predecessor treated "Other." as a failure reason and demoted real
  // successes to UNKNOWN.
  const other = await run([graphRow({ status: { errorCode: 0, failureReason: 'Other.' } })]);
  assert.deepEqual(only(other).classification, { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_COMPLETED' });

  const empty = await run([graphRow({ status: { errorCode: 0, failureReason: '' } })]);
  assert.deepEqual(only(empty).classification, { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_COMPLETED' });

  const strange = await run([graphRow({ status: { errorCode: 0, failureReason: 'Something never seen' } })]);
  assert.deepEqual(only(strange).classification, {
    kind: 'UNKNOWN',
    observation: 'SUCCESS_WITH_UNRECOGNIZED_FAILURE_REASON',
  });
});

test('error code 1 is HawkView’s own invention and gets no Microsoft code logic', async () => {
  const batch = await run([graphRow({ status: { errorCode: 1, failureReason: 'Other.' } })]);
  assert.deepEqual(only(batch).classification, {
    kind: 'UNKNOWN',
    observation: 'HAWKVIEW_SYNTHETIC_ERROR_CODE',
  });
});

test('no code is mapped to a credential verdict by accident, and codes are unique', () => {
  assert.deepEqual(dispositionForCode(123456), { kind: 'UNKNOWN', observation: 'UNRECOGNIZED_ERROR_CODE' });
  assert.equal(new Set(RESULT_CODES.map(entry => entry.code)).size, RESULT_CODES.length);
  const rejected = RESULT_CODES.filter(
    entry => entry.disposition.kind === 'APPLIES' && entry.disposition.outcome === 'PASSWORD_REJECTED',
  );
  assert.deepEqual(rejected.map(entry => entry.code), [50126]);
});

// ---------------------------------------------------------------------------
// Subject binding: exact object id on Graph, exact normalized UPN on audit.
// ---------------------------------------------------------------------------

test('Graph binds on the directory object id and records the method', async () => {
  const batch = await run([graphRow({ userId: USER_ID.toUpperCase() })]);
  const event = only(batch);
  assert.equal(event.subjectBinding, 'DIRECTORY_OBJECT_ID');
  assert.equal(event.subjectRef, 'hvr1_subject_ref1');
  assert.equal(event.applicationRef, 'hvr1_application_ref2');
  assert.deepEqual(batch.resolvedSubjects, [
    { subjectRef: 'hvr1_subject_ref1', microsoftUserId: USER_ID, binding: 'DIRECTORY_OBJECT_ID' },
  ]);
  assert.deepEqual(batch.counts.bindingMethods, { DIRECTORY_OBJECT_ID: 1, NORMALIZED_UPN: 0 });
  // Raw identifiers never travel on the event.
  assert.equal(JSON.stringify(event).includes(USER_ID.toLowerCase()), false);
  assert.equal(JSON.stringify(event).includes(APP_ID.toLowerCase()), false);
});

test('a user principal name in the Graph subject field never binds', async () => {
  const batch = await run([graphRow({ userId: 'ann@example.com' })]);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_ID_ABSENT_OR_MALFORMED, 1);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_NOT_IN_DIRECTORY, 0);
});

test('a well-formed object id absent from the directory does not bind to anyone', async () => {
  // Synthetic, and stated as such: zero production rows carry this shape, so
  // the control cohort for this path does not exist in observed data.
  const batch = await run([graphRow({ userId: OTHER_USER_ID })]);
  assert.equal(batch.events.length, 0);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_NOT_IN_DIRECTORY, 1);
});

test('the audit feed binds on an exact normalized UPN and records the weaker method', async () => {
  // GUID-only binding takes this feed from ~97% resolution to ~0%, which would
  // leave two of three tenants detecting nothing.
  const batch = await run([auditRow({ UserId: '  Ann@Example.COM ' })], { source: 'M365_AUDIT_STS' });
  const event = only(batch);
  assert.equal(event.subjectBinding, 'NORMALIZED_UPN');
  assert.deepEqual(event.classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
  assert.deepEqual(batch.counts.bindingMethods, { DIRECTORY_OBJECT_ID: 0, NORMALIZED_UPN: 1 });
  assert.deepEqual(batch.resolvedSubjects, [
    { subjectRef: 'hvr1_subject_ref1', microsoftUserId: USER_ID, binding: 'NORMALIZED_UPN' },
  ]);
});

test('an ambiguous UPN goes unprocessable rather than picking a best match', async () => {
  // The real hazard was never naming, it was ambiguity.
  const batch = await run([auditRow()], {
    source: 'M365_AUDIT_STS',
    directory: [DIRECTORY[0]!, { ...DIRECTORY[0]!, microsoftUserId: OTHER_USER_ID }],
  });
  assert.equal(batch.events.length, 0);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_UPN_AMBIGUOUS_IN_DIRECTORY, 1);
});

test('an unmatched or malformed audit UPN is named, not guessed at', async () => {
  const missing = await run([auditRow({ UserId: 'nobody@example.com' })], { source: 'M365_AUDIT_STS' });
  assert.equal(missing.counts.unprocessableByReason.SUBJECT_UPN_NOT_IN_DIRECTORY, 1);

  for (const value of ['ann', '', 'ann@', '@example.com', 'ann example.com']) {
    const batch = await run([auditRow({ UserId: value })], { source: 'M365_AUDIT_STS' });
    assert.equal(
      batch.counts.unprocessableByReason.SUBJECT_UPN_ABSENT_OR_MALFORMED,
      1,
      `expected malformed for ${JSON.stringify(value)}`,
    );
  }
});

test('the audit feed never binds from a GUID, including the synthesized column value', async () => {
  // The user_id COLUMN is GUID-shaped on nearly every row, matches no
  // directory user, and is more granular than the real user.
  const batch = await run([auditRow({ UserId: USER_ID })], { source: 'M365_AUDIT_STS' });
  assert.equal(batch.events.length, 0);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_UPN_ABSENT_OR_MALFORMED, 1);
});

test('an ambiguous object id does not bind', async () => {
  const batch = await run([graphRow()], {
    directory: [DIRECTORY[0]!, { ...DIRECTORY[0]!, userPrincipalName: 'ann.other@example.com' }],
  });
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_AMBIGUOUS_IN_DIRECTORY, 1);
});

test('a user with an unexpected userType is still bound', async () => {
  const batch = await run([graphRow()], { directory: [{ ...DIRECTORY[0]!, userType: null }] });
  assert.equal(batch.counts.applies, 1);
});

test('a directory row from another tenant aborts the run rather than being counted', async () => {
  await assert.rejects(
    run([graphRow()], { directory: [{ ...DIRECTORY[0]!, customerTenantId: OTHER_USER_ID }] }),
    /DIRECTORY_SCOPE_MISMATCH/,
  );
});

// ---------------------------------------------------------------------------
// Audit outcome consistency.
// ---------------------------------------------------------------------------

test('the audit feed keys off operation and code together', async () => {
  const success = await run([auditRow({ Operation: 'UserLoggedIn', ErrorCode: '0' })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(success).classification, { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_COMPLETED' });

  const failure = await run([auditRow({ Operation: 'UserLoginFailed', ErrorCode: '50126' })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(failure).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });

  const mismatchedSuccess = await run([auditRow({ Operation: 'UserLoggedIn', ErrorCode: '50126' })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(mismatchedSuccess).classification, {
    kind: 'UNKNOWN',
    observation: 'INCONSISTENT_OPERATION_AND_CODE',
  });

  const mismatchedFailure = await run([auditRow({ Operation: 'UserLoginFailed', ErrorCode: '0' })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(mismatchedFailure).classification, {
    kind: 'UNKNOWN',
    observation: 'INCONSISTENT_OPERATION_AND_CODE',
  });
});

test('an audit success carrying a failure reason name is a contradiction, not a success', async () => {
  const batch = await run(
    [auditRow({ Operation: 'UserLoggedIn', ErrorCode: '0', LogonError: 'InvalidUserNameOrPassword' })],
    { source: 'M365_AUDIT_STS' },
  );
  assert.deepEqual(only(batch).classification, {
    kind: 'UNKNOWN',
    observation: 'INCONSISTENT_OPERATION_AND_CODE',
  });
});

test('audit codes must agree wherever they appear', async () => {
  const agreeing = await run([auditRow({
    ErrorCode: '50126',
    ExtendedProperties: [{ Name: 'ErrorNumber', Value: '50126' }],
  })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(agreeing).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });

  const disagreeing = await run([auditRow({
    ErrorCode: '50126',
    ExtendedProperties: [{ Name: 'ErrorNumber', Value: '50074' }],
  })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(disagreeing).classification, {
    kind: 'UNKNOWN',
    observation: 'ERROR_CODE_SHAPE_UNRECOGNIZED',
  });
});

test('an audit record that is not a sign-in operation is named, not classified', async () => {
  const wrongType = await run([auditRow({ RecordType: 8 })], { source: 'M365_AUDIT_STS' });
  assert.equal(wrongType.counts.unprocessableByReason.UNSUPPORTED_AUDIT_OPERATION, 1);

  const wrongOperation = await run([auditRow({ Operation: 'MailboxLogin' })], { source: 'M365_AUDIT_STS' });
  assert.equal(wrongOperation.counts.unprocessableByReason.UNSUPPORTED_AUDIT_OPERATION, 1);

  const wrongTenant = await run([auditRow({ OrganizationId: OTHER_USER_ID })], { source: 'M365_AUDIT_STS' });
  assert.equal(wrongTenant.counts.unprocessableByReason.TENANT_BINDING_MISMATCH, 1);
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
    assert.equal(total(batch.counts.doesNotApplyByReason), 0);
    assert.equal(total(batch.counts.unknownByObservation), 0);
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
  const auditFallback = await run([auditRow({ ClientIP: undefined, ActorIpAddress: '198.51.100.7' })], {
    source: 'M365_AUDIT_STS',
  });
  assert.deepEqual(only(auditFallback).clientSource, { qualification: 'QUALIFIED', address: '198.51.100.7' });
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

test('a code’s description text can only mean what that code declares', async () => {
  // Matching every fragment against every code would let one code's phrasing
  // be read as another code's meaning. 50131 declares only the two risk
  // meanings, so lockout wording cannot turn it into a lockout.
  const lockoutWording = await run([graphRow({ status: {
    errorCode: 50131,
    failureReason: 'You’ve tried to sign in too many times with an incorrect user ID or password.',
  } })]);
  assert.deepEqual(only(lockoutWording).classification, { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' });

  const entry = resultCodeEntry(50131)!;
  assert.deepEqual(entry.textMeanings, ['SUSPICIOUS_ACTIVITY_BLOCK', 'HIGH_CONFIDENCE_RISK_BLOCK']);
  assert.deepEqual(resultCodeEntry(50053)!.textMeanings, [
    'SMART_LOCKOUT', 'MALICIOUS_IP_BLOCK', 'HIGH_CONFIDENCE_RISK_BLOCK',
  ]);
  // A code with no declared text meanings is never refined by text at all.
  assert.equal(resultCodeEntry(50126)!.textMeanings, undefined);
});

test('50131’s suspicious-activity variant is Microsoft’s judgement, not our finding', async () => {
  const suspicious = await run([graphRow({ status: {
    errorCode: 50131,
    failureReason: 'Request blocked due to suspicious activity.',
  } })]);
  assert.deepEqual(only(suspicious).classification, {
    kind: 'DOES_NOT_APPLY',
    reason: 'MICROSOFT_RISK_VERDICT',
  });
  assert.deepEqual(suspicious.microsoftRiskVerdicts.map(event => event.eventId), ['evt-1']);
  assert.equal(suspicious.applies.length, 0);

  // A plain Conditional Access failure is the tenant's own control working,
  // which is ours to report.
  const plain = await run([graphRow({ status: { errorCode: 50131, failureReason: 'Access denied.' } })]);
  assert.deepEqual(only(plain).classification, { kind: 'APPLIES', outcome: 'BLOCKED_BY_CONTROL' });
});

test('the enumeration blind spot is counted, not left as a comment', async () => {
  // 50034 and 51004 describe a subject that is by definition absent from the
  // directory, so subject resolution discards the row before classification
  // and the code is lost. The count is what keeps that visible.
  const batch = await run([
    graphRow({ id: 'probe-a', userId: OTHER_USER_ID, status: { errorCode: 50034 } }),
    graphRow({ id: 'probe-b', userId: OTHER_USER_ID, status: { errorCode: 51004 } }),
    graphRow({ id: 'ordinary-miss', userId: OTHER_USER_ID, status: { errorCode: 50126 } }),
    graphRow({ id: 'resolves' }),
  ]);

  assert.equal(batch.shapeObservations.enumerationCodesOnUnresolvedSubjects, 2);
  assert.equal(batch.counts.unprocessableByReason.SUBJECT_NOT_IN_DIRECTORY, 3);
  assert.equal(batch.counts.applies, 1, 'the resolvable row is unaffected');
});

test('coverage cannot be read without knowing what was requested', async () => {
  // Coverage is a share of what was COLLECTED. Without the requested scope
  // beside it, a full-coverage number is compatible with never having asked
  // for most of the tenant's traffic — true, and misleading.
  const batch = await run([graphRow()]);
  assert.equal(batch.coverage.collectionScope, 'GRAPH_INTERACTIVE_ONLY');
  assert.equal(batch.coverage.consideredRows, 1);
  assert.equal(batch.coverage.recognizedRows, 1);

  const undeclared = await run([graphRow()], { collectionScope: 'UNDECLARED' });
  assert.equal(undeclared.coverage.collectionScope, 'UNDECLARED');

  const audit = await run([auditRow()], { source: 'M365_AUDIT_STS' });
  assert.equal(audit.coverage.collectionScope, 'AUDIT_STS_LOGON_EVENTS');
});

test('every collection scope has a label, and the partial ones say what is missing', () => {
  const scopes = (Object.keys(COLLECTION_SCOPE_LABELS) as CollectionScope[]).sort();
  assert.deepEqual(scopes, [
    'AUDIT_STS_LOGON_EVENTS',
    'GRAPH_INTERACTIVE_AND_NON_INTERACTIVE',
    'GRAPH_INTERACTIVE_ONLY',
    'UNDECLARED',
  ]);
  for (const scope of scopes) assert.ok(describeCollectionScope(scope).length > 20, scope);
  // The two scopes that mean "you are not seeing everything" have to say so,
  // or the field is decoration.
  assert.match(describeCollectionScope('GRAPH_INTERACTIVE_ONLY'), /not requested|outside this assessment/i);
  assert.match(describeCollectionScope('UNDECLARED'), /cannot state/i);
});

// ---------------------------------------------------------------------------
// The two 50053 literals, byte-exact as measured from production rows.
// This is the highest-volume predicate in the layer: 50053 is ~56% of all
// collected Graph rows, so if these fragments stop matching, most of the
// traffic silently costs coverage.
// ---------------------------------------------------------------------------

// Double-quoted deliberately: the lockout literal contains an ASCII apostrophe
// (0x27, NOT a Unicode right single quote), and that is exactly the class of
// difference that survives a paste and fails a comparison.
const MALICIOUS_IP_LITERAL = "Sign-in was blocked because it came from an IP address with malicious activity";
const LOCKOUT_LITERAL = "The account is locked, you've tried to sign in too many times with an incorrect user ID or password.";

test('the measured 50053 literals are byte-exact in this test', () => {
  // If these drift, the assertions below stop testing what they claim to.
  assert.equal(MALICIOUS_IP_LITERAL.length, 78);
  assert.equal(Buffer.byteLength(MALICIOUS_IP_LITERAL, 'utf8'), 78, 'must be pure ASCII');
  assert.equal(MALICIOUS_IP_LITERAL.at(-1), 'y', 'no trailing period on this one');

  assert.equal(LOCKOUT_LITERAL.length, 100);
  assert.equal(Buffer.byteLength(LOCKOUT_LITERAL, 'utf8'), 100, 'must be pure ASCII');
  assert.equal(LOCKOUT_LITERAL.at(-1), '.', 'trailing period IS present on this one');
  assert.ok(LOCKOUT_LITERAL.includes(String.fromCharCode(0x27)), 'apostrophe must be ASCII 0x27');
});

test('each measured literal resolves to exactly its own meaning', async () => {
  const malicious = await run([graphRow({ status: { errorCode: 50053, failureReason: MALICIOUS_IP_LITERAL } })]);
  assert.deepEqual(only(malicious).classification, {
    kind: 'DOES_NOT_APPLY',
    reason: 'MICROSOFT_RISK_VERDICT',
  });

  const lockout = await run([graphRow({ status: { errorCode: 50053, failureReason: LOCKOUT_LITERAL } })]);
  assert.deepEqual(only(lockout).classification, {
    kind: 'APPLIES',
    outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
  });

  // Control: each literal matches ONE fragment set and not the other, and
  // neither reaches the risk-verdict branch that has no production evidence.
  assert.equal(failureReasonMeaning(MALICIOUS_IP_LITERAL)?.meaning, 'MALICIOUS_IP_BLOCK');
  assert.equal(failureReasonMeaning(LOCKOUT_LITERAL)?.meaning, 'SMART_LOCKOUT');
  for (const literal of [MALICIOUS_IP_LITERAL, LOCKOUT_LITERAL]) {
    assert.notEqual(failureReasonMeaning(literal)?.meaning, 'HIGH_CONFIDENCE_RISK_BLOCK');
    assert.notEqual(failureReasonMeaning(literal)?.meaning, 'SUSPICIOUS_ACTIVITY_BLOCK');
  }
});

// ---------------------------------------------------------------------------
// The audit feed keys on the reason NAME, because its code is unreliable.
// ---------------------------------------------------------------------------

test('the same audit reason name classifies the same way under either code', async () => {
  // Measured across two tenants: InvalidUserNameOrPassword appears with
  // errorCode "1" AND with the code absent. Same event, same meaning. A
  // classifier keyed on the code drops half of them, invisibly.
  const withSyntheticCode = await run([auditRow({ ErrorCode: '1', LogonError: 'InvalidUserNameOrPassword' })], {
    source: 'M365_AUDIT_STS',
  });
  const withNoCode = await run([auditRow({ ErrorCode: undefined, LogonError: 'InvalidUserNameOrPassword' })], {
    source: 'M365_AUDIT_STS',
  });

  const expected = { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' };
  assert.deepEqual(only(withSyntheticCode).classification, expected);
  assert.deepEqual(only(withNoCode).classification, expected, 'an absent code must not change the meaning');
  assert.equal(withSyntheticCode.counts.applies, 1);
  assert.equal(withNoCode.counts.applies, 1);
});

test('the audit reason name disambiguates what the code cannot', async () => {
  // On Graph, 50053 needs text parsing for its three meanings. On audit the
  // name IS the lockout meaning, so no ambiguity arises.
  const batch = await run([auditRow({ ErrorCode: '1', LogonError: 'IdsLocked' })], { source: 'M365_AUDIT_STS' });
  assert.deepEqual(only(batch).classification, {
    kind: 'APPLIES',
    outcome: 'LOCKED_OUT_AFTER_REPEATED_FAILURES',
  });
});

test('audit reason names map to the same outcomes as their Graph codes', async () => {
  const challenge = await run(
    [auditRow({ ErrorCode: '1', LogonError: 'UserStrongAuthClientAuthNRequiredInterrupt' })],
    { source: 'M365_AUDIT_STS' },
  );
  assert.deepEqual(only(challenge).classification, {
    kind: 'APPLIES',
    outcome: 'PASSWORD_ACCEPTED_CHALLENGE_ISSUED',
  });
  assert.deepEqual(dispositionForCode(50076), only(challenge).classification);
});

test('an audit reason Microsoft calls unclassified is unknown, and an unlisted one is named as such', async () => {
  const unclassified = await run(
    [auditRow({ ErrorCode: undefined, LogonError: 'UnclassifiedAuthenticationError' })],
    { source: 'M365_AUDIT_STS' },
  );
  assert.deepEqual(only(unclassified).classification, {
    kind: 'UNKNOWN',
    observation: 'PROVIDER_DECLARED_UNCLASSIFIED',
  });

  // 'UserLoggedIn' appears as a reason VALUE with no code — the operation name
  // leaking into the error field. Deliberately unmapped: reading a success out
  // of an artefact would be a guess.
  const leaked = await run([auditRow({ ErrorCode: undefined, LogonError: 'UserLoggedIn' })], {
    source: 'M365_AUDIT_STS',
  });
  assert.deepEqual(only(leaked).classification, {
    kind: 'UNKNOWN',
    observation: 'UNRECOGNIZED_REASON_NAME',
  });
  assert.deepEqual(AUDIT_REASON_NAMES_OBSERVED_UNMAPPED.map(entry => entry.name), ['UserLoggedIn']);
  for (const entry of AUDIT_REASON_NAMES_OBSERVED_UNMAPPED) assert.ok(entry.why.length > 40, entry.name);
});

test('an audit reason with no exclusion citation is held, not claimed', async () => {
  for (const name of ['UserUnauthorized', 'DelegationDoesNotExist', 'InvalidReplyTo',
    'MisconfiguredApplicationWithGraphErrorMessage', 'PasswordResetRegistrationRequiredInterrupt']) {
    const batch = await run([auditRow({ ErrorCode: '1', LogonError: name })], { source: 'M365_AUDIT_STS' });
    assert.deepEqual(
      only(batch).classification,
      { kind: 'NOT_YET_CITED', reason: 'EXCLUSION_NOT_YET_CITED' },
      name,
    );
  }
});

test('audit reason names match case-insensitively and are trimmed', () => {
  assert.equal(auditReasonEntry('  invalidusernameorpassword ')?.name, 'InvalidUserNameOrPassword');
  assert.equal(auditReasonEntry('IdsLocked')?.name, 'IdsLocked');
  assert.equal(auditReasonEntry('NoSuchReason'), undefined);
  assert.equal(new Set(AUDIT_REASON_NAMES.map(entry => entry.name.toLowerCase())).size, AUDIT_REASON_NAMES.length);
});

test('the audit code corroborates and never overrides the reason name', async () => {
  // A real Microsoft code disagreeing with the name is a contradiction, not a
  // vote to be won by whichever field we looked at first.
  const contradiction = await run(
    [auditRow({ ErrorCode: '50076', LogonError: 'InvalidUserNameOrPassword' })],
    { source: 'M365_AUDIT_STS' },
  );
  assert.deepEqual(only(contradiction).classification, {
    kind: 'UNKNOWN',
    observation: 'INCONSISTENT_OPERATION_AND_CODE',
  });

  // But HawkView's own synthetic "1" carries no provider information at all,
  // so it never contradicts anything.
  const synthetic = await run([auditRow({ ErrorCode: '1', LogonError: 'InvalidUserNameOrPassword' })], {
    source: 'M365_AUDIT_STS',
  });
  assert.deepEqual(only(synthetic).classification, { kind: 'APPLIES', outcome: 'PASSWORD_REJECTED' });
});

test('53004 is in Microsoft’s channel and shows up in that list', async () => {
  const batch = await run([graphRow({ status: { errorCode: 53004 } })]);
  assert.deepEqual(only(batch).classification, { kind: 'DOES_NOT_APPLY', reason: 'MICROSOFT_RISK_VERDICT' });
  assert.deepEqual(batch.microsoftRiskVerdicts.map(event => event.eventId), ['evt-1']);
  assert.equal(batch.applies.length, 0);
  assert.equal(batch.counts.doesNotApplyByReason.MICROSOFT_RISK_VERDICT, 1);
});

// ---------------------------------------------------------------------------
// Observation versus anticipation, and the two Microsoft verdict kinds.
// ---------------------------------------------------------------------------

test('every mapped code declares whether we have actually seen it', () => {
  // Two mistakes in this workstream were sound readings of Microsoft's
  // documentation for events we have never once seen: the third 50053 text
  // variant, and code 53004. The marker is what keeps anticipation from
  // reading as a working path.
  assert.equal(OBSERVED_GRAPH_ERROR_CODES.length, 14);
  for (const entry of RESULT_CODES) {
    const observed = OBSERVED_GRAPH_ERROR_CODES.includes(entry.code);
    assert.equal(
      entry.graphObservation,
      observed ? 'OBSERVED' : 'NOT_OBSERVED',
      `code ${entry.code} claims ${entry.graphObservation}`,
    );
  }
  const seen = RESULT_CODES.filter(entry => entry.graphObservation === 'OBSERVED');
  assert.equal(seen.length, 9, 'nine of the fourteen observed codes are mapped');
});

test('observed codes we do not map are recorded, and cost coverage rather than being invented', async () => {
  // The reverse problem from an anticipated mapping: real rows with no
  // mapping. Mapping them from a half-remembered meaning is the error this
  // module exists to prevent, so they stay unrecognized and visible.
  assert.deepEqual([...OBSERVED_BUT_UNMAPPED_GRAPH_CODES], [16003, 50011, 50020, 70044, 90094]);
  for (const code of OBSERVED_BUT_UNMAPPED_GRAPH_CODES) {
    const batch = await run([graphRow({ status: { errorCode: code } })]);
    assert.deepEqual(
      only(batch).classification,
      { kind: 'UNKNOWN', observation: 'UNRECOGNIZED_ERROR_CODE' },
      `code ${code}`,
    );
  }
});

test('53004 stays in Microsoft’s channel but is marked as never observed', () => {
  const entry = resultCodeEntry(53004)!;
  assert.deepEqual(entry.disposition, { kind: 'DOES_NOT_APPLY', reason: 'MICROSOFT_RISK_VERDICT' });
  assert.equal(entry.graphObservation, 'NOT_OBSERVED');
  assert.match(entry.note ?? '', /NO PRODUCTION EVIDENCE/);
  assert.ok((entry.exclusionCitation ?? '').length > 15);
});

test('a Microsoft risk verdict and a Microsoft safety verdict can never be the same thing', async () => {
  // Microsoft's channel carries both. A safety verdict rendered in a "risky
  // users" view would say "this user is at risk" when Microsoft said the
  // opposite, so the two are separate lists rather than one list and a flag.
  const batch = await run([
    graphRow({ id: 'risky', status: { errorCode: 53004 } }),
    graphRow({ id: 'ordinary', status: { errorCode: 50126 } }),
  ]);
  assert.deepEqual(batch.microsoftRiskVerdicts.map(event => event.eventId), ['risky']);
  const riskIds = new Set(batch.microsoftRiskVerdicts.map(event => event.eventId));
  for (const event of batch.microsoftSafetyVerdicts) {
    assert.equal(riskIds.has(event.eventId), false, 'an event must never be in both lists');
  }
  // Asserted last: node:assert narrows the type, which would make the loop above vacuous.
  assert.equal(batch.microsoftSafetyVerdicts.length, 0, 'unreachable until riskDetail has a control cohort');
  assert.equal(batch.counts.doesNotApplyByReason.MICROSOFT_SAFETY_VERDICT, 0);
});

test('riskDetail has no control cohort yet, so it changes nothing', async () => {
  // 55 measured rows carry a riskDetail alongside a Conditional Access
  // success, and they currently classify as ordinary successes. Routing them
  // on an unconfirmed field would remove 55 real successes from evaluation if
  // the field means something other than we think.
  assert.equal(mayExclude('graph.risk-detail'), false);

  const withRiskDetail = await run([graphRow({
    riskDetail: 'userPassedMFADrivenByRiskBasedPolicy',
    conditionalAccessStatus: 'success',
    status: { errorCode: 0, failureReason: 'Other.' },
  })]);
  const withSafeDetail = await run([graphRow({
    riskDetail: 'aiConfirmedSigninSafe',
    conditionalAccessStatus: 'success',
    status: { errorCode: 0, failureReason: 'Other.' },
  })]);
  const without = await run([graphRow({ status: { errorCode: 0, failureReason: 'Other.' } })]);

  const expected = { kind: 'APPLIES', outcome: 'PASSWORD_ACCEPTED_COMPLETED' };
  assert.deepEqual(only(withRiskDetail).classification, expected);
  assert.deepEqual(only(withSafeDetail).classification, expected);
  assert.deepEqual(only(without).classification, expected);
  // And neither reaches Microsoft's channel on an unverified field.
  assert.deepEqual(withRiskDetail.microsoftRiskVerdicts, []);
  assert.deepEqual(withSafeDetail.microsoftSafetyVerdicts, []);
});
