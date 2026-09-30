// TEMPORARY MEASUREMENT, not a test to keep. Drives the mounted section with a
// GENUINE native-shaped unavailable assessment -- nativeView: null, which is
// exactly what useNativeRiskyUsersRead yields when the assessment is
// unavailable -- and prints what the surface actually renders.
//
// This exists to convert one traced claim into an executed one: that
// nativeRiskyUserCount and nativeRiskyUserList branch on the identical
// condition, so "Users requiring review: Not available" and a derived
// "0 detected by HawkView" are guaranteed to co-occur rather than merely
// co-reachable. It supplies the REAL hook contract, not the legacy one the
// existing harness substitutes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as adapter from './adapter.ts'
import { adaptNativeAssessment } from './native-assessment.ts'
import * as presentation from './presentation.ts'
import * as riskyUsersView from './risky-users-view.ts'
import { syntheticRiskResponses, unavailableMeta } from './test-fixtures.ts'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const ts = require('typescript')

function compile(path: string, mocks: Record<string, unknown>) {
  const exports: Record<string, unknown> = {}
  const compiled = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText
  new Function('require', 'exports', compiled)(
    (name: string) => mocks[name] ?? require(name),
    exports
  )
  return exports
}

const microsoftView = adapter.adaptMicrosoftRiskyUsersResponse({
  ...syntheticRiskResponses().microsoftRiskyUsers,
  ...unavailableMeta(
    'Microsoft Entra risky-user evidence is not available on this tenant.'
  ),
  reasonCode: 'LICENSE_REQUIRED',
})

const uiMocks: Record<string, unknown> = {
  '@/lib/identity-risk/presentation': presentation,
  '@/lib/identity-risk/risky-users-view': riskyUsersView,
  '@/lib/identity-risk/microsoft-risk-summary': require('./microsoft-risk-summary.ts'),
  '@/lib/identity-risk/native-view': require('./native-view.ts'),
  '@/lib/identity-risk/risk-presentation-mapper': require('./risk-presentation-mapper.ts'),
  '@/lib/api/hooks': {
    useTenantOperationalProjection: () => ({
      tenant: { name: 'Synthetic Tenant', defaultDomainName: 'synthetic.com' },
    }),
  },
  '@/lib/utils': { cn: (...v: unknown[]) => v.filter(Boolean).join(' ') },
  '@/components/ui/input': { Input: (p: any) => React.createElement('input', p) },
  '@/components/ui/tooltip': {
    TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
    Tooltip: ({ children }: any) => React.createElement('div', null, children),
    TooltipTrigger: ({ children }: any) => React.createElement('div', null, children),
    TooltipContent: ({ children }: any) => React.createElement('div', null, children),
  },
  '@/components/ui/table': {
    Table: ({ children, ...p }: any) => React.createElement('table', p, children),
    TableHeader: ({ children, ...p }: any) => React.createElement('thead', p, children),
    TableBody: ({ children, ...p }: any) => React.createElement('tbody', p, children),
    TableRow: ({ children, ...p }: any) => React.createElement('tr', p, children),
    TableHead: ({ children, ...p }: any) => React.createElement('th', p, children),
    TableCell: ({ children, ...p }: any) => React.createElement('td', p, children),
  },
  '@/components/ui/badge': {
    Badge: ({ variant: _v, ...p }: any) => React.createElement('span', p),
  },
  '@/components/ui/button': {
    Button: React.forwardRef(function B({ variant: _v, size: _s, ...p }: any, ref: any) {
      return React.createElement('button', { ...p, ref })
    }),
  },
}


/** One render of the real mounted section against a given hook state. */
function sectionFor(read: () => Record<string, unknown>) {
  const hooks = compile('../api/risky-users-hooks.ts', {
    ...uiMocks,
    './risky-users-assessment-hooks': {
      useNativeRiskyUsersRead: () => ({
        cacheScope: 'probe-session',
        assessmentLoading: false,
        assessmentRequestError: false,
        assessmentContractError: false,
        microsoftLoading: false,
        retryAssessment: () => undefined,
        retryMicrosoft: () => undefined,
        ...read(),
      }),
    },
  })

  const section = compile('../../components/identity-risk/risky-users-section.tsx', {
    ...uiMocks,
    '@/lib/api/risky-users-hooks': hooks,
    './risk-assessment-drawer': { RiskAssessmentDrawer: () => null },
    '@/components/identity-risk/fleet-risk-assessment-drawer': {
      FleetRiskAssessmentDrawer: () => null,
    },
  })

  return (section as any).default
}
function render(nativeView: unknown, microsoftView: unknown): string {
  const Section = sectionFor(() => ({ nativeView, microsoftView }))
  const dom = new JSDOM(
    renderToStaticMarkup(
      React.createElement(Section, { tenantId: 'synthetic-tenant' })
    )
  )
  return ((dom.window.document.body.textContent ?? '') as string).replace(/\s+/g, ' ')
}

/** An assessment that RAN, covered its scope, and found nobody. The honest zero. */
const assessedAndEmpty = {
  available: true,
  run: {
    windowStart: '2026-09-12T09:00:00.000Z',
    windowEnd: '2026-09-13T09:00:00.000Z',
    completedAt: '2026-09-13T09:00:00.000Z',
  },
  collectors: [],
  coverage: [],
  subjectsNamed: true,
  count: {
    accuracy: 'EXACT',
    value: 0,
    covered: ['HV-ID-AUTH-005'],
    notCovered: [],
    evidenceRequested: ['SIGN_INS'],
  },
  withheld: [],
  findings: [],
  complete: true,
}

test('AN UNAVAILABLE ASSESSMENT ASSERTS NO EMPTINESS, IN ANY VOICE', () => {
  // **THIS FILE ARRIVED ASSERTING THE DEFECT.** Its assertions were
  // `match(/Not available/)` and `match(/0 detected by HawkView/)`, so it passed while the bug
  // existed — a test pinning the wrong outcome as the specification. Run unmodified against the
  // repaired component it failed on the second assertion, which is how the repair was confirmed
  // before these assertions were written.
  //
  // The measured render was three derived zeroes — "0 detected by HawkView", "0 active Microsoft
  // risk", "Showing 0 of 0 users" — beside a count whose own caption says this is not a zero and
  // not an all-clear. **The surface asserted emptiness in three voices while saying it could not
  // tell.** Live for the two organisations with no collection configured.
  const text = render(null, microsoftView)

  assert.match(text, /HawkView count: Not available/, 'the count still says it cannot tell')

  // EVERY VOICE, NAMED SEPARATELY. One assertion over the whole string would go green the moment
  // somebody reworded a line, and these are three independent sites that were fixed separately.
  //
  // **NO `\b` ANCHORS, AND THAT IS NOT A STYLE CHOICE.** The rendered text runs together without
  // spaces — `...Not available0 detected by HawkView` — so a leading `\b` has no boundary to match
  // and the assertion can never fire. Both of these were written with one and **survived a revert
  // of the code they were checking**; only the footer assertion, which had no anchor, caught its
  // revert. A negative regex passes by missing, and a negative regex is the whole of this test.
  assert.doesNotMatch(text, /0 detected by HawkView/, 'the HawkView zero')
  assert.doesNotMatch(text, /0 active Microsoft risk/, 'the Microsoft zero')
  assert.doesNotMatch(text, /Showing 0 of 0/, 'the footer zero')
  assert.doesNotMatch(text, /No users requiring review found/, 'the table zero')

  // And what it says instead is the disclosure, not merely the absence of a number.
  assert.match(text, /not a zero and it is not an all-clear/)
})

test('POSITIVE CONTROL: AN ASSESSED, EMPTY TENANT STILL RENDERS ITS ZERO', () => {
  // **WITHOUT THIS THE FIX IS INDISTINGUISHABLE FROM DELETING THE NUMBERS.** `nativeRiskyUserCount`
  // and `nativeRiskyUserList` branch on the IDENTICAL condition, so a fix keyed on that condition
  // would silence a tenant that genuinely has nobody — the opposite error, and the one this
  // product exists to prevent. The distinction has to come from `accuracy`, and this is the test
  // that proves it did.
  const text = render(assessedAndEmpty, microsoftView)

  assert.match(text, /HawkView: 0 users requiring review in this assessment/, 'an assessed empty tenant must still show its zero')
  assert.doesNotMatch(text, /HawkView count: Not available/, 'and must not read as unknown')
})

const badCopy=/Some Microsoft risk records could not be matched to HawkView identities/;
function source(reason:string|null=null,partial=false){
 const dto:any=syntheticRiskResponses().microsoftRiskyUsers;
 if(reason)Object.assign(dto,unavailableMeta('Synthetic source unavailable'),{reasonCode:reason});
 dto.microsoftRiskSummary={source:'MICROSOFT_IDENTITY_PROTECTION',availability:reason?'UNAVAILABLE':partial?'PARTIAL':'AVAILABLE',completeness:reason?'UNKNOWN':partial?'PARTIAL':'COMPLETE',rawRecordCount:reason?null:0,observedActiveDistinctUserCount:reason?null:0,activeDistinctUserCount:reason||partial?null:0,snapshotObservedAt:reason?null:dto.observedAt,collectionSucceededAt:reason?null:dto.observedAt,reasonCode:reason?'SOURCE_UNAVAILABLE':partial?'PARTIAL_RECORDS':null};
 return dto;
}
for(const [label,reason,partial] of [['generic unavailable','SOURCE_UNAVAILABLE',false],['license unavailable','LICENSE_REQUIRED',false],['partial records',null,true]] as const){
 test('source limitation does not invent a matching failure: '+label,()=>{
  const ms=adapter.adaptMicrosoftRiskyUsersResponse(source(reason,partial));
  assert.equal(ms.users?.length,0);assert.ok(ms.microsoftRiskSummary);assert.equal(ms.microsoftRiskSummary.availability,partial?'PARTIAL':'UNAVAILABLE');
  const html=render(assessedAndEmpty,ms);
  assert.match(html,/Microsoft/);
  assert.match(html, partial ? /Some Microsoft Identity Protection records could not be evaluated/ : reason === 'LICENSE_REQUIRED' ? /requires.*licen|requires Entra ID P2/i : /Microsoft Entra risk detection is unavailable/);
  assert.match(html, partial ? /Microsoft risk status incomplete/ : /Microsoft risk status unavailable/);
  const retained=render(nativePositive(),ms);
  assert.match(retained,/Synthetic user/);assert.match(retained,/HawkView: 1 users requiring review in this assessment/);
  assert.doesNotMatch(retained,badCopy);
  assert.doesNotMatch(html,badCopy,'No supplied records or directory-match attempt supports this matching-specific diagnosis');
 });
}
const key=(ref:string)=>({available:true as const,shape:'DIRECTORY_OBJECT_ID' as const,ref});
function nativePositive(){return {...assessedAndEmpty,count:{...assessedAndEmpty.count,value:1},findings:[{detectorId:'repeated-credential-failure',subject:{kind:'DIRECTORY_USER',ref:'native-1',displayName:'Synthetic user',userPrincipalName:'synthetic@example.invalid',correlation:key('key-a')},signals:[{signal:'PASSWORD_REJECTED',count:1,capped:false,latest:null}]}]};}
for(const match of [true,false])test('supplied comparable keys '+(match?'match':'differ'),()=>{
 const dto=source();dto.users=[{id:'ms-1',identityLabel:'Synthetic Microsoft user',riskLevel:'high',riskState:'atRisk',riskDetail:null,observedAt:dto.observedAt,correlation:key(match?'key-a':'key-b')}];
 Object.assign(dto.microsoftRiskSummary,{rawRecordCount:1,observedActiveDistinctUserCount:1,activeDistinctUserCount:1});
 const ms=adapter.adaptMicrosoftRiskyUsersResponse(dto);assert.equal(ms.users?.length,1);
 const native=nativePositive();const rows=require('./native-view.ts').nativeRiskyUserList(native,riskyUsersView.microsoftChannel(ms),ms.users).rows;
 assert.equal(rows[0].detection.microsoft,match?'REPORTED':'NOT_REPORTED');assert.equal(rows[0].detection.because,null);
 const html=render(native,ms);assert.doesNotMatch(html,badCopy);assert.match(html,/Synthetic user/);
});
test('absent Microsoft correlation is unprovided comparison, not a failed directory lookup',()=>{
 const dto=source();dto.users=[{id:'ms-1',identityLabel:'Synthetic Microsoft user',riskLevel:'high',riskState:'atRisk',riskDetail:null,observedAt:dto.observedAt}];
 Object.assign(dto.microsoftRiskSummary,{rawRecordCount:1,observedActiveDistinctUserCount:1,activeDistinctUserCount:1});
 const ms=adapter.adaptMicrosoftRiskyUsersResponse(dto);assert.equal(ms.users?.[0].correlation,null);
 const native=nativePositive();const rows=require('./native-view.ts').nativeRiskyUserList(native,riskyUsersView.microsoftChannel(ms),ms.users).rows;
 assert.equal(rows[0].detection.microsoft,'NOT_COMPARABLE');
 assert.match(rows[0].detection.because!, /lack usable comparison keys/);
 assert.doesNotMatch(rows[0].detection.because!, /could not be matched/);
 const html=render(native,ms);assert.match(html,/Cross-source comparison is not established/);assert.match(html,/Synthetic user/);assert.match(html,/HawkView: 1 users requiring review in this assessment/);assert.match(html,/1 active Microsoft risk identity/);assert.doesNotMatch(html,badCopy,'Absent comparison key is not proof a directory match failed');
});


test('missing native comparison evidence stays NOT_COMPARABLE without claiming a lookup failed', () => {
  const ms = adapter.adaptMicrosoftRiskyUsersResponse(source())
  const native = nativePositive()
  const detection = riskyUsersView.detectionFromCorrelation(null, riskyUsersView.microsoftChannel(ms), ms.users)
  assert.equal(detection.microsoft, 'NOT_COMPARABLE')
  assert.match(detection.because!, /Comparison evidence was not provided/)
  assert.doesNotMatch(detection.because!, /cannot be matched|could not be matched/)
  const html = render({ ...native, findings: native.findings.map((finding) => ({ ...finding, subject: { ...finding.subject, correlation: null } })) }, ms)
  assert.match(html, /Cross-source comparison is not established/)
  assert.match(html, /Synthetic user/)
})

test('explicit Microsoft error and stale source retain truthful warning copy and native positives', () => {
  const failed = source('COLLECTION_FAILED')
  failed.status = 'ERROR'
  const ms = adapter.adaptMicrosoftRiskyUsersResponse(failed)
  assert.equal(riskyUsersView.microsoftChannel(ms).state, 'INTERRUPTED')
  const text = render(nativePositive(), ms)
  assert.match(text, /Microsoft Entra risk detection could not be read/)
  assert.match(text, /Synthetic user/)
  assert.doesNotMatch(text, badCopy)
  const stale = source()
  stale.status = 'STALE'; stale.freshness = 'STALE'; stale.limitation = 'Retained evidence'
  const retained = adapter.adaptMicrosoftRiskyUsersResponse(stale)
  assert.equal(riskyUsersView.microsoftChannel(retained).state, 'INTERRUPTED')
  assert.match(render(nativePositive(), retained), /Microsoft Entra risk detection is out of date/)
})


function diagnosticNative(coverage: Record<string, unknown> = { applies: 10, unknown: { UNRECOGNIZED_ERROR_CODE: 1 }, unprocessable: {}, notYetCited: {} }) {
  const stamp = '2026-09-27T01:00:00.000Z'
  const dto = {
    version: 'hawkview-risky-users/v1', available: true, subjectsNamed: true,
    run: { windowStart: stamp, windowEnd: stamp, completedAt: stamp },
    collectors: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: stamp }],
    coverage: [{ stream: 'GRAPH_SIGN_INS', coverage }],
    count: { accuracy: 'AT_LEAST', value: 5, scope: { evidenceRequested: ['GRAPH_SIGN_INS'], covered: ['repeated-credential-failure'], notCovered: [] } },
    claim: { permitted: false, withheld: [{ stream: 'GRAPH_SIGN_INS', because: 'UNINTERPRETED_EVENTS' }] },
    findings: { complete: true, items: Array.from({ length: 5 }, (_, i) => ({ detectorId: 'repeated-credential-failure',
      subject: { kind: 'DIRECTORY_USER', userRef: `private-user-${i}`, correlation: { available: false, because: 'NOT_RESOLVED' } },
      displayName: `Private Person ${i}`, userPrincipalName: `private${i}@example.invalid`,
      signals: ['PASSWORD_REJECTED', 'LOCKED_OUT_AFTER_REPEATED_FAILURES'].map((signal) => ({ signal, count: 1, capped: false, latest: { at: stamp, kind: 'EVENT_OCCURRED' } })),
    })) },
  }
  const native = adaptNativeAssessment(dto)
  assert.ok(native?.available)
  return native
}
function diagnosticText(nativeView: unknown, ms: unknown, flags = {}) {
  const Section = sectionFor(() => ({ nativeView, microsoftView: ms, ...flags }))
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(Section, { tenantId: 'synthetic' })))
  const details = dom.window.document.querySelector('[data-evidence-details]')!
  assert.equal(details.hasAttribute('open'), false)
  const text = details.textContent!
  dom.window.close()
  return text
}

test('actual evidence disclosure shows real DTO category and source clocks without identity data or altered lower bounds', () => {
  const native = diagnosticNative()
  const ms = adapter.adaptMicrosoftRiskyUsersResponse(source(null, true))
  const text = diagnosticText(native, ms)
  assert.match(text, /UNRECOGNIZED_ERROR_CODE: 1/)
  assert.match(text, /Count accuracy: AT_LEAST; count value: 5/)
  assert.match(text, /UNINTERPRETED_EVENTS/)
  assert.match(text, /2026-09-27T01:00:00.000Z/)
  assert.match(text, /Collector status: SUCCESS/)
  assert.match(text, /summary reason: PARTIAL_RECORDS/)
  assert.match(text, /active identities: Not reported/)
  assert.doesNotMatch(text, /Private Person|private-user|@example.invalid|could not be matched|P2/)
  const list = require('./native-view.ts').nativeRiskyUserList(native, riskyUsersView.microsoftChannel(ms), ms.users)
  assert.equal(list.rows.length, 5)
  assert.equal(list.rows.reduce((n: number, row: any) => n + row.reasons.length, 0), 10)
  assert.match(render(native, ms), /at least 5/i)
})

test('diagnostics preserve Microsoft summary reasons, unknown clocks and complete zero without license inference', () => {
  for (const reason of ['PARTIAL_RECORDS', 'CONFLICTING_RECORDS']) {
    const dto = source(null, true)
    dto.microsoftRiskSummary.reasonCode = reason
    dto.microsoftRiskSummary.completeness = reason === 'PARTIAL_RECORDS' ? 'PARTIAL' : 'CONFLICTING'
    const ms = adapter.adaptMicrosoftRiskyUsersResponse(dto)
    assert.ok(ms.microsoftRiskSummary)
    assert.match(diagnosticText(null, ms), new RegExp('summary reason: ' + reason))
  }
  const missing = diagnosticText(null, adapter.adaptMicrosoftRiskyUsersResponse(source('SOURCE_UNAVAILABLE')))
  assert.match(missing, /Snapshot observed \(UTC\): Not reported/)
  assert.match(missing, /Raw record count: Not reported/)
  assert.doesNotMatch(missing, /LICENSE_REQUIRED|P2|unlicensed/)
  const zero = diagnosticText(null, adapter.adaptMicrosoftRiskyUsersResponse(source()))
  assert.match(zero, /Availability: AVAILABLE; completeness: COMPLETE/)
  assert.match(zero, /Raw record count: 0; observed active identities: 0; active identities: 0/)
})

test('failed unreadable and loading native responses never certify retained diagnostics', () => {
  for (const flags of [{ assessmentRequestError: true }, { assessmentContractError: true }, { assessmentLoading: true }]) {
    const text = diagnosticText(diagnosticNative(), microsoftView, flags)
    assert.doesNotMatch(text, /UNRECOGNIZED_ERROR_CODE|Count accuracy:|2026-09-27T01:00/)
    assert.match(text, /not confirmed|cannot yet be confirmed/)
  }
})

test('disclosure toggles request-free and tenant/org rerenders remove previous diagnostic values', async () => {
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const saved = new Map(['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, fetch: () => { requests++; throw new Error('Unexpected network') }, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let requests = 0
  let state: Record<string, unknown> = { nativeView: diagnosticNative(), microsoftView, cacheScope: 'org-a', retryAssessment: () => { requests++ }, retryMicrosoft: () => { requests++ } }
  const Section = sectionFor(() => state)
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await React.act(async () => root.render(React.createElement(Section, { tenantId: 'tenant-a' })))
    let details = dom.window.document.querySelector('[data-evidence-details]') as HTMLDetailsElement
    assert.equal(details.open, false)
    await React.act(async () => details.querySelector('summary')!.click())
    assert.equal(details.open, true)
    await React.act(async () => details.querySelector('summary')!.click())
    assert.equal(details.open, false)
    assert.equal(requests, 0)
    state = { ...state, nativeView: null, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(null), cacheScope: 'org-b' }
    await React.act(async () => root.render(React.createElement(Section, { tenantId: 'tenant-b' })))
    details = dom.window.document.querySelector('[data-evidence-details]') as HTMLDetailsElement
    assert.doesNotMatch(details.textContent!, /UNRECOGNIZED_ERROR_CODE|2026-09-27T01:00/)
    assert.match(details.textContent!, /Native diagnostic details: Not available/)
    assert.equal(requests, 0)
    state = { ...state, nativeView: diagnosticNative(), cacheScope: 'org-b' }
    await React.act(async () => root.render(React.createElement(Section, { tenantId: 'tenant-b' })))
    assert.match(dom.window.document.querySelector('[data-evidence-details]').textContent, /UNRECOGNIZED_ERROR_CODE/)
    state = { ...state, nativeView: null, cacheScope: 'org-c', assessmentLoading: true }
    await React.act(async () => root.render(React.createElement(Section, { tenantId: 'tenant-b' })))
    assert.doesNotMatch(dom.window.document.querySelector('[data-evidence-details]').textContent, /UNRECOGNIZED_ERROR_CODE|2026-09-27T01:00/)
    assert.match(dom.window.document.querySelector('[data-evidence-details]').textContent, /Loading evidence/)
    assert.equal(requests, 0)
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Array.from(saved)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]
  }
})


test('diagnostic category rendering separates gaps and safely handles legacy, absent, malformed and future metadata', () => {
  const native = diagnosticNative({ applies: 10, unknown: { UNRECOGNIZED_REASON_NAME: 2, 'private@secret.invalid': 3 },
    unprocessable: { SUBJECT_NOT_IN_DIRECTORY: 4, EVENT_TIMESTAMP_INVALID: 1 }, notYetCited: { EXCLUSION_NOT_YET_CITED: 6 } })
  native.coverage[0].stream = '<private-stream>'
  native.withheld = [{ stream: '<private-stream>', because: 'private-reason' }]
  const text = diagnosticText(native, microsoftView)
  assert.match(text, /Unknown stream/)
  assert.match(text, /Unrecognized reason/)
  assert.match(text, /UNRECOGNIZED_REASON_NAME: 2/)
  assert.match(text, /OTHER: 3/)
  assert.match(text, /SUBJECT_NOT_IN_DIRECTORY: 4/)
  assert.match(text, /EVENT_TIMESTAMP_INVALID: 1/)
  assert.match(text, /Not yet citedEXCLUSION_NOT_YET_CITED: 6/)
  assert.doesNotMatch(text, /private@|private-stream|private-reason/)
  for (const coverage of [{ applies: 1, uninterpretedEvents: 3, notYetCitedEvents: 2 }, { applies: 1, unknown: {}, unprocessable: {} }]) {
    assert.match(diagnosticText(diagnosticNative(coverage), microsoftView), /Category breakdown: Not reported/)
  }
  const invalid = diagnosticText(diagnosticNative({ applies: 1, unknown: { BAD: -1 }, unprocessable: {}, notYetCited: {} }), microsoftView)
  assert.match(invalid, /Unknown interpretationCategory breakdown: Unreadable/)
  assert.match(invalid, /uninterpreted events: Not reported/)
  const zero = diagnosticText(diagnosticNative({ applies: 1, unknown: {}, unprocessable: {}, notYetCited: {} }), microsoftView)
  assert.match(zero, /Unknown interpretation0 events in the reported category map/)
})


test('diagnostic clocks stay UTC and uniquely source-matched; native read failure leaves independent Microsoft evidence', () => {
  const native = diagnosticNative()
  native.run.windowStart = '2026-09-26T20:00:00-04:00'
  native.collectors.unshift({ source: 'M365_AUDIT_STS', status: 'FAILED', lastSuccessfulCollectionAt: '2026-09-20T00:00:00.000Z' })
  let text = diagnosticText(native, microsoftView)
  assert.match(text, /Window start \(UTC\): 2026-09-27T00:00:00.000Z/)
  assert.match(text, /Collector status: SUCCESS/)
  assert.doesNotMatch(text, /2026-09-20T00:00/)
  native.collectors.push({ ...native.collectors[1], status: 'FAILED' })
  text = diagnosticText(native, microsoftView)
  assert.match(text, /Collector status: Not reported or ambiguous/)
  assert.match(text, /Collector last success \(UTC\): Not reported/)
  const ms = adapter.adaptMicrosoftRiskyUsersResponse(source())
  text = diagnosticText(native, ms, { assessmentRequestError: true })
  assert.match(text, /The native read failed/)
  assert.doesNotMatch(text, /Collector status:|UNRECOGNIZED_ERROR_CODE/)
  assert.match(text, /Availability: AVAILABLE; completeness: COMPLETE/)
  assert.match(text, /active identities: 0/)
})


for (const status of ['STALE', 'UNSUPPORTED', 'NOT_LICENSED', 'PERMISSION_REQUIRED', 'NOT_CONFIGURED']) {
  test(`diagnostic disclosure retains current collector status ${status}`, () => {
    const native = diagnosticNative()
    native.collectors[0].status = status
    const text = diagnosticText(native, microsoftView)
    assert.match(text, new RegExp(`Collector status: ${status}`))
    assert.doesNotMatch(text, /Collector status: Unrecognized status/)
    assert.match(text, /Count accuracy: AT_LEAST; count value: 5/)
    assert.doesNotMatch(text.split('Microsoft Identity Protection')[0], /user.*P2|P2.*user/i)
  })
}
for (const because of ['COLLECTION_SCOPE_UNDECLARED', 'NO_CHECK_EXAMINED_EVIDENCE']) {
  test(`diagnostic disclosure retains current withheld reason ${because}`, () => {
    const native = diagnosticNative()
    native.withheld = [{ stream: 'GRAPH_SIGN_INS', because }]
    const text = diagnosticText(native, microsoftView)
    assert.match(text, new RegExp(`Withheld reasons: Graph sign-ins: ${because}`))
    assert.doesNotMatch(text, /Unrecognized reason/)
    assert.match(text, /Count accuracy: AT_LEAST; count value: 5/)
  })
}

// Primary-strip contract: exercise the actual component and real count/channel/list
// projections. Only the transport read, unrelated drawer and primitive UI are mocked.
async function mountedStrip(initial: Record<string, unknown>, check: (ctx: any) => Promise<void> | void) {
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.invalid' })
  const keys = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT']
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let requests = 0
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    fetch: () => { throw new Error('Unexpected transport') }, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  let state = { cacheScope: 'org-a', retryAssessment: () => { requests++ }, retryMicrosoft: () => { requests++ }, ...initial }
  const Section = sectionFor(() => state)
  const root = createRoot(dom.window.document.getElementById('root'))
  const ctx = {
    document: dom.window.document,
    strip: () => dom.window.document.querySelector('[data-risk-summary]'),
    text: () => dom.window.document.querySelector('[data-risk-summary]')?.textContent ?? '',
    requests: () => requests,
    update: async (next: Record<string, unknown>, tenantId = 'tenant-a') => {
      state = { ...state, ...next }
      await React.act(async () => root.render(React.createElement(Section, { tenantId })))
    },
    capture: (name: string) => {
      if (!process.env.HAW6_VISUAL_OUT) return
      require('node:fs').writeFileSync(require('node:path').join(process.env.HAW6_VISUAL_OUT, name + '.html'),
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body class="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"><main class="p-4">' + dom.window.document.getElementById('root').innerHTML + '</main></body></html>')
    },
  }
  try { await ctx.update({}); await check(ctx) }
  finally {
    await React.act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]
  }
}
function withheldStripNative(positive = false) {
  const native: any = positive ? nativePositive() : structuredClone(assessedAndEmpty)
  native.count = { ...native.count, accuracy: 'NOT_AVAILABLE', value: null }
  native.withheld = [{ stream: 'GRAPH_SIGN_INS', because: 'UNINTERPRETED_EVENTS' }]
  return native
}
function stripMicrosoft(count: number | null, partial = false) {
  const dto = source(count === null ? 'SOURCE_UNAVAILABLE' : null, partial)
  if (count !== null) Object.assign(dto.microsoftRiskSummary, {
    rawRecordCount: Math.max(count, 1), observedActiveDistinctUserCount: count,
    activeDistinctUserCount: partial ? null : count,
    snapshotObservedAt: '2026-09-08T20:00:00.000Z', collectionSucceededAt: '2026-09-08T21:00:00.000Z',
  })
  return dto
}
const stripNoise = /Users requiring review:|Not counted|not a complete count|Microsoft risk status unavailable|Evidence time not reported|Assessed |Assessment time:|Not covered by this number/
for (const [label, native] of [['unavailable', null], ['withheld-empty', withheldStripNative()]] as const) {
  test('mounted primary strip omits unsupported facts: ' + label, async () => {
    await mountedStrip({ nativeView: native, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(stripMicrosoft(null)) }, async (ctx) => {
      assert.equal(Boolean(ctx.strip()), false, 'no supported facts means no strip or empty container')
      assert.doesNotMatch(ctx.document.body.textContent, /0 users requiring review|0 active Microsoft risk|No users requiring review found/)
      assert.equal(ctx.document.querySelector('[data-evidence-details]').open, false)
      assert.match(ctx.document.querySelector('[data-evidence-details]').textContent, /HawkView count: Not (available|counted)/)
      assert.equal(ctx.document.querySelectorAll('tbody tr button').length, 0)
      ctx.capture(label)
    })
  })
}
for (const [label, value, accuracy, rows, expected] of [
  ['exact-zero', 0, 'EXACT', 0, /HawkView: 0 users requiring review in this assessment/],
  ['exact-positive', 1, 'EXACT', 1, /HawkView: 1 users requiring review in this assessment/],
  ['exact-partial', 9, 'EXACT', 1, /HawkView: 9 users requiring review in this assessment1 HawkView users shown in this response/],
  ['exact-undelivered', 9, 'EXACT', 0, /HawkView: 9 users requiring review in this assessment0 HawkView users shown in this response/],
  ['lower-bound', 9, 'AT_LEAST', 1, /HawkView: at least 9 users requiring review in this assessment/],
] as const) {
  test('mounted primary strip preserves count semantics: ' + label, async () => {
    const native: any = rows ? nativePositive() : structuredClone(assessedAndEmpty)
    native.count = { ...native.count, value, accuracy }
    native.complete = rows === value
    await mountedStrip({ nativeView: native, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(stripMicrosoft(null)) }, (ctx) => {
      assert.match(ctx.text(), expected)
      assert.doesNotMatch(ctx.text(), stripNoise)
      assert.doesNotMatch(ctx.text(), /healthy|all-clear/i)
      assert.equal(ctx.document.querySelectorAll('tbody tr button').length, rows)
      if (value > 0 && rows === 0) assert.doesNotMatch(ctx.document.body.textContent, /No users requiring review found/)
      ctx.capture(label)
    })
  })
}
test('mounted withheld positives remain scoped to shown users, and non-user known findings survive', async () => {
  const native = withheldStripNative(true)
  await mountedStrip({ nativeView: native, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(stripMicrosoft(null)) }, async (ctx) => {
    assert.match(ctx.text(), /1 HawkView users shown/)
    assert.match(ctx.text(), /What HawkView did find/)
    assert.doesNotMatch(ctx.text(), /1 users requiring review|Not counted|complete total/)
    assert.equal(ctx.document.querySelectorAll('tbody tr button').length, 1)
    const mailbox = structuredClone(native)
    mailbox.findings[0] = { ...mailbox.findings[0], detectorId: 'external-mailbox-forwarding', subject: { ...mailbox.findings[0].subject, kind: 'MAILBOX' }, signals: [{ signal: 'EXTERNAL_FORWARDING_CONFIGURED', count: 3, capped: false, latest: null }] }
    await ctx.update({ nativeView: mailbox })
    assert.match(ctx.text(), /What HawkView did find|forwarding/i)
    assert.doesNotMatch(ctx.text(), /HawkView users shown|0 users requiring review/)
  })
})
for (const [label, value, partial, expected] of [
  ['microsoft-zero', 0, false, /0 active Microsoft risk identities in current evidence/],
  ['microsoft-positive', 7, false, /7 active Microsoft risk identities/],
  ['microsoft-partial-positive', 7, true, /7 identities have active Microsoft-risk evidence requiring review.*Observed identities; partial Microsoft evidence/],
  ['microsoft-partial-empty', 0, true, null],
] as const) {
  test('mounted Microsoft source summary independent of native and page length: ' + label, async () => {
    const dto = stripMicrosoft(value, partial)
    dto.pageInfo = { hasMore: true, nextCursor: 'next.page' }
    dto.users = []
    const ms = adapter.adaptMicrosoftRiskyUsersResponse(dto)
    assert.ok(ms.microsoftRiskSummary, 'fixture must pass the real envelope and summary validators')
    await mountedStrip({ nativeView: null, microsoftView: ms }, (ctx) => {
      if (expected) {
        assert.match(ctx.text(), expected)
        assert.match(ctx.text(), /Microsoft Identity Protection snapshot/)
        assert.doesNotMatch(ctx.text(), /HawkView:|Assessed |Evidence observed|Evidence time not reported/)
      } else assert.equal(Boolean(ctx.strip()), false)
      ctx.capture(label)
    })
  })
}
for (const reason of ['LICENSE_REQUIRED', 'MISSING_PERMISSION']) {
  test('mounted validated customer access action clears on reporting: ' + reason, async () => {
    await mountedStrip({ nativeView: null, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(source(reason)) }, async (ctx) => {
      assert.match(ctx.text(), reason === 'LICENSE_REQUIRED' ? /requires an Entra ID P2 license/ : /Grant IdentityRiskyUser.Read.All permission/)
      assert.doesNotMatch(ctx.text(), stripNoise)
      await ctx.update({ microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(stripMicrosoft(1)) })
      assert.match(ctx.text(), /1 active Microsoft risk identity/)
      assert.doesNotMatch(ctx.text(), /P2 license|Grant .* permission/)
      await ctx.update({ microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(source('SOURCE_UNAVAILABLE')) })
      assert.equal(Boolean(ctx.strip()), false)
    })
  })
}
for (const status of ['UNAVAILABLE', 'ERROR', 'STALE']) {
  test('mounted contradictory/error/stale channel never infers licensing action: ' + status, async () => {
    const dto = source('LICENSE_REQUIRED')
    dto.status = status
    if (status === 'UNAVAILABLE') dto.users = [{ id: 'ms-1', identityLabel: 'Reported user', riskLevel: 'high', riskState: 'atRisk', riskDetail: null, observedAt: dto.observedAt }]
    const ms = adapter.adaptMicrosoftRiskyUsersResponse(dto)
    assert.equal(riskyUsersView.microsoftChannel(ms).addressable, false)
    await mountedStrip({ nativeView: nativePositive(), microsoftView: ms }, (ctx) => {
      assert.match(ctx.text(), /HawkView: 1 users/)
      assert.doesNotMatch(ctx.text(), /license|permission|0 active Microsoft risk|current evidence/i)
      assert.equal(ctx.document.querySelectorAll('tbody tr button').length, 1)
    })
  })
}
for (const timestamp of [null, 'not-a-date', '2099-01-01T00:00:00.000Z']) {
  test('mounted Microsoft invalid/absent/future date never replaced with assessment clock: ' + timestamp, async () => {
    const dto = stripMicrosoft(1)
    dto.microsoftRiskSummary.snapshotObservedAt = timestamp
    const native = nativePositive()
    native.run.completedAt = '2026-09-29T23:00:00.000Z'
    await mountedStrip({ nativeView: native, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(dto) }, (ctx) => {
      assert.match(ctx.text(), /HawkView: 1 users/)
      assert.doesNotMatch(ctx.text(), /snapshot|Assessed|time not reported|2099|Sep 29/)
    })
  })
}
test('mounted recent native run cannot refresh old collector or Microsoft snapshot dates', async () => {
  const native = diagnosticNative()
  const dto = stripMicrosoft(1)
  await mountedStrip({ nativeView: native, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(dto) }, (ctx) => {
    assert.match(ctx.text(), /Microsoft Identity Protection snapshot/)
    assert.doesNotMatch(ctx.text(), /Assessed|Sep 27|data updated|collection.*2026/i)
    assert.match(ctx.document.querySelector('[data-evidence-details]').textContent, /2026-09-27T01:00:00.000Z/)
    ctx.capture('mixed-sources')
  })
})
test('mounted retry/tenant-org switch clears retained facts and actions without transport on evidence toggle', async () => {
  await mountedStrip({ nativeView: nativePositive(), microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(source('MISSING_PERMISSION')) }, async (ctx) => {
    assert.match(ctx.text(), /HawkView: 1 users|Grant IdentityRiskyUser.Read.All/)
    const details = ctx.document.querySelector('[data-evidence-details]')
    await React.act(async () => details.querySelector('summary').click())
    assert.equal(details.open, true); assert.equal(ctx.requests(), 0)
    await ctx.update({ nativeView: null, microsoftView: adapter.adaptMicrosoftRiskyUsersResponse(stripMicrosoft(null)), cacheScope: 'org-b', assessmentRequestError: true }, 'tenant-b')
    assert.equal(Boolean(ctx.strip()), false)
    assert.doesNotMatch(ctx.document.body.textContent, /Synthetic user|Grant IdentityRiskyUser.Read.All|HawkView: 1 users/)
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, /latest assessment could not be loaded/)
    const retry = [...ctx.document.querySelectorAll('button')].find((button: any) => button.textContent.includes('Refresh assessment'))
    assert.ok(retry); await React.act(async () => (retry as any).click()); assert.equal(ctx.requests(), 2)
    await ctx.update({ nativeView: assessedAndEmpty, assessmentRequestError: false })
    assert.match(ctx.text(), /HawkView: 0 users requiring review/)
    assert.equal(ctx.document.querySelector('[role="alert"]'), null)
  })
})
