import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { test } from 'node:test'
import { wrapRiskKey, unwrapRiskKey, wrappedRiskName, WRAPPED_RISK_PROVIDER } from './wrapped-risk-crypto.js'
import type { WrappedRiskCiphertext } from './wrapped-risk-crypto.js'
import type { PseudonymKeyVersion } from './identity-risk-pseudonym.js'

// TEST-ONLY recovery-order model. No process.env, network, DB or filesystem use.
// This is not a production restore/reconciliation implementation or attestation.
type Status = 'ACTIVE' | 'REVOKED' | 'DESTROYED'
type Row = { key: PseudonymKeyVersion; wrapped: WrappedRiskCiphertext; status: Status }
type Ledger = { environment: string; checkpoint: number; entries: { id: string; status: Exclude<Status, 'ACTIVE'> }[] }
const denied = () => new Error('SYNTHETIC_RECOVERY_BLOCKED')
const fingerprint = (root: Buffer) => createHash('sha256').update(root).digest()
const ledgerFingerprint = (ledger: Ledger) => createHash('sha256').update(JSON.stringify(ledger)).digest()

class RecoveryModel {
  private rows: Row[] | undefined
  private reconciled = false
  private validated = false
  private enabled = false
  constructor(private environment: string, private expectedRoot: Buffer, private latestCheckpoint: number,
    private expectedLedger: Buffer) {}
  restore(rows: Row[] | undefined) {
    if (this.rows || this.enabled || !rows?.length || rows.some(r => r.key.environment !== this.environment)) throw denied()
    this.rows = structuredClone(rows)
  }
  reconcile(ledger: Ledger | undefined) {
    if (!this.rows || this.enabled || this.reconciled || !ledger || ledger.environment !== this.environment ||
      !Number.isSafeInteger(ledger.checkpoint) || ledger.checkpoint !== this.latestCheckpoint ||
      new Set(ledger.entries.map(e => e.id)).size !== ledger.entries.length ||
      ledger.entries.some(e => !['REVOKED', 'DESTROYED'].includes(e.status) || !this.rows!.some(r => r.key.id === e.id)) ||
      !timingSafeEqual(ledgerFingerprint(ledger), this.expectedLedger)) throw denied()
    for (const entry of ledger.entries) {
      const row = this.rows.find(r => r.key.id === entry.id)!
      // Never downgrade DESTROYED to REVOKED or erase a tombstone on replay.
      if (row.status !== 'DESTROYED') row.status = entry.status
    }
    this.reconciled = true
  }
  validate(root: Buffer | undefined) {
    this.validated = false
    if (!this.rows || !this.reconciled || this.enabled || !root || root.length !== 32 ||
      !timingSafeEqual(fingerprint(root), this.expectedRoot)) throw denied()
    for (const row of this.rows) if (row.status === 'ACTIVE') {
      const plaintext = unwrapRiskKey(row.key, row.wrapped, root)
      plaintext.fill(0)
    }
    this.validated = true
  }
  resume() {
    if (!this.rows || !this.reconciled || !this.validated) throw denied()
    this.enabled = true
  }
  read(id: string, root: Buffer) {
    const row = this.rows?.find(r => r.key.id === id)
    if (!this.enabled || !row || row.status !== 'ACTIVE') throw denied()
    return unwrapRiskKey(row.key, row.wrapped, root)
  }
  states() { return this.rows?.map(r => r.status) }
  close() { this.rows = undefined; this.enabled = false; this.expectedRoot.fill(0); this.expectedLedger.fill(0) }
}

function fixture(environment = 'drill-production') {
  const root = randomBytes(32)
  const secrets = [randomBytes(32), randomBytes(32), randomBytes(32)]
  const organizationId = randomUUID(), customerTenantId = randomUUID()
  const rows: Row[] = secrets.map(secret => {
    const base: PseudonymKeyVersion = { id: randomUUID(), organizationId, customerTenantId,
      environment, provider: WRAPPED_RISK_PROVIDER, immutableKeyId: '' }
    const key: PseudonymKeyVersion = { ...base, immutableKeyId: wrappedRiskName(base) }
    return { key, wrapped: wrapRiskKey(key, secret, root), status: 'ACTIVE' }
  })
  // This independent latest inventory is newer than the restored ACTIVE snapshot.
  const ledger: Ledger = { environment, checkpoint: 2, entries: [
    { id: rows[1].key.id, status: 'REVOKED' }, { id: rows[2].key.id, status: 'DESTROYED' },
  ] }
  // Models a trusted independently preserved inventory, not a hash supplied by
  // the restored DB. Real authenticity/custody remains an operator prerequisite.
  const model = new RecoveryModel(environment, fingerprint(root), 2, ledgerFingerprint(ledger))
  return { root, secrets, rows, ledger, model, close() { model.close(); root.fill(0); secrets.forEach(s => s.fill(0)) } }
}

test('synthetic recovery: original root plus snapshot and latest ledger recover only active key', () => {
  const f = fixture()
  try {
    f.model.restore(f.rows); f.model.reconcile(f.ledger); f.model.validate(f.root); f.model.resume()
    const recovered = f.model.read(f.rows[0].key.id, f.root)
    try { assert.ok(timingSafeEqual(recovered, f.secrets[0])) } finally { recovered.fill(0) }
    assert.deepEqual(f.model.states(), ['ACTIVE', 'REVOKED', 'DESTROYED'])
  } finally { f.close() }
})

test('synthetic recovery: old ACTIVE snapshot cannot resurrect revoked or destroyed history', () => {
  const f = fixture()
  try {
    assert.ok(f.rows.every(r => r.status === 'ACTIVE'))
    f.model.restore(f.rows); f.model.reconcile(f.ledger); f.model.validate(f.root); f.model.resume()
    for (const row of f.rows.slice(1)) assert.throws(() => f.model.read(row.key.id, f.root), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.deepEqual(f.model.states(), ['ACTIVE', 'REVOKED', 'DESTROYED'])
    assert.throws(() => f.model.restore(f.rows), /SYNTHETIC_RECOVERY_BLOCKED/)
  } finally { f.close() }
})

test('synthetic recovery: resume and decrypt blocked before restore reconciliation and validation', () => {
  const f = fixture()
  try {
    assert.throws(() => f.model.resume(), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.throws(() => f.model.reconcile(f.ledger), /SYNTHETIC_RECOVERY_BLOCKED/)
    f.model.restore(f.rows)
    assert.throws(() => f.model.validate(f.root), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.throws(() => f.model.resume(), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.throws(() => f.model.read(f.rows[0].key.id, f.root), /SYNTHETIC_RECOVERY_BLOCKED/)
    f.model.reconcile(f.ledger)
    assert.throws(() => f.model.resume(), /SYNTHETIC_RECOVERY_BLOCKED/)
  } finally { f.close() }
})

test('synthetic recovery: key backup without database snapshot is insufficient', () => {
  const f = fixture()
  try { assert.throws(() => f.model.restore(undefined), /SYNTHETIC_RECOVERY_BLOCKED/); assert.throws(() => f.model.validate(f.root), /SYNTHETIC_RECOVERY_BLOCKED/) }
  finally { f.close() }
})

for (const missing of [true, false]) test(`synthetic recovery: ${missing ? 'missing' : 'replacement'} root fails closed without replacement`, () => {
  const f = fixture(), wrong = randomBytes(32)
  try {
    f.model.restore(f.rows); f.model.reconcile(f.ledger)
    assert.throws(() => f.model.validate(missing ? undefined : wrong), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.throws(() => f.model.resume(), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.throws(() => unwrapRiskKey(f.rows[0].key, f.rows[0].wrapped, wrong), /IDENTITY_RISK_KEY_UNAVAILABLE/)
    assert.ok(!timingSafeEqual(wrong, f.root))
  } finally { wrong.fill(0); f.close() }
})

test('synthetic recovery: explicit production-like and development namespaces stay separate', () => {
  const f = fixture(), dev = fixture('drill-development')
  try {
    assert.throws(() => dev.model.restore(f.rows), /SYNTHETIC_RECOVERY_BLOCKED/)
    f.model.restore(f.rows)
    assert.throws(() => f.model.reconcile(dev.ledger), /SYNTHETIC_RECOVERY_BLOCKED/)
    f.model.reconcile(f.ledger)
    assert.throws(() => f.model.validate(dev.root), /SYNTHETIC_RECOVERY_BLOCKED/)
    const foreignKey = { ...f.rows[0].key, environment: 'drill-development' }
    foreignKey.immutableKeyId = wrappedRiskName(foreignKey)
    assert.throws(() => unwrapRiskKey(foreignKey, f.rows[0].wrapped, f.root), /IDENTITY_RISK_KEY_UNAVAILABLE/)
  } finally { f.close(); dev.close() }
})

test('synthetic recovery: missing stale or ambiguous independent inventory blocks resume', () => {
  const f = fixture()
  try {
    f.model.restore(f.rows)
    for (const ledger of [undefined, { ...f.ledger, checkpoint: 1 }, { ...f.ledger, checkpoint: NaN },
      { ...f.ledger, entries: [f.ledger.entries[0], f.ledger.entries[0]] },
      { ...f.ledger, entries: [] },
      { ...f.ledger, entries: [{ id: randomUUID(), status: 'DESTROYED' as const }] }]) {
      assert.throws(() => f.model.reconcile(ledger), /SYNTHETIC_RECOVERY_BLOCKED/)
      assert.throws(() => f.model.resume(), /SYNTHETIC_RECOVERY_BLOCKED/)
    }
  } finally { f.close() }
})

test('synthetic recovery: replay never downgrades existing destroyed tombstone', () => {
  const f = fixture()
  try {
    f.rows[1].status = 'DESTROYED'
    f.model.restore(f.rows); f.model.reconcile(f.ledger); f.model.validate(f.root); f.model.resume()
    assert.deepEqual(f.model.states(), ['ACTIVE', 'DESTROYED', 'DESTROYED'])
    assert.throws(() => f.model.read(f.rows[1].key.id, f.root), /SYNTHETIC_RECOVERY_BLOCKED/)
  } finally { f.close() }
})

for (const kind of ['missing', 'corrupt'] as const) test(`synthetic recovery: ${kind} ciphertext never triggers regeneration`, () => {
  const f = fixture()
  try {
    f.rows[0].wrapped.ciphertext = kind === 'missing' ? new Uint8Array(0) : Uint8Array.from(f.rows[0].wrapped.ciphertext, byte => byte ^ 1)
    f.model.restore(f.rows); f.model.reconcile(f.ledger)
    assert.throws(() => f.model.validate(f.root), /IDENTITY_RISK_KEY_UNAVAILABLE/)
    assert.throws(() => f.model.resume(), /SYNTHETIC_RECOVERY_BLOCKED/)
    assert.deepEqual(f.model.states(), ['ACTIVE', 'REVOKED', 'DESTROYED'])
  } finally { f.close() }
})
