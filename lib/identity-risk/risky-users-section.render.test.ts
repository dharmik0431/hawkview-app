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
function render(nativeView: unknown, microsoftView: unknown): string {
  const hooks = compile('../api/risky-users-hooks.ts', {
    ...uiMocks,
    './risky-users-assessment-hooks': {
      useNativeRiskyUsersRead: () => ({
        cacheScope: 'probe-session',
        nativeView,
        assessmentLoading: false,
        assessmentRequestError: false,
        assessmentContractError: false,
        microsoftView,
        microsoftLoading: false,
        retryAssessment: () => undefined,
        retryMicrosoft: () => undefined,
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

  const dom = new JSDOM(
    renderToStaticMarkup(
      React.createElement((section as any).default, { tenantId: 'synthetic-tenant' })
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

  assert.match(text, /Users requiring review: Not available/, 'the count still says it cannot tell')

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

  assert.match(text, /0 detected by HawkView/, 'an assessed empty tenant must still show its zero')
  assert.doesNotMatch(text, /Users requiring review: Not available/, 'and must not read as unknown')
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
  assert.match(retained,/Synthetic user/);assert.match(retained,/1 detected by HawkView/);
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
 const html=render(native,ms);assert.match(html,/Cross-source comparison is not established/);assert.match(html,/Synthetic user/);assert.match(html,/1 detected by HawkView/);assert.match(html,/1 active Microsoft risk identity/);assert.doesNotMatch(html,badCopy,'Absent comparison key is not proof a directory match failed');
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
