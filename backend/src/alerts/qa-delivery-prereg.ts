// QA — the delivery checks, written against a reference the implementation need not match.
// Each check must pass the reference, catch the variant it declares, and stay quiet on the rest.
import { PRE_REGISTERED_DELIVERY, type AddressState, type Authentication,
  type FirstRunForecast, type Verifier } from './qa-delivery-contract.js'

type Variant =
  | 'reference' | 'preference-defaults-true' | 'withheld-not-reported' | 'bounce-only-logged'
  | 'soft-bounce-suppresses' | 'verifier-rejects-everything' | 'verifier-throws-on-forged'
  | 'forecast-ignores-watermark' | 'verifier-collapses-missing-and-invalid'

type Decision = Readonly<{ send: boolean; because: string }>
type Bounce = Readonly<{ address: string; kind: 'HARD' | 'SOFT'; atIso: string }>

interface Delivery {
  decide: (prefs: ReadonlyMap<string, boolean>, org: string, addr: AddressState) => Decision
  onBounce: (state: AddressState, bounce: Bounce) => AddressState
  verify: Verifier
  forecast: (observedAtIsos: readonly string[], watermarkIso: string) => FirstRunForecast
}

const build = (v: Variant): Delivery => ({
  // D1 — ABSENCE MEANS OFF. The variant treats a missing row as consent.
  decide: (prefs, org, addr) => {
    const enabled = prefs.get(org) ?? (v === 'preference-defaults-true')
    if (!enabled) return { send: false, because: v === 'withheld-not-reported' ? '' : 'EMAIL_NOT_ENABLED' }
    if (addr.suppressedBecause !== null) {
      return { send: false, because: v === 'withheld-not-reported' ? '' : `SUPPRESSED_${addr.suppressedBecause}` }
    }
    return { send: true, because: 'ELIGIBLE' }
  },
  // D4 — a hard bounce changes the address; a soft one does not.
  onBounce: (state, bounce) => {
    if (v === 'bounce-only-logged') return state
    if (bounce.kind === 'SOFT' && v !== 'soft-bounce-suppresses') return state
    return { ...state, suppressedBecause: bounce.kind === 'HARD' ? 'HARD_BOUNCE' : 'COMPLAINT', suppressedAtIso: bounce.atIso }
  },
  // D6/D7 — a verdict, never an exception, and a genuine signature still verifies.
  verify: (rawBody, headers, secret) => {
    const provided = headers['resend-signature']
    if (provided === undefined || provided === '') return v === 'verifier-collapses-missing-and-invalid' ? 'SIGNATURE_INVALID' : 'SIGNATURE_MISSING'
    if (v === 'verifier-throws-on-forged' && provided !== `sig(${secret}:${rawBody})`) {
      throw new Error('forged')
    }
    // NEVER AUTHENTICATES, which is the defect this variant's name describes. It still
    // classifies a MISSING signature correctly - collapsing those two is a different defect.
    if (v === 'verifier-rejects-everything') return 'SIGNATURE_INVALID'
    return provided === `sig(${secret}:${rawBody})` ? 'AUTHENTIC' : 'SIGNATURE_INVALID'
  },
  // D9 — the forecast counts what WOULD go, from the watermark, sending nothing.
  forecast: (observed, watermarkIso) => {
    const at = Date.parse(watermarkIso)
    const eligible = v === 'forecast-ignores-watermark' ? observed : observed.filter((o) => Date.parse(o) >= at)
    return {
      wouldSend: eligible.length,
      byOrganization: new Map([['org-1', eligible.length]]),
      oldestObservedAtIso: eligible.length === 0 ? null : [...eligible].sort()[0]!,
      watermarkIso,
    }
  },
})

const ADDR: AddressState = { address: 'soc@msp.example', suppressedBecause: null, suppressedAtIso: null }
const ON = new Map([['org-1', true]])
const EMPTY = new Map<string, boolean>()
const SECRET = 's3cret'
const BODY = '{"type":"email.delivered"}'
const genuine = { 'resend-signature': `sig(${SECRET}:${BODY})` }

const CHECKS: Record<string, { catches: Variant; run: (d: Delivery) => boolean }> = {
  // D1 — no row at all must mean no send.
  D1: { catches: 'preference-defaults-true', run: (d) =>
    d.decide(EMPTY, 'org-1', ADDR).send === false && d.decide(ON, 'org-1', ADDR).send === true },

  // D3 — the withheld one carries a REASON, not merely a false. Absence is not a report.
  D3: { catches: 'withheld-not-reported', run: (d) => {
    // A SUPPRESSED ADDRESS IS WITHHELD WHATEVER THE PREFERENCE SAYS, so this isolates the
    // reporting of the reason from the decision to withhold.
    const suppressed = { ...ADDR, suppressedBecause: 'HARD_BOUNCE' as const, suppressedAtIso: '2026-09-12T00:00:00.000Z' }
    const withheld = d.decide(ON, 'org-1', suppressed)
    return withheld.send === false && withheld.because !== '' } },

  // D4 — a hard bounce suppresses and the next send consults it; a soft bounce does not.
  D4: { catches: 'bounce-only-logged', run: (d) => {
    const hard = d.onBounce(ADDR, { address: ADDR.address, kind: 'HARD', atIso: '2026-09-12T00:00:00.000Z' })
    return hard.suppressedBecause === 'HARD_BOUNCE' && d.decide(ON, 'org-1', hard).send === false } },

  D4_soft: { catches: 'soft-bounce-suppresses', run: (d) => {
    const soft = d.onBounce(ADDR, { address: ADDR.address, kind: 'SOFT', atIso: '2026-09-12T00:00:00.000Z' })
    return soft.suppressedBecause === null && d.decide(ON, 'org-1', soft).send === true } },

  // D6 — a forged signature is a VERDICT, not an exception.
  D6: { catches: 'verifier-throws-on-forged', run: (d) => {
    try {
      const forged = d.verify(BODY, { 'resend-signature': 'sig(wrong)' }, SECRET)
      return forged !== 'AUTHENTIC'
    } catch { return false } } },

  // D6b — MISSING AND INVALID ARE DIFFERENT OPERATIONAL FACTS: missing is usually us, invalid
  // is usually somebody else. Collapsing them hides which.
  D6b: { catches: 'verifier-collapses-missing-and-invalid', run: (d) => d.verify(BODY, {}, SECRET) === 'SIGNATURE_MISSING' },

  // D7 — THE POSITIVE CONTROL. `() => 'SIGNATURE_INVALID'` passes every forgery test written.
  D7: { catches: 'verifier-rejects-everything', run: (d) => d.verify(BODY, genuine, SECRET) === 'AUTHENTIC' },

  // D9 — the forecast is computed from the watermark, before anything sends.
  D9: { catches: 'forecast-ignores-watermark', run: (d) => {
    const f = d.forecast(['2026-08-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z'], '2026-09-01T00:00:00.000Z')
    return f.wouldSend === 1 && f.oldestObservedAtIso === '2026-09-10T00:00:00.000Z' } },
}

const VARIANTS: Variant[] = ['preference-defaults-true', 'withheld-not-reported', 'bounce-only-logged',
  'soft-bounce-suppresses', 'verifier-rejects-everything', 'verifier-throws-on-forged',
  'forecast-ignores-watermark', 'verifier-collapses-missing-and-invalid']

const report = Object.entries(CHECKS).map(([name, check]) => {
  const passesReference = check.run(build('reference'))
  const caught = VARIANTS.filter((x) => !check.run(build(x)))
  return { check: name, passesReference, declared: check.catches, catches: caught,
    verdict: passesReference && caught.length === 1 && caught[0] === check.catches ? 'READY' : 'NOT READY' }
})

console.log(JSON.stringify({
  QA_DELIVERY_PREREG: {
    checks: report,
    variantsCaughtByNothing: VARIANTS.filter((x) => Object.values(CHECKS).every((c) => c.run(build(x)))),
    settledOnlyByAPerson: ['D2 send twice one arrives', 'D5 a human opens the inbox',
      'D7 against a REAL Resend signature — the reference proves the check discriminates, not that Resend signs this way'],
    properties: PRE_REGISTERED_DELIVERY,
  },
}, null, 2))
